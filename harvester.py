"""关联采集器：按引用扩展任务，合并同对象同版本请求，保留全部引用边。

行为规则：
- 任务 = (type, id, version)。同一任务在一次运行中只抓取一次（合并请求），
  但每条引用边都独立入库（保留不同引用边）。
- 循环引用：已入队/已抓取的任务不会再次扩展，天然终止，不会无限展开。
- 缺失对象（404/410）：不重试，作为未解析引用写入 gaps，边仍然保留。
- 版本不符：清单/引用指定 v1 而服务端返回 v2 时，payload 不入库、不展开，
  记 version_mismatch 缺口 —— 两个版本绝不混用。
- 失败重试：5xx/网络错误按 max_retries 重试；最终失败只给该分支记缺口，
  队列里其他无关分支照常入库。
- 运行状态：存在任何缺口或失败 => 'partial'，否则 'complete'。
"""
from collections import deque

from client import Ref


class Harvester:
    def __init__(self, client, db, max_retries=2):
        self.client = client
        self.db = db
        self.max_retries = max_retries

    def harvest(self, roots):
        run_id = self.db.start_run()
        stats = {"fetched": 0, "gaps": 0, "edges": 0}
        queue = deque()
        enqueued = set()  # 合并同一对象同一版本的请求；同时是循环保护
        for ref in roots:
            self.db.add_root(run_id, ref)
            key = (ref.type, ref.id, ref.version)
            if key not in enqueued:
                enqueued.add(key)
                queue.append(ref)

        while queue:
            task = queue.popleft()
            result = self._fetch_with_retry(run_id, task)

            if result.ok:
                if result.returned_version != task.version:
                    # 版本不符：不存 payload、不展开引用，记缺口
                    self.db.add_gap(
                        run_id, None, task, "version_mismatch",
                        f"requested v{task.version}, server returned "
                        f"v{result.returned_version}")
                    stats["gaps"] += 1
                    continue
                self.db.put_object(task, result.payload, run_id)
                stats["fetched"] += 1
                for child in result.refs:
                    role = self._role_of(result.payload, child)
                    self.db.add_edge(task, child, role)
                    stats["edges"] += 1
                    key = (child.type, child.id, child.version)
                    if key not in enqueued:
                        enqueued.add(key)
                        queue.append(child)
            elif result.status == 404:
                self.db.add_gap(run_id, None, task, "not_found", result.error)
                stats["gaps"] += 1
            elif result.status == 410:
                self.db.add_gap(run_id, None, task, "deleted", result.error)
                stats["gaps"] += 1
            else:
                # 重试后仍失败：只影响该分支
                self.db.add_gap(run_id, None, task, "fetch_failed", result.error)
                stats["gaps"] += 1

        status = "complete" if stats["gaps"] == 0 else "partial"
        self.db.finish_run(run_id, status, stats)
        return run_id, status, stats

    def _fetch_with_retry(self, run_id, ref):
        attempts = self.max_retries + 1
        result = None
        for attempt in range(1, attempts + 1):
            result = self.client.get_object(ref)
            self.db.log_fetch(run_id, ref, attempt, status=result.status,
                              error=result.error)
            # 4xx 是确定性结果，不重试；5xx/网络错误可重试
            if result.ok or (result.status is not None and result.status < 500):
                break
        return result

    @staticmethod
    def _role_of(payload, child):
        # payload 里 refs_meta 可携带每条引用的角色；缺省用目标类型
        for meta in payload.get("refs_meta", []):
            if (meta["type"], meta["id"], meta["version"]) == \
                    (child.type, child.id, child.version):
                return meta.get("role", child.type)
        return child.type

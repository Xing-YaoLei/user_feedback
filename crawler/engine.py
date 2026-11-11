"""爬虫编排引擎：逐层发现有效组合、一致性采集、断点续跑。"""
from __future__ import annotations

import signal
import time
from collections.abc import Callable

from crawler.browser import (
    BrowserSession,
    PageQueryError,
    StaleOrLoadingError,
    compute_backoff_seconds,
)
from crawler.models import CrawlState, combo_key


class PauseRequested(Exception):
    """内部信号：收到暂停请求，当前组合结束后停止。"""


class Crawler:
    def __init__(self, base_url: str, state_dir: str,
                 max_attempts: int = 4, headless: bool = True,
                 max_branches: int | None = None,
                 settle_timeout_ms: int = 15000) -> None:
        self.base_url = base_url
        self.state_dir = state_dir
        self.max_attempts = max_attempts
        self.headless = headless
        self.max_branches = max_branches
        self.settle_timeout_ms = settle_timeout_ms
        self.state: CrawlState | None = None
        self._pause_requested = False
        self._branches_visited_in_run = 0

    # -- 暂停支持：SIGINT 优雅暂停，第二次直接退出 -------------------------
    def _install_signal_handlers(self) -> None:
        def handler(signum, frame):  # noqa: ANN001
            if self._pause_requested:
                raise KeyboardInterrupt
            self._pause_requested = True
            if self.state:
                self.state.log_event("pause_requested",
                                     note="当前组合结束后暂停，进度已落盘")

        signal.signal(signal.SIGINT, handler)
        try:
            signal.signal(signal.SIGTERM, handler)
        except (ValueError, AttributeError):  # pragma: no cover - 非主线程
            pass

    def _check_pause(self) -> None:
        if self._pause_requested:
            raise PauseRequested()

    # -- 主流程 -----------------------------------------------------------
    def run(self, progress: Callable[[str], None] | None = None) -> CrawlState:
        def say(msg: str) -> None:
            if progress:
                progress(msg)

        resumed = CrawlState.load(self.state_dir)
        if resumed is not None and resumed.base_url == self.base_url:
            self.state = resumed
            say(f"恢复已有进度：已完成 {self.state.finished_combo_count()} 个组合")
            self.state.log_event("resume", base_url=self.base_url)
        else:
            self.state = CrawlState(self.base_url, self.state_dir)
            self.state.log_event("start", base_url=self.base_url)

        self._install_signal_handlers()
        try:
            with BrowserSession(
                self.base_url,
                headless=self.headless,
                settle_timeout_ms=self.settle_timeout_ms,
            ) as session:
                self._crawl_all(session, say)
            if self._pause_requested:
                self.state.status = "paused"
            else:
                self.state.status = "done"
        except PauseRequested:
            self.state.status = "paused"
        except Exception:
            self.state.status = "failed"
            self.state.save()
            raise
        self.state.save()
        self.state.log_event(
            self.state.status,
            finished=self.state.finished_combo_count(),
            devices=len(self.state.devices),
        )
        return self.state

    def _crawl_all(self, session: BrowserSession, say) -> None:
        regions = session.read_options("region")
        for region_id, region_label in regions:
            self._check_pause()
            session.select_region(region_id)
            institutions = session.read_options("institution")
            self.state.log_event(
                "discover", level="region", id=region_id, label=region_label,
                children=[iid for iid, _ in institutions],
            )
            for inst_id, inst_label in institutions:
                self._check_pause()
                session.select_institution(inst_id)
                types = session.read_options("type")
                self.state.log_event(
                    "discover", level="institution", region=region_id,
                    id=inst_id, label=inst_label,
                    children=[tid for tid, _ in types],
                )
                for type_id, type_label in types:
                    self._check_pause()
                    key = combo_key(region_id, inst_id, type_id)
                    combo = self.state.ensure_combo(key)
                    if combo.is_finished():
                        say(f"跳过已完成组合 {key}（{combo.status}）")
                        continue
                    if self.max_branches is not None and \
                            self._branches_visited_in_run >= self.max_branches:
                        self.state.log_event(
                            "branch_limit", limit=self.max_branches)
                        self._pause_requested = True
                        self.state.log_event(
                            "pause_requested",
                            note=f"已达本次 {self.max_branches} 个组合上限，"
                                 "当前组合结束后暂停")
                        raise PauseRequested()
                    self._branches_visited_in_run += 1
                    session.select_type(type_id)
                    self._process_combo(session, key, region_id, inst_id,
                                        type_id, say)
                    # 每个组合结束立即落盘，崩溃/暂停不丢进度
                    self.state.save()

    def _process_combo(self, session: BrowserSession, key: str,
                       region_id: str, inst_id: str, type_id: str, say) -> None:
        combo = self.state.ensure_combo(key)
        while combo.attempts < self.max_attempts:
            self._check_pause()
            combo.attempts += 1
            try:
                page_devices = session.query_and_collect(
                    region_id, inst_id, type_id)
            except (PageQueryError, StaleOrLoadingError) as exc:
                # 刷新失败 / 旧内容未收敛：记录并退避重试，绝不标记 empty
                combo.last_error = str(exc)
                self.state.log_event(
                    "retry", combo=key, attempt=combo.attempts,
                    max_attempts=self.max_attempts, error=str(exc),
                )
                say(f"组合 {key} 第 {combo.attempts} 次尝试失败：{exc}")
                if combo.attempts >= self.max_attempts:
                    break
                time.sleep(compute_backoff_seconds(combo.attempts))
                continue

            # 成功收敛：空结果与有数据分别标记，空分支是“确认过的空”
            combo.last_error = None
            if not page_devices:
                combo.status = "empty"
                combo.device_ids = []
                self.state.log_event("empty_branch", combo=key,
                                     attempts=combo.attempts)
                say(f"组合 {key} 确认为空分支（{combo.attempts} 次尝试）")
                return

            ids = []
            for pd in page_devices:
                raw = {"id": pd.id, "name": pd.name, "model": pd.model,
                       "manufacturer": pd.manufacturer}
                dev = self.state.upsert_device(raw, key)
                ids.append(dev.id)
            combo.device_ids = ids
            combo.status = "done"
            self.state.log_event(
                "captured", combo=key, attempts=combo.attempts,
                device_ids=ids,
            )
            say(f"组合 {key} 采集 {len(ids)} 台设备（第 {combo.attempts} 次尝试成功）")
            return

        # 重试预算耗尽：保留 failed，不剪枝 —— 下次续跑仍会重试
        combo.status = "failed"
        self.state.log_event(
            "branch_failed", combo=key, attempts=combo.attempts,
            error=combo.last_error,
        )
        say(f"组合 {key} 重试耗尽，标记 failed（不剪枝，续跑可继续）")

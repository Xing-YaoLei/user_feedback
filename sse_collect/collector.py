"""SSE 采集器。

行为要点:
- 每次连接前从数据库读取游标,以 Last-Event-ID 续传;
- 每条事件在**单个事务**里完成 原始报文+结构化记录+游标推进,
  事务提交成功后才更新内存状态 —— 已确认的事件不会因崩溃丢失;
- 对端返回 410(保留期耗尽)或检测到序号跳变时,记录缺口并把游标标记为
  非连续(contiguous=0);默认策略 stop 直接停止,绝不跳到最新位置还声称连续;
- 对端返回 204 表示没有更多数据,采集器正常结束;
- crash_before_commit_at / crash_after_commit_at 是崩溃注入开关(提交计数),
  用于演练与测试"落库前/后崩溃"的恢复行为。
"""
from __future__ import annotations

import codecs
import threading
import urllib.error
import urllib.request

from .sse_parser import SSEMessage, SSEParser
from .store import Store


class InjectedCrash(Exception):
    """崩溃注入:模拟进程在提交前/后突然死亡。"""


def _raise_crash(where: str):
    def hook():
        raise InjectedCrash(where)

    return hook


class Collector:
    def __init__(
        self,
        store: Store,
        url: str,
        source: str = "default",
        *,
        reconnect_ms: int = 1000,
        gap_policy: str = "stop",  # stop | jump(jump 也会保持 contiguous=0)
        sequence_check: bool = True,  # 数字 id 序号检查;源含无 id 事件时应关闭
        crash_before_commit_at: int | None = None,
        crash_after_commit_at: int | None = None,
    ) -> None:
        self.store = store
        self.url = url
        self.source = source
        self.reconnect_ms = reconnect_ms
        self.gap_policy = gap_policy
        self.sequence_check = sequence_check
        self.crash_before_commit_at = crash_before_commit_at
        self.crash_after_commit_at = crash_after_commit_at

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._resp = None
        self._commits = 0
        self._last_numeric: int | None = None
        self._check_sequence = True

        # 对外可观测状态
        self.error: str | None = None
        self.completed = False       # 对端 204 或缺口 stop 策略导致的正常终止
        self.connected = False
        self.last_committed_id: str | None = None

    # ------------------------------------------------------------ 生命周期

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run, name=f"collector-{self.source}", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        resp = self._resp
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
        if self._thread is not None:
            self._thread.join(timeout)

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ------------------------------------------------------------ 主循环

    def _run(self) -> None:
        try:
            while not self._stop.is_set() and not self.completed:
                try:
                    self._connect_once()
                except InjectedCrash:
                    raise  # 注入崩溃:线程直接死亡,模拟进程被杀
                except Exception as exc:  # 网络错误等:等待后重连
                    self.error = repr(exc)
                if not self.completed and not self._stop.is_set():
                    self._stop.wait(self.reconnect_ms / 1000)
        except InjectedCrash as exc:
            self.error = f"injected crash: {exc}"
        finally:
            self.connected = False

    def _connect_once(self) -> None:
        cur = self.store.get_cursor(self.source)
        headers = {}
        if cur and cur[0] is not None:
            headers["Last-Event-ID"] = cur[0]
        # 序号连续性检查只在上游声称连续时有意义;首次采集默认按连续对待
        self._check_sequence = self.sequence_check if cur is None else (
            self.sequence_check and bool(cur[1])
        )
        self._last_numeric = None
        if self._check_sequence and cur and cur[0] is not None:
            try:
                self._last_numeric = int(cur[0])
            except ValueError:
                self._check_sequence = False

        req = urllib.request.Request(self.url, headers=headers)
        try:
            resp = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            try:
                if e.code == 410:
                    self._on_retention_exhausted(cur)
                    return
                if e.code == 204:
                    self.completed = True
                    return
                raise
            finally:
                e.close()
        if resp.status == 204:
            resp.close()
            self.completed = True
            return

        self.connected = True
        self.error = None
        parser = SSEParser()
        decoder = codecs.getincrementaldecoder("utf-8")()
        read_chunk = getattr(resp, "read1", None) or (lambda n: resp.read(n))
        self._resp = resp
        try:
            while not self._stop.is_set() and not self.completed:
                chunk = read_chunk(65536)
                if not chunk:
                    break  # 对端关闭(可能是截断):残余半个事件随 parser.close() 丢弃
                msgs = parser.feed(decoder.decode(chunk))
                if parser.reconnect_ms:
                    self.reconnect_ms = parser.reconnect_ms
                for msg in msgs:
                    self._handle(msg)
        finally:
            self._resp = None
            try:
                resp.close()
            except Exception:
                pass
        parser.close()

    # ------------------------------------------------------------ 事件处理

    def _handle(self, msg: SSEMessage) -> None:
        if msg.kind == "heartbeat":
            self.store.commit_event(self.source, msg)  # 心跳只留原始记录,不动游标
            return

        n = self._commits + 1
        before = _raise_crash("before-commit") if self.crash_before_commit_at == n else None
        after = _raise_crash("after-commit") if self.crash_after_commit_at == n else None
        inserted = self.store.commit_event(
            self.source, msg, before_commit=before, after_commit=after
        )
        self._commits += 1

        if msg.event_id is None:
            return  # 无 id 事件不参与游标与序号检查(去重边界见 README)
        if inserted:
            self.last_committed_id = msg.event_id
            self._check_seq(msg.event_id)

    def _check_seq(self, event_id: str) -> None:
        """数字 id 的序号连续性检查;发现跳变即记录缺口,绝不假装连续。"""
        if not self._check_sequence:
            return
        try:
            new = int(event_id)
        except ValueError:
            self._check_sequence = False
            return
        if self._last_numeric is not None and new != self._last_numeric + 1:
            self.store.record_gap(
                self.source, str(self._last_numeric), event_id, "sequence_gap"
            )
            self._check_sequence = False
            if self.gap_policy == "stop":
                self.completed = True
        self._last_numeric = new

    def _on_retention_exhausted(self, cur) -> None:
        """410:请求的历史已被保留期淘汰,中间事件不可补齐。"""
        self.store.record_gap(
            self.source, cur[0] if cur else None, None, "retention_exhausted"
        )
        if self.gap_policy == "jump":
            # 明确放弃续传位置从头重拉;contiguous 保持 0,不声称连续
            self.store.clear_cursor_position(self.source)
        else:
            self.completed = True  # stop:停在原地,等待人工介入

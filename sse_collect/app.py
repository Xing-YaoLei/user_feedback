"""一体化启动入口:测试源 + 采集器 + 控制台。

示例:
  python3 -m sse_collect.app --db demo.db \
      --history 30 --live 100000 --interval-ms 200 --heartbeat-ms 3000 \
      --dups 1 --idless-every 7 --multiline-every 3 --chunk-bytes 8

然后打开控制台(默认 http://127.0.0.1:8902/)。

崩溃注入演练(在第 50 次提交后"杀死"采集线程,随后用控制页重启):
  python3 -m sse_collect.app --db demo.db --crash-after-commit 50 ...
"""
from __future__ import annotations

import argparse
import threading

from .collector import Collector
from .control import ControlServer
from .source import Scenario, SourceServer
from .store import Store


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="sse_collect.app",
        description="SSE 事件采集服务 + 本地可控测试源",
    )
    p.add_argument("--db", default="sse_events.db", help="SQLite 数据库路径")
    p.add_argument("--source-name", default="default", help="逻辑源名(游标/去重的命名空间)")
    p.add_argument("--url", default=None,
                   help="外部 SSE 源地址;不给则在 --source-port 启动内置测试源")
    p.add_argument("--source-port", type=int, default=8901)
    p.add_argument("--control-port", type=int, default=8902)
    p.add_argument("--gap-policy", choices=["stop", "jump"], default="stop",
                   help="发现不可补齐缺口时的策略;jump 也会保持 contiguous=0")
    p.add_argument("--no-sequence-check", action="store_true",
                   help="关闭数字 id 序号检查(源混发无 id 事件时使用)")
    p.add_argument("--manual", action="store_true", help="不自动启动采集器,用控制页手动启动")
    # 崩溃注入
    p.add_argument("--crash-before-commit", type=int, default=None, metavar="N",
                   help="在第 N 次提交前模拟进程崩溃")
    p.add_argument("--crash-after-commit", type=int, default=None, metavar="N",
                   help="在第 N 次提交后模拟进程崩溃")
    # 测试源场景
    p.add_argument("--history", type=int, default=20)
    p.add_argument("--retention-from", type=int, default=1)
    p.add_argument("--live", type=int, default=0)
    p.add_argument("--interval-ms", type=int, default=50)
    p.add_argument("--heartbeat-ms", type=int, default=0)
    p.add_argument("--dups", type=int, default=0)
    p.add_argument("--truncate-at", type=int, default=None)
    p.add_argument("--skip", type=int, default=None)
    p.add_argument("--idless-every", type=int, default=0)
    p.add_argument("--multiline-every", type=int, default=0)
    p.add_argument("--retry-ms", type=int, default=None)
    p.add_argument("--chunk-bytes", type=int, default=0)
    return p


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    store = Store(args.db)

    if args.url:
        url = args.url
        print(f"[app] 使用外部 SSE 源: {url}")
    else:
        scenario = Scenario(
            history=args.history,
            retention_from=args.retention_from,
            live=args.live,
            interval_ms=args.interval_ms,
            heartbeat_ms=args.heartbeat_ms,
            dups=args.dups,
            truncate_at=args.truncate_at,
            skip=args.skip,
            idless_every=args.idless_every,
            multiline_every=args.multiline_every,
            retry_ms=args.retry_ms,
            chunk_bytes=args.chunk_bytes,
        )
        source = SourceServer(scenario, ("127.0.0.1", args.source_port))
        source.start_background()
        url = source.url
        print(f"[app] 内置测试源: {url}  (场景: {scenario})")

    def collector_factory() -> Collector:
        return Collector(
            store, url, args.source_name,
            gap_policy=args.gap_policy,
            sequence_check=not args.no_sequence_check,
            crash_before_commit_at=args.crash_before_commit,
            crash_after_commit_at=args.crash_after_commit,
        )

    control = ControlServer(
        ("127.0.0.1", args.control_port), store, args.source_name, collector_factory
    )
    control.start_background()
    print(f"[app] 控制台: {control.url}")
    if not args.manual:
        control.start_collector()
        print("[app] 采集器已启动(--manual 可改为控制页手动启动)")

    stop = threading.Event()
    try:
        while not stop.wait(3600):
            pass
    except KeyboardInterrupt:
        print("\n[app] 退出中…")
    finally:
        control.stop_collector()
        store.close()


if __name__ == "__main__":
    main()

"""命令行入口。

用法：
  python -m crawler.cli --url http://127.0.0.1:8765 --state-dir out/run1
  python -m crawler.cli --url ... --state-dir out/run1   # 再次运行即断点续跑
  python -m crawler.cli --url ... --state-dir out/run1 --max-branches 3
  python -m crawler.cli --url ... --state-dir out/run1 --headed

运行中按 Ctrl-C：当前组合处理完后优雅暂停（再按一次立即退出）。
"""
from __future__ import annotations

import argparse
import json
import sys

from crawler.engine import Crawler


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="多级筛选设备目录爬虫")
    parser.add_argument("--url", required=True, help="目标站点根地址")
    parser.add_argument("--state-dir", required=True, help="状态/输出目录")
    parser.add_argument("--max-attempts", type=int, default=4,
                        help="每个组合的最大尝试次数（默认 4）")
    parser.add_argument("--max-branches", type=int, default=None,
                        help="本次运行最多处理多少个未完成组合（便于分批暂停）")
    parser.add_argument("--settle-timeout-ms", type=int, default=15000)
    parser.add_argument("--headed", action="store_true", help="显示浏览器窗口")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    crawler = Crawler(
        base_url=args.url.rstrip("/"),
        state_dir=args.state_dir,
        max_attempts=args.max_attempts,
        headless=not args.headed,
        max_branches=args.max_branches,
        settle_timeout_ms=args.settle_timeout_ms,
    )
    state = crawler.run(progress=lambda msg: print(f"[crawler] {msg}"))
    summary = {
        "status": state.status,
        "combos_total": len(state.combos),
        "combos_done": sum(1 for c in state.combos.values() if c.status == "done"),
        "combos_empty": sum(1 for c in state.combos.values() if c.status == "empty"),
        "combos_failed": sum(1 for c in state.combos.values() if c.status == "failed"),
        "combos_pending": sum(1 for c in state.combos.values() if c.status == "pending"),
        "unique_devices": len(state.devices),
        "state_dir": str(state.state_dir),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if state.status in ("done", "paused") else 1


if __name__ == "__main__":
    sys.exit(main())

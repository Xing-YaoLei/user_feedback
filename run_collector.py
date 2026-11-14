#!/usr/bin/env python3
"""采集器命令行入口，支持隔离模式运行：python3 -I run_collector.py ..."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from collector.collector import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())

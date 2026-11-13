#!/usr/bin/env python3
"""隔离模式启动器：python3 -I run_diff.py compare -r rules.json -o diff_out/

站点副本是不可信数据，必须用 -I 运行，避免副本目录里的同名模块
（如 json.py）被 import 加载。本脚本只把自身所在的可信代码目录
加入 sys.path，站点路径一律通过规则文件参数传入。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpcenter_diff.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())

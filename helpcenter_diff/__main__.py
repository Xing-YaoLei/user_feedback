"""python -m helpcenter_diff 入口。

注意：隔离模式 `python3 -I -m helpcenter_diff` 不会把当前目录加入 sys.path，
可能找不到本包。推荐直接用项目根目录的启动器：

    python3 -I run_diff.py compare -r rules.json -o diff_out/
"""

import sys
from pathlib import Path

# 允许在未安装为包的情况下，从源码树以 -m 方式运行
_PARENT = Path(__file__).resolve().parent.parent
if str(_PARENT) not in sys.path:
    sys.path.insert(0, str(_PARENT))

from helpcenter_diff.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())

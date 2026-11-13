"""用运行模块的方式调用 CLI：python -m metriccalc"""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())

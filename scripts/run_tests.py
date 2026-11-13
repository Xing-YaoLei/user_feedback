"""一键运行测试：compile + unittest。"""

import os
import py_compile
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FILES = [
    "metriccalc/config.py",
    "metriccalc/store.py",
    "metriccalc/planner.py",
    "metriccalc/cli.py",
    "metriccalc/__init__.py",
    "metriccalc/__main__.py",
    "tests/test_metriccalc.py",
]


def main(argv):
    for rel in FILES:
        py_compile.compile(os.path.join(ROOT, rel), doraise=True)
    print("compile ok")
    loader = unittest.TestLoader()
    suite = loader.discover(
        start_dir=os.path.join(ROOT, "tests"),
        top_level_dir=ROOT,
    )
    verbosity = 2 if "-v" in argv else 1
    runner = unittest.TextTestRunner(verbosity=verbosity)
    return 0 if runner.run(suite).wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

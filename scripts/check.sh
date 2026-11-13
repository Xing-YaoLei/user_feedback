#!/bin/sh
# 运行测试与冒烟检查（供本地/CI 使用）
set -e
cd "$(dirname "$0")/.."
python3 -m py_compile metriccalc/*.py tests/*.py
python3 -m unittest discover -s tests "$@"

#!/usr/bin/env bash
# 启动本地样站：http://127.0.0.1:8000/list/page1.html
set -euo pipefail
cd "$(dirname "$0")/sample_site"
PORT="${1:-8000}"
echo "样站已启动: http://127.0.0.1:${PORT}/list/page1.html"
exec python3 -m http.server "${PORT}"

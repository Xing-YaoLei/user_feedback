#!/usr/bin/env bash
# Exercise the demo server with curl. Run from the project root.
set -euo pipefail
cd "$(dirname "$0")/.."

node src/cli.ts > .demo-out.txt 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -f .demo-out.txt /tmp/demo-body.bin' EXIT

for _ in $(seq 1 50); do
  if grep -q '127\.0\.0\.1:[0-9]*' .demo-out.txt 2>/dev/null; then break; fi
  sleep 0.1
done

PORT=$(grep -o '127\.0\.0\.1:[0-9]*' .demo-out.txt | head -1 | cut -d: -f2)
echo "demo port: $PORT"

echo "--- gzip, br (highest q wins; config order gzip first)"
curl -s -D- -o /tmp/demo-body.bin -H 'Accept-Encoding: gzip, br' "http://127.0.0.1:$PORT/text" | head -12
echo "decoded bytes: $(gunzip -c /tmp/demo-body.bin | wc -c | tr -d ' ')"

echo "--- br preferred by q"
curl -s -D- -o /tmp/demo-body.bin -H 'Accept-Encoding: gzip;q=0.5, br;q=1' "http://127.0.0.1:$PORT/text" | head -12
echo "decoded bytes: $(brotli -dc /tmp/demo-body.bin 2>/dev/null | wc -c | tr -d ' ')"

echo "--- identity"
curl -s -D- -o /tmp/demo-body.bin -H 'Accept-Encoding: identity' "http://127.0.0.1:$PORT/text" | head -12
echo "body bytes: $(wc -c < /tmp/demo-body.bin | tr -d ' ')"

echo "--- 406"
curl -s -D- -o /dev/null -H 'Accept-Encoding: gzip;q=0, br;q=0, identity;q=0' "http://127.0.0.1:$PORT/text" | head -12

echo "--- 206 passthrough"
curl -s -D- -o /dev/null -H 'Accept-Encoding: gzip, br' "http://127.0.0.1:$PORT/range" | head -12

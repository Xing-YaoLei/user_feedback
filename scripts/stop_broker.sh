#!/usr/bin/env bash
# 停止本地 mosquitto
set -euo pipefail
PIDFILE=/tmp/mosquitto-telemetry/broker.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")"
  rm -f "$PIDFILE"
  echo "mosquitto 已停止"
else
  echo "mosquitto 未在运行"
fi

#!/usr/bin/env bash
# 启动本地 mosquitto（不依赖 Docker）。
# 安装：brew install mosquitto   （Linux: sudo apt install mosquitto）
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p /tmp/mosquitto-telemetry data

if ! command -v mosquitto >/dev/null 2>&1; then
  echo "未找到 mosquitto。macOS 安装: brew install mosquitto" >&2
  exit 1
fi

if [ -f /tmp/mosquitto-telemetry/broker.pid ] && \
   kill -0 "$(cat /tmp/mosquitto-telemetry/broker.pid)" 2>/dev/null; then
  echo "mosquitto 已在运行，pid=$(cat /tmp/mosquitto-telemetry/broker.pid)"
  exit 0
fi

# -c 指定项目配置；进程 pid 落盘便于 stop 脚本
mosquitto -c mosquitto/mosquitto.conf &
echo $! > /tmp/mosquitto-telemetry/broker.pid
sleep 1

if kill -0 "$(cat /tmp/mosquitto-telemetry/broker.pid)" 2>/dev/null; then
  echo "mosquitto 已启动: 127.0.0.1:1883 (pid=$(cat /tmp/mosquitto-telemetry/broker.pid))"
  echo "日志: /tmp/mosquitto-telemetry/broker.log"
else
  echo "mosquitto 启动失败，查看日志: /tmp/mosquitto-telemetry/broker.log" >&2
  exit 1
fi

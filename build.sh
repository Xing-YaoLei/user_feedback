#!/usr/bin/env bash
# 无 cmake 环境下的本地构建脚本（macOS/Linux，clang++ 或 g++）
set -euo pipefail
cd "$(dirname "$0")"

CXX="${CXX:-clang++}"
SRC="src/crc32.cpp src/frame_decoder.cpp src/gap_tracker.cpp src/byte_source.cpp \
src/sim_source.cpp src/raw_recorder.cpp src/frame_sink.cpp src/pipeline.cpp"
FLAGS="-std=c++17 -Wall -Wextra -Wpedantic -Iinclude"

mkdir -p out
$CXX $FLAGS $SRC tests/test_main.cpp -o out/pro20_tests
$CXX $FLAGS $SRC app/capture_demo.cpp -o out/capture_demo
$CXX $FLAGS src/crc32.cpp src/frame_decoder.cpp src/gap_tracker.cpp src/byte_source.cpp \
  app/replay.cpp -o out/replay

echo "构建完成: out/pro20_tests out/capture_demo out/replay"

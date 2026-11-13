#!/bin/zsh
# 运行全部单元/集成测试。
#
# 本机只装了 Command Line Tools（无完整 Xcode），XCTest 不可用，
# swift test 的 helper 在该环境下会静默吞掉 Swift Testing 的事件流，
# 因此测试通过独立的 TestRunner 可执行目标运行，输出与退出码均正常。
set -euo pipefail
cd "$(dirname "$0")"
swift build --product TestRunner
exec .build/arm64-apple-macosx/debug/TestRunner "$@"

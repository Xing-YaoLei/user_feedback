import Foundation
import Testing

// 独立测试运行器：这台机器只有 Command Line Tools，
// swiftpm-testing-helper 在该环境下静默吞掉 Swift Testing 的事件流，
// 因此直接调用框架的入口函数，由 Testing 自己向 stdout 打印结果。
let entryPoint: (Testing.__CommandLineArguments_v0?) async -> CInt = Testing.__swiftPMEntryPoint(passing:)
let exitCode = await entryPoint(nil)
exit(exitCode)

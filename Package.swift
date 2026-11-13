// swift-tools-version: 5.9
import PackageDescription

// 这台机器只有 Command Line Tools（无完整 Xcode）：XCTest 不可用，
// 测试改用随 CLT 分发的 Swift Testing（Testing.framework），需显式给出框架搜索路径。
let cltFrameworks = "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"
let cltDeveloperLib = "/Library/Developer/CommandLineTools/Library/Developer/usr/lib"

let package = Package(
    name: "InspectionAssistant",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(name: "InspectionCore", targets: ["InspectionCore"]),
        .library(name: "MockServer", targets: ["MockServer"]),
        .executable(name: "InspectionAssistant", targets: ["InspectionApp"]),
        .executable(name: "TestRunner", targets: ["TestRunner"])
    ],
    targets: [
        .target(name: "InspectionCore"),
        .target(
            name: "MockServer",
            dependencies: ["InspectionCore"],
            resources: [.copy("Resources/index.html")]
        ),
        .executableTarget(
            name: "InspectionApp",
            dependencies: ["InspectionCore", "MockServer"],
            resources: [.copy("Resources/sample.csv")]
        ),
        .testTarget(
            name: "InspectionCoreTests",
            dependencies: ["InspectionCore", "MockServer"],
            path: "Tests/SharedTests",
            swiftSettings: [
                .unsafeFlags(["-F", cltFrameworks])
            ],
            linkerSettings: [
                .unsafeFlags(["-F", cltFrameworks,
                              "-Xlinker", "-framework", "-Xlinker", "Testing",
                              "-Xlinker", "-rpath", "-Xlinker", cltFrameworks,
                              "-Xlinker", "-rpath", "-Xlinker", cltDeveloperLib])
            ]
        ),
        .executableTarget(
            name: "TestRunner",
            dependencies: ["InspectionCore", "MockServer"],
            path: "Sources/TestRunner",
            swiftSettings: [
                .unsafeFlags(["-F", cltFrameworks])
            ],
            linkerSettings: [
                .unsafeFlags(["-F", cltFrameworks,
                              "-Xlinker", "-framework", "-Xlinker", "Testing",
                              "-Xlinker", "-rpath", "-Xlinker", cltFrameworks,
                              "-Xlinker", "-rpath", "-Xlinker", cltDeveloperLib])
            ]
        )
    ],
    swiftLanguageVersions: [.v5]
)

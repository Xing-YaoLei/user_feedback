# 巡检录入助手（InspectionAssistant）

导入巡检 CSV，在本地登记页上**逐条核对后再提交**的 macOS 录入助手。Swift 编写，SwiftUI + WKWebView 界面，内置本地 HTTP 服务和可手动填写/提交的登记页，整个流程不依赖外部后端即可走通。

## 需求与实现对照

| 需求 | 实现方式 |
| --- | --- |
| 导入 CSV（场站、设备名称、巡检日期、结果） | `CSVParser`：RFC 4180 风格，支持引号转义、引号内逗号/换行、UTF-8 BOM、空行，错误带物理行号 |
| 逐条核对，确认后才提交 | `InspectionPipeline` 串行处理，填好后停在 `.awaitingReview` 核对态，人工点「确认无误，提交登记」才提交 |
| 场站-设备联动，设备等请求返回才刷新 | 本地服务 `/api/devices?stationId=` 带随机延迟；页面与原生两侧都做就绪等待 |
| 快速切换场站，旧响应可能最后回来 | **双层竞态防护**：Swift 侧 `StationDeviceCoordinator` 用单调递增 generation 丢弃过期响应（`RaceError.superseded`）；网页 JS 侧用 `deviceReqSeq` 序号 + Promise 就绪机制，`selectDevice` 前必须 `whenDevicesReady(当前场站)` |
| 同名设备匹配多条，停在该行让人选，选完接着填 | `DeviceMatcher` 返回 `.multiple` 时流水线进入 `.needsChoice` 闸门，UI 列出候选（含安装位置/编号），选定后继续 |
| 提交后看到每条记录的办理结果 | 左侧列表每行有状态徽标和详情；成功显示回执号，拒绝显示页面带回的原因 |
| 有回执号才算成功 | 页面 DOM 中出现回执号才判定 `.success`；否则按拒绝处理 |
| 拒绝时带回页面原因，剩余记录继续 | `driver.submit()` 从页面结果面板读回原因，本行置 `.rejected`，流水线自动推进下一行，不中断 |

## 模块结构

```
Package.swift
Sources/
  InspectionCore/          # 与 UI/网络无关的核心逻辑（可单测）
    Models.swift           # 数据模型与行状态机 RowStatus
    CSVParser.swift        # CSV 解析
    Protocols.swift        # InspectionAPI / FormDriver 抽象
    StationDeviceCoordinator.swift  # generation 竞态防护（actor）
    DeviceMatcher.swift    # 同名设备匹配
    InspectionPipeline.swift       # 串行流水线 + 两个人工闸门
  MockServer/
    MockData.swift         # 模拟场站/设备数据与服务端校验规则
    MockHTTPServer.swift   # POSIX socket + GCD 本地 HTTP/1.1 服务
    HTTPClient.swift       # App 使用的 InspectionAPI 实现
    Resources/index.html   # 本地登记页（可手动填写，含 inspectionBridge）
  InspectionApp/           # SwiftUI + WKWebView 可执行程序
    AppState.swift  ContentView.swift  ReviewPanel.swift
    WebViewContainer.swift  WebFormDriver.swift
    Resources/sample.csv   # 示例数据（含同名设备、拒绝、非法日期、未知设备等场景）
  TestRunner/              # 测试运行器（见下方「运行测试」）
Tests/SharedTests/         # Swift Testing 测试（TestRunner 与 testTarget 共用）
run-tests.sh
```

## 关键流程

```
CSV 行
  └─ 解析场站名 → 拉场站列表
       └─ 选场站 → coordinator.devices(for:)（generation 守卫，旧响应丢弃）
            └─ 设备名匹配
                 ├─ 唯一   → driver.fill() 填页面 → 停在核对态
                 ├─ 多条   → 停在「待选择」→ 人工选定 → 填页面 → 核对态
                 └─ 无匹配 → 标记失败，继续下一行
核对态 → 人工确认 → driver.submit()（点页面按钮，读 DOM 结果）
                 ├─ 有回执号 → succeeded（记录回执号）
                 └─ 拒绝     → rejected（带回原因），自动处理下一行
```

## 构建与运行

要求：Swift 5.9+（本机为 Swift 6.3.2，仅 Command Line Tools 亦可）。

```bash
swift build
swift run InspectionAssistant
```

启动后应用会在 `127.0.0.1:8321` 起本地登记服务（端口被占用时可改 `AppState.boot()` 中的 `preferredPort`）。
左侧点「导入 CSV」选择文件，或在空状态点「载入示例 CSV」快速体验全部场景。

### 示例 CSV 覆盖的场景

- 同名设备「1号变压器」匹配两条 → 触发人工选择
- 结果为「待整改」→ 服务端拒绝，原因带回，后续行继续
- 巡检日期晚于今天 → 服务端校验拒绝
- 场站下不存在的设备 → 客户端直接判失败并继续

## 运行测试

```bash
./run-tests.sh
```

> 说明：完整 Xcode 环境下可直接 `swift test`（XCTest/Swift Testing 均支持）。
> 本机只有 Command Line Tools，其 `swiftpm-testing-helper` 会静默吞掉 Swift Testing 的事件流，
> 因此仓库提供 `TestRunner` 可执行目标，直接调用 Testing 框架入口打印结果并返回正确退出码。
> 测试源码在 `Tests/SharedTests/`，由 `TestRunner` 与标准 testTarget 共同编译。

13 个测试覆盖：CSV 词法与行号、竞态协调器（慢响应丢弃）、设备匹配、完整流水线（选择闸门/核对/拒绝不中断）、真实 HTTP 服务集成（页面、接口、成功与拒绝报文）。

## 登记页的竞态防护（index.html）

- 每次切换场站 `deviceReqSeq++`，请求返回时序号不符即丢弃（`STALE_DEVICE_RESPONSE`），绝不覆盖当前场站选项。
- `inspectionBridge.selectDevice()` 内部先 `whenDevicesReady(stationId)` 等待当前场站的请求 Promise，再选设备。
- 原生侧 `WebFormDriver` 只通过该桥接接口操作页面，保证「等当前场站选项就绪再填」。

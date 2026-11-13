import Foundation
import Testing
@testable import InspectionCore

/// 端到端验证流水线：人工闸门暂停、选择后续跑、拒绝带原因且不中断后续行、全部办理结果可追踪
@MainActor
struct InspectionPipelineTests {

    @Test func fullFlowWithChoiceGateRejectionAndContinuation() async {
        let stations = [Station(id: "ST-BJ", name: "北京朝阳站"),
                        Station(id: "ST-SH", name: "上海虹桥站")]
        let devices = [
            "ST-BJ": [
                DeviceOption(id: "BJ-T01", name: "1号变压器", location: "A区"),
                DeviceOption(id: "BJ-T02", name: "1号变压器", location: "B区"),
                DeviceOption(id: "BJ-F01", name: "消防主机", location: "消防控制室")
            ],
            "ST-SH": [
                DeviceOption(id: "SH-U01", name: "UPS电源柜", location: "机房")
            ]
        ]
        let rows = [
            CSVRow(lineNumber: 2, stationName: "北京朝阳站", deviceName: "1号变压器",
                   date: "2026-11-10", result: "正常"),            // 同名多条 → 人工选择
            CSVRow(lineNumber: 3, stationName: "北京朝阳站", deviceName: "消防主机",
                   date: "2026-11-09", result: "待整改"),          // 服务端拒绝
            CSVRow(lineNumber: 4, stationName: "上海虹桥站", deviceName: "UPS电源柜",
                   date: "2026-11-11", result: "正常")             // 成功
        ]
        let api = FakeAPI(stations: stations, devices: devices)
        let driver = FakeDriver()
        let pipeline = InspectionPipeline(csvRows: rows, api: api, driver: driver)

        pipeline.start()
        try? await Task.sleep(nanoseconds: 100_000_000)

        // 第一行停在「待选择」闸门
        guard case .needsChoice(let candidates) = pipeline.rowStates[0].status else {
            Issue.record("首行应停在待选择，实际 \(pipeline.rowStates[0].status)")
            return
        }
        #expect(candidates.count == 2)
        #expect(pipeline.currentLine == 2)

        // 人工选 B 区那台，随后应停在核对态
        pipeline.chooseDevice(lineNumber: 2, device: candidates[1])
        try? await Task.sleep(nanoseconds: 100_000_000)
        guard case .awaitingReview(let form) = pipeline.rowStates[0].status else {
            Issue.record("选择后应进入核对态，实际 \(pipeline.rowStates[0].status)")
            return
        }
        #expect(form.device.id == "BJ-T02")
        #expect(driver.filled.count == 1)

        // 确认提交 → 成功后自动推进；第二行先停在核对态（每行都需人工核对）
        pipeline.confirmCurrent()
        try? await Task.sleep(nanoseconds: 150_000_000)

        guard case .succeeded(let no) = pipeline.rowStates[0].status else {
            Issue.record("首行应成功，实际 \(pipeline.rowStates[0].status)")
            return
        }
        #expect(no.hasPrefix("RC-"))

        // 第二行（待整改）先到核对态，人工确认提交后才被服务端拒绝
        guard case .awaitingReview(let review2) = pipeline.rowStates[1].status else {
            Issue.record("第二行应先停在核对态，实际 \(pipeline.rowStates[1].status)")
            return
        }
        #expect(review2.result == "待整改")

        pipeline.confirmCurrent()
        try? await Task.sleep(nanoseconds: 150_000_000)

        guard case .rejected(let reason) = pipeline.rowStates[1].status else {
            Issue.record("第二行应被拒绝并带原因，实际 \(pipeline.rowStates[1].status)")
            return
        }
        #expect(reason.contains("整改单号"), "拒绝原因应来自页面/服务端，实际：\(reason)")

        // 拒绝不中断后续行：第三行继续到核对态
        guard case .awaitingReview = pipeline.rowStates[2].status else {
            Issue.record("拒绝不得阻断后续行，第三行应已到核对态，实际 \(pipeline.rowStates[2].status)")
            return
        }

        pipeline.confirmCurrent()
        try? await Task.sleep(nanoseconds: 150_000_000)
        guard case .succeeded = pipeline.rowStates[2].status else {
            Issue.record("第三行应成功，实际 \(pipeline.rowStates[2].status)")
            return
        }
        #expect(driver.submitted.count == 3)
    }

    @Test func unknownStationAndDeviceFailWithoutBlocking() async {
        let api = FakeAPI(stations: [Station(id: "S1", name: "甲站")],
                          devices: ["S1": [DeviceOption(id: "D1", name: "设备1", location: "")]])
        let driver = FakeDriver()
        let rows = [
            CSVRow(lineNumber: 2, stationName: "幽灵站", deviceName: "X", date: "2026-11-10", result: "正常"),
            CSVRow(lineNumber: 3, stationName: "甲站", deviceName: "幽灵设备", date: "2026-11-10", result: "正常"),
            CSVRow(lineNumber: 4, stationName: "甲站", deviceName: "设备1", date: "2026-11-10", result: "正常")
        ]
        let pipeline = InspectionPipeline(csvRows: rows, api: api, driver: driver)
        pipeline.start()
        try? await Task.sleep(nanoseconds: 200_000_000)

        guard case .failed(let r1) = pipeline.rowStates[0].status else {
            Issue.record("第一行应失败，实际 \(pipeline.rowStates[0].status)")
            return
        }
        #expect(r1.contains("场站不存在"))
        guard case .failed(let r2) = pipeline.rowStates[1].status else {
            Issue.record("第二行应失败，实际 \(pipeline.rowStates[1].status)")
            return
        }
        #expect(r2.contains("找不到设备"))
        guard case .awaitingReview = pipeline.rowStates[2].status else {
            Issue.record("前两行失败不应阻断第三行，实际 \(pipeline.rowStates[2].status)")
            return
        }
    }
}

// MARK: - 测试替身

private actor FakeAPI: InspectionAPI {
    let stations: [Station]
    let devices: [String: [DeviceOption]]

    init(stations: [Station], devices: [String: [DeviceOption]]) {
        self.stations = stations
        self.devices = devices
    }

    func fetchStations() async throws -> [Station] { stations }

    func fetchDevices(stationId: String) async throws -> [DeviceOption] {
        guard let list = devices[stationId] else { throw NSError(domain: "test", code: 1) }
        return list
    }

    func submit(_ s: InspectionSubmission) async throws -> SubmitOutcome {
        if s.result == "待整改" {
            return .rejected(reason: "「待整改」记录须先附整改单号，暂不受理")
        }
        return .success(receiptNo: "RC-\(s.deviceId)-\(Int.random(in: 100...999))")
    }
}

@MainActor
private final class FakeDriver: FormDriver {
    var filled: [(stationId: String, deviceId: String, date: String, result: String)] = []
    var submitted: [InspectionSubmission] = []

    func fill(station: Station, device: DeviceOption, date: String, result: String) async throws {
        filled.append((station.id, device.id, date, result))
    }

    func submit() async throws -> SubmitOutcome {
        // 模拟从页面 DOM 读回的最近一次填写
        guard let last = filled.last else { return .rejected(reason: "页面无数据") }
        let submission = InspectionSubmission(stationId: last.stationId, deviceId: last.deviceId,
                                              date: last.date, result: last.result)
        submitted.append(submission)
        if submission.result == "待整改" {
            return .rejected(reason: "「待整改」记录须先附整改单号，暂不受理")
        }
        return .success(receiptNo: "RC-\(submission.deviceId)-9001")
    }

    func readBack() async throws -> FormReadback? {
        guard let last = filled.last else { return nil }
        return FormReadback(stationId: last.stationId, deviceId: last.deviceId,
                            date: last.date, result: last.result)
    }
}

import Testing
@testable import InspectionCore

struct CoordinatorAndMatcherTests {

    /// 模拟慢响应：A 场站慢、B 场站快。快速先选 A 再选 B，
    /// A 的响应最后回来时必须被判为过期，当前设备列表只属于 B。
    @Test func lateResponseFromOldStationIsDiscarded() async {
        let stationA = Station(id: "A", name: "甲站")
        let stationB = Station(id: "B", name: "乙站")
        let api = SlowRaceAPI()
        let coordinator = StationDeviceCoordinator(api: api)

        async let first: Void = {
            _ = try? await coordinator.devices(for: stationA)
        }()
        // 确保 A 先拿到 generation，再让 B 取代它
        try? await Task.sleep(nanoseconds: 30_000_000)
        let bDevices = try? await coordinator.devices(for: stationB)
        _ = await first

        #expect(bDevices?.map(\.id) == ["B1"])
        let current = await coordinator.devices()
        #expect(current.map(\.id) == ["B1"])
        let currentStation = await coordinator.stationId()
        #expect(currentStation == "B")
    }

    @Test func sequentialSelectsBothSucceedWhenNotRacing() async throws {
        let api = SlowRaceAPI()
        let coordinator = StationDeviceCoordinator(api: api)
        let a = try await coordinator.devices(for: Station(id: "A", name: "甲站"))
        #expect(a.map(\.id) == ["A1", "A2"])
        let b = try await coordinator.devices(for: Station(id: "B", name: "乙站"))
        #expect(b.map(\.id) == ["B1"])
    }

    @Test func exactNameMatch() {
        let options = [
            DeviceOption(id: "1", name: "1号变压器", location: "A区"),
            DeviceOption(id: "2", name: "1号变压器", location: "B区"),
            DeviceOption(id: "3", name: "高压开关柜", location: "主控室")
        ]
        #expect(DeviceMatcher.match(name: "高压开关柜", in: options) == .unique(options[2]))
        if case .multiple(let hits) = DeviceMatcher.match(name: "1号变压器", in: options) {
            #expect(hits.map(\.id) == ["1", "2"])
        } else {
            Issue.record("应当返回多条候选")
        }
        #expect(DeviceMatcher.match(name: "不存在", in: options) == .none)
        #expect(DeviceMatcher.match(name: "  高压开关柜  ", in: options) == .unique(options[2]))
    }
}

/// 设备接口对 A 故意慢回、对 B 快回，制造「旧场站响应最后到达」
private actor SlowRaceAPI: InspectionAPI {
    nonisolated func fetchStations() async throws -> [Station] { [] }

    nonisolated func fetchDevices(stationId: String) async throws -> [DeviceOption] {
        if stationId == "A" {
            try await Task.sleep(nanoseconds: 250_000_000)
            return [DeviceOption(id: "A1", name: "设备A1", location: ""),
                    DeviceOption(id: "A2", name: "设备A2", location: "")]
        }
        try await Task.sleep(nanoseconds: 20_000_000)
        return [DeviceOption(id: "B1", name: "设备B1", location: "")]
    }

    nonisolated func submit(_ submission: InspectionSubmission) async throws -> SubmitOutcome {
        .success(receiptNo: "RC-X")
    }
}

import Foundation
import Testing
@testable import MockServer
import InspectionCore

/// 启动真实的本地 HTTP 服务，用真实 HTTPClient 打一遍接口
struct MockServerIntegrationTests {

    @Test func serverServesPageAndAPIs() async throws {
        let server = MockHTTPServer(deviceLatency: 1..<5)
        let port = try await server.start(preferredPort: 0)
        defer { server.stop() }

        let base = URL(string: "http://127.0.0.1:\(port)/")!
        let client = HTTPClient(baseURL: base)

        let stations = try await client.fetchStations()
        #expect(!stations.isEmpty)
        #expect(stations.contains { $0.name == "北京朝阳站" })

        let devices = try await client.fetchDevices(stationId: "ST-BJ")
        #expect(devices.filter { $0.name == "1号变压器" }.count == 2)

        // 成功路径
        let ok = try await client.submit(
            InspectionSubmission(stationId: "ST-BJ", deviceId: "BJ-P01",
                                 date: "2026-11-10", result: "正常"))
        guard case .success(let no) = ok else { Issue.record("应返回回执号"); return }
        #expect(no.hasPrefix("RC-"))

        // 拒绝路径：原因必须带回
        let rejected = try await client.submit(
            InspectionSubmission(stationId: "ST-BJ", deviceId: "BJ-P01",
                                 date: "2026-11-10", result: "待整改"))
        guard case .rejected(let reason) = rejected else { Issue.record("应被拒绝"); return }
        #expect(reason.contains("整改单号"))

        // 设备不属于场站 → 拒绝
        let cross = try await client.submit(
            InspectionSubmission(stationId: "ST-BJ", deviceId: "SH-U01",
                                 date: "2026-11-10", result: "正常"))
        guard case .rejected(let reason2) = cross else { Issue.record("跨场站设备应被拒绝"); return }
        #expect(reason2.contains("联动"))

        // 首页 HTML 可达
        let (data, response) = try await URLSession.shared.data(from: base)
        let http = try #require(response as? HTTPURLResponse)
        #expect(http.statusCode == 200)
        #expect(String(data: data, encoding: .utf8)?.contains("巡检登记") == true)
    }
}

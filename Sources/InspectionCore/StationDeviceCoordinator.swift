import Foundation

/// 场站-设备联动协调器。
///
/// 竞态场景：用户（或流水线）快速切换场站 A → B，A 的设备请求比 B 慢，
/// A 的响应最后回来。这里用单调递增的 generation 标记每次选择：
/// 响应返回时 generation 已变，说明它已过期，直接丢弃并抛 `RaceError.superseded`，
/// 设备列表永远只反映「当前场站」。
public actor StationDeviceCoordinator {
    private let api: InspectionAPI
    private var generation: UInt64 = 0
    private var currentStationId: String?
    private var currentDevices: [DeviceOption] = []

    public init(api: InspectionAPI) {
        self.api = api
    }

    /// 切换场站并等待「这一场站」的设备选项就绪。
    /// 被更新的选择取代时抛 `RaceError.superseded`，调用方不应再使用其结果。
    public func devices(for station: Station) async throws -> [DeviceOption] {
        generation += 1
        let myGeneration = generation
        currentStationId = station.id
        currentDevices = []

        let list: [DeviceOption]
        do {
            list = try await api.fetchDevices(stationId: station.id)
        } catch {
            // 只有仍是当前选择时，错误才有意义；否则同样按过期处理
            if myGeneration == generation {
                currentDevices = []
                throw error
            }
            throw RaceError.superseded
        }

        // 关键守卫：晚到的旧场站响应在此被丢弃
        guard myGeneration == generation, currentStationId == station.id else {
            throw RaceError.superseded
        }
        currentDevices = list
        return list
    }

    public func stationId() -> String? { currentStationId }
    public func devices() -> [DeviceOption] { currentDevices }
}

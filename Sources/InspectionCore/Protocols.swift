import Foundation

/// 旧场站的响应晚于新场站返回时抛出，调用方应放弃这次结果
public enum RaceError: Error, Equatable {
    case superseded
}

/// 后端接口抽象：真实实现走本地 HTTP 服务，测试可用内存假实现
public protocol InspectionAPI: Sendable {
    func fetchStations() async throws -> [Station]
    /// 拉取场站下的设备；实现层可能有任意延迟（模拟慢网络）
    func fetchDevices(stationId: String) async throws -> [DeviceOption]
    func submit(_ submission: InspectionSubmission) async throws -> SubmitOutcome
}

/// 登记页驱动：把引擎的决策落到真实页面上，并从页面读回办理结果
public protocol FormDriver: Sendable {
    /// 填表单。实现必须保证场站联动的设备选项就绪后再选设备
    func fill(station: Station, device: DeviceOption, date: String, result: String) async throws
    /// 点击页面提交，并从页面 DOM 读回结果：有回执号即成功，否则带回拒绝原因
    func submit() async throws -> SubmitOutcome
    /// 提交前读回页面上的实际值（用户可能在核对时手动改过）
    func readBack() async throws -> FormReadback?
}

public extension FormDriver {
    /// 默认实现不读回，直接用引擎侧快照
    func readBack() async throws -> FormReadback? { nil }
}

public struct FormReadback: Equatable, Sendable {
    public let stationId: String
    public let deviceId: String
    public let date: String
    public let result: String

    public init(stationId: String, deviceId: String, date: String, result: String) {
        self.stationId = stationId
        self.deviceId = deviceId
        self.date = date
        self.result = result
    }
}

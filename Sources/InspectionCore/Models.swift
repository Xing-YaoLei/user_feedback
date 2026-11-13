import Foundation

/// 场站
public struct Station: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// 场站下的设备选项（同名设备可能有多条，用 id / location 区分）
public struct DeviceOption: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let location: String

    public init(id: String, name: String, location: String) {
        self.id = id
        self.name = name
        self.location = location
    }
}

/// 一次巡检提交的报文
public struct InspectionSubmission: Codable, Equatable, Sendable {
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

/// 提交结果：只有拿到回执号才算成功
public enum SubmitOutcome: Equatable, Sendable {
    case success(receiptNo: String)
    case rejected(reason: String)
}

/// 已填入登记页的表单快照（核对态的数据来源）
public struct FilledForm: Equatable, Sendable {
    public var station: Station
    public var device: DeviceOption
    public var date: String
    public var result: String

    public init(station: Station, device: DeviceOption, date: String, result: String) {
        self.station = station
        self.device = device
        self.date = date
        self.result = result
    }
}

/// CSV 中的一行原始记录
public struct CSVRow: Identifiable, Equatable, Sendable {
    /// CSV 中的物理行号（从 1 开始，含表头），便于定位问题
    public let lineNumber: Int
    public let stationName: String
    public let deviceName: String
    public let date: String
    public let result: String

    public var id: Int { lineNumber }

    public init(lineNumber: Int, stationName: String, deviceName: String, date: String, result: String) {
        self.lineNumber = lineNumber
        self.stationName = stationName
        self.deviceName = deviceName
        self.date = date
        self.result = result
    }
}

/// 行处理状态，驱动左侧列表的状态徽标和右侧操作区
public enum RowStatus: Equatable, Sendable {
    case pending
    case filling
    /// 同名设备匹配到多条，等待人工选择
    case needsChoice(candidates: [DeviceOption])
    /// 已填入登记页，等待人工核对后提交
    case awaitingReview(FilledForm)
    case submitting
    case succeeded(receiptNo: String)
    case rejected(reason: String)
    case failed(reason: String)
    case skipped

    public var label: String {
        switch self {
        case .pending: return "待处理"
        case .filling: return "填写中"
        case .needsChoice: return "待选择设备"
        case .awaitingReview: return "待核对提交"
        case .submitting: return "提交中"
        case .succeeded: return "已成功"
        case .rejected: return "已拒绝"
        case .failed: return "失败"
        case .skipped: return "已跳过"
        }
    }
}

/// 一行的完整运行态
public struct RowState: Identifiable, Equatable {
    public let row: CSVRow
    public var status: RowStatus

    public var id: Int { row.lineNumber }

    public init(row: CSVRow, status: RowStatus = .pending) {
        self.row = row
        self.status = status
    }
}

/// 流程引擎向外抛出的事件
public enum RowEvent: Sendable, Equatable {
    case statusChanged(lineNumber: Int, status: RowStatus)
}

import Foundation

public enum DeviceMatch: Equatable {
    case unique(DeviceOption)
    case multiple([DeviceOption])
    case none
}

public enum DeviceMatcher {
    /// 按设备名称精确匹配（去除首尾空白）。同名多条时返回全部候选，交人工选择
    public static func match(name rawName: String, in options: [DeviceOption]) -> DeviceMatch {
        let name = rawName.trimmingCharacters(in: .whitespaces)
        let hits = options.filter { $0.name.trimmingCharacters(in: .whitespaces) == name }
        if hits.count == 1 { return .unique(hits[0]) }
        if hits.count > 1 { return .multiple(hits) }
        return .none
    }
}

import Foundation
import InspectionCore

/// 模拟后端的全部数据与校验规则（HTTP 服务与单元测试共用同一份，保证行为一致）
public enum MockData {

    public static let stations: [Station] = [
        Station(id: "ST-BJ", name: "北京朝阳站"),
        Station(id: "ST-SH", name: "上海虹桥站"),
        Station(id: "ST-GZ", name: "广州南站")
    ]

    /// 特意构造：每个场站都有同名设备「1号变压器」，跨场站不能串；
    /// 北京朝阳站下「1号变压器」有两条（同设备名、不同安装位置），用于触发人工选择
    public static let devices: [String: [DeviceOption]] = [
        "ST-BJ": [
            DeviceOption(id: "BJ-T01", name: "1号变压器", location: "A区配电室"),
            DeviceOption(id: "BJ-T02", name: "1号变压器", location: "B区配电室"),
            DeviceOption(id: "BJ-P01", name: "高压开关柜", location: "主控室"),
            DeviceOption(id: "BJ-F01", name: "消防主机", location: "消防控制室")
        ],
        "ST-SH": [
            DeviceOption(id: "SH-T01", name: "1号变压器", location: "东侧变电所"),
            DeviceOption(id: "SH-P01", name: "高压开关柜", location: "西侧变电所"),
            DeviceOption(id: "SH-U01", name: "UPS电源柜", location: "机房")
        ],
        "ST-GZ": [
            DeviceOption(id: "GZ-T01", name: "1号变压器", location: "北区配电房"),
            DeviceOption(id: "GZ-F01", name: "消防主机", location: "南区控制室"),
            DeviceOption(id: "GZ-A01", name: "空调主机", location: "楼顶机房")
        ]
    ]

    public static let allowedResults = ["正常", "异常", "待整改"]
    private static let datePattern = #"^\d{4}-\d{2}-\d{2}$"#

    /// 服务端校验，返回拒绝原因；nil 表示通过
    public static func rejectionReason(_ s: InspectionSubmission, now: Date = Date()) -> String? {
        guard devices[s.stationId]?.contains(where: { $0.id == s.deviceId }) == true else {
            return "设备不属于所选场站，场站与设备未联动一致"
        }
        guard range(of: datePattern, matches: s.date) else {
            return "巡检日期格式不正确，应为 YYYY-MM-DD"
        }
        if let date = Self.dateFormatter.date(from: s.date), date > now {
            return "巡检日期不能晚于今天"
        }
        guard allowedResults.contains(s.result) else {
            return "结果取值无效，允许：\(allowedResults.joined(separator: "/"))"
        }
        // 演示用：任何「待整改」结果都会被服务端退回，便于观察拒绝路径
        if s.result == "待整改" {
            return "「待整改」记录须先附整改单号，暂不受理"
        }
        return nil
    }

    public static func makeReceiptNo() -> String {
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        let rand = Int.random(in: 100...999)
        return "RC-\(stamp)-\(rand)"
    }

    static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func range(of pattern: String, matches text: String) -> Bool {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return false }
        let r = re.rangeOfFirstMatch(in: text, range: NSRange(text.startIndex..., in: text))
        return r.location == 0 && r.length == (text as NSString).length
    }
}

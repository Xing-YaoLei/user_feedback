import Foundation
import WebKit
import InspectionCore

/// 用 WKWebView 驱动真实登记页的 FormDriver。
/// 所有填写动作都调用页面里的 inspectionBridge（页面侧再做一层序号竞态防护），
/// 提交结果从页面 DOM 读回：有回执号才算成功，拒绝时带回页面上的原因。
@MainActor
public final class WebFormDriver: NSObject, FormDriver {
    private let webView: WKWebView

    public init(webView: WKWebView) {
        self.webView = webView
    }

    public func fill(station: Station, device: DeviceOption, date: String, result: String) async throws {
        // fillForm 内部会等当前场站设备选项就绪再选设备（whenDevicesReady）
        let js = """
        window.inspectionBridge.fillForm(
          \(jsString(station.id)), \(jsString(device.id)),
          \(jsString(date)), \(jsString(result))
        )
        """
        let _: Bool = try await evaluate(js)
    }

    public func submit() async throws -> SubmitOutcome {
        let panel: PanelResult? = try await evaluate("window.inspectionBridge.submit()")
        guard let panel else {
            return .rejected(reason: "登记页没有返回任何办理结果")
        }
        if panel.ok, let no = panel.receiptNo, !no.isEmpty {
            return .success(receiptNo: no)
        }
        return .rejected(reason: panel.reason ?? panel.title ?? "页面未给出拒绝原因")
    }

    public func readBack() async throws -> FormReadback? {
        let value: ReadbackDTO? = try await evaluate("window.inspectionBridge.readBack()")
        guard let v = value, let stationId = v.stationId, let deviceId = v.deviceId else { return nil }
        return FormReadback(stationId: stationId,
                            deviceId: deviceId,
                            date: v.date ?? "",
                            result: v.result ?? "")
    }

    // MARK: - 私有

    /// 执行返回 JSON 兼容对象的 JS，再解码成 Swift 类型
    private func evaluate<T: Decodable>(_ js: String) async throws -> T {
        let raw: Any?
        do {
            raw = try await webView.callAsyncJavaScript(
                js, arguments: [:], contentWorld: .page
            )
        } catch {
            throw DriverError.jsFailure(js: js, message: error.localizedDescription)
        }
        if let error = raw as? [String: Any], let message = error["message"] as? String {
            throw DriverError.pageError(String(describing: message))
        }
        guard let any = raw else {
            throw DriverError.emptyResult
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: any)
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw DriverError.decodeFailure(message: error.localizedDescription)
        }
    }

    private func jsString(_ s: String) -> String {
        var out = "\""
        for ch in s {
            switch ch {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default: out.append(ch)
            }
        }
        out += "\""
        return out
    }
}

private struct PanelResult: Decodable {
    let ok: Bool
    let receiptNo: String?
    let reason: String?
    let title: String?
}

private struct ReadbackDTO: Decodable {
    let stationId: String?
    let deviceId: String?
    let date: String?
    let result: String?
}

public enum DriverError: LocalizedError {
    case jsFailure(js: String, message: String)
    case pageError(String)
    case emptyResult
    case decodeFailure(message: String)

    public var errorDescription: String? {
        switch self {
        case .jsFailure(_, let message): return "页面脚本执行失败：\(message)"
        case .pageError(let m): return m
        case .emptyResult: return "页面没有返回数据（页面可能尚未加载完成）"
        case .decodeFailure(let m): return "页面返回的数据无法识别：\(m)"
        }
    }
}

import SwiftUI
import WebKit
import UniformTypeIdentifiers
import InspectionCore
import MockServer

@MainActor
final class AppState: ObservableObject {
    @Published var serverPort: UInt16?
    @Published var serverError: String?
    @Published var pipeline: InspectionPipeline?
    @Published var selectedLine: Int?
    @Published var importNotice: String?
    @Published var webView: WKWebView?
    var sampleCSVURL: URL?

    private let server = MockHTTPServer()

    var serverURL: URL? {
        guard let serverPort else { return nil }
        return URL(string: "http://127.0.0.1:\(serverPort)/")!
    }

    func boot() async {
        guard serverPort == nil else { return }
        do {
            serverPort = try await server.start(preferredPort: 8321)
        } catch {
            serverError = "本地登记服务启动失败：\(error.localizedDescription)"
        }
    }

    func importCSV() {
        let panel = NSOpenPanel()
        panel.title = "选择巡检 CSV"
        panel.allowedContentTypes = [UTType(filenameExtension: "csv") ?? .plainText, .plainText]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        loadCSV(url: url)
    }

    func loadCSV(url: URL) {
        do {
            let rows = try CSVParser.parse(url: url)
            guard !rows.isEmpty else {
                importNotice = "CSV 中没有可导入的数据行"
                return
            }
            guard let webView, let serverURL else {
                importNotice = "登记页尚未就绪，请稍后再试"
                return
            }
            let client = HTTPClient(baseURL: serverURL)
            let driver = WebFormDriver(webView: webView)
            let pipeline = InspectionPipeline(csvRows: rows, api: client, driver: driver)
            self.pipeline = pipeline
            self.importNotice = "已导入 \(rows.count) 条记录"
            pipeline.start()
        } catch let error as CSVError {
            importNotice = error.errorDescription ?? error.localizedDescription
        } catch {
            importNotice = "导入失败：\(error.localizedDescription)"
        }
    }

    var summary: Summary {
        guard let pipeline else { return Summary() }
        var s = Summary(total: pipeline.rowStates.count)
        for row in pipeline.rowStates {
            switch row.status {
            case .succeeded: s.succeeded += 1
            case .rejected: s.rejected += 1
            case .failed: s.failed += 1
            case .skipped: s.skipped += 1
            case .awaitingReview, .needsChoice: s.waitingHuman += 1
            default: s.inflight += 1
            }
        }
        return s
    }
}

struct Summary: Equatable {
    var total = 0
    var succeeded = 0
    var rejected = 0
    var failed = 0
    var skipped = 0
    var waitingHuman = 0
    var inflight = 0
}

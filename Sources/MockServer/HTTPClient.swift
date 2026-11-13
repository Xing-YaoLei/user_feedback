import Foundation
import InspectionCore

/// 走本地 HTTP 服务的接口实现（App 实际使用）
public actor HTTPClient: InspectionAPI {
    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func fetchStations() async throws -> [Station] {
        try await get("/api/stations")
    }

    public func fetchDevices(stationId: String) async throws -> [DeviceOption] {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/devices"),
                                  resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "stationId", value: stationId)]
        var request = URLRequest(url: comps.url!)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return try await send(request)
    }

    public func submit(_ submission: InspectionSubmission) async throws -> SubmitOutcome {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/inspections"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(submission)
        let response: SubmitResponse = try await send(request)
        if let no = response.receiptNo {
            return .success(receiptNo: no)
        }
        return .rejected(reason: response.reason ?? "服务端未给出原因")
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw URLError(.cannotConnectToHost, userInfo: [NSLocalizedDescriptionKey: "本地登记服务未启动（\(error.localizedDescription)）"])
        }
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            let msg = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            throw URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: msg])
        }
        return try decoder.decode(T.self, from: data)
    }
}

struct SubmitResponse: Decodable {
    let ok: Bool
    let receiptNo: String?
    let reason: String?
}

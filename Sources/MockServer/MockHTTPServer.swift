import Foundation
import InspectionCore

/// 基于 POSIX socket + GCD 的极简本地 HTTP/1.1 服务。
///
/// 用 BSD socket 而非 Network.framework：后者在仅装 Command Line Tools 的
/// 环境里创建 NWListener 会直接 EINVAL。每个连接响应后主动关闭（Connection: close）。
public final class MockHTTPServer: @unchecked Sendable {

    public enum ServerError: LocalizedError {
        case failedToStart(String)
        public var errorDescription: String? {
            switch self {
            case .failedToStart(let detail): return "本地登记服务启动失败：\(detail)"
            }
        }
    }

    private var listenFD: Int32 = -1
    private let queue = DispatchQueue(label: "com.example.mockserver")
    private let acceptSourceQueue = DispatchQueue(label: "com.example.mockserver.accept")
    private var acceptSource: DispatchSourceRead?
    private let encoder = JSONEncoder()
    private let deviceLatency: Range<UInt64>
    private var htmlCache: Data?

    /// - Parameter deviceLatency: 设备列表接口的随机延迟范围（毫秒），用于制造联动竞态
    public init(deviceLatency: Range<UInt64> = 150..<900) {
        self.deviceLatency = deviceLatency
    }

    deinit {
        if listenFD >= 0 { close(listenFD) }
    }

    /// 启动服务，返回实际监听端口。
    /// - Parameter preferredPort: 传 0 表示由内核分配空闲端口
    public func start(preferredPort: UInt16 = 0) async throws -> UInt16 {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UInt16, Error>) in
            queue.async { [weak self] in
                guard let self else { return }
                do {
                    let port = try self.bindAndListen(preferredPort: preferredPort)
                    self.startAccepting()
                    cont.resume(returning: port)
                } catch {
                    cont.resume(throwing: error)
                }
            }
        }
    }

    public func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.acceptSource?.cancel()
            self.acceptSource = nil
            // cancel handler 会关闭并置 -1；兜底再判一次，避免重复 close
            if self.listenFD >= 0 {
                close(self.listenFD)
                self.listenFD = -1
            }
        }
    }

    // MARK: - socket 搭建

    private func bindAndListen(preferredPort: UInt16) throws -> UInt16 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw ServerError.failedToStart("socket() 失败 errno=\(errno)")
        }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        // 非阻塞：DispatchSource 水平触发后循环 accept，取完待处理连接时立即返回 EAGAIN
        let flags = fcntl(fd, F_GETFL)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)

        var addr = sockaddr_in(
            sin_len: UInt8(MemoryLayout<sockaddr_in>.size),
            sin_family: sa_family_t(AF_INET),
            sin_port: in_port_t(preferredPort).bigEndian,
            sin_addr: in_addr(s_addr: INADDR_ANY),
            sin_zero: (0, 0, 0, 0, 0, 0, 0, 0)
        )
        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            let e = errno
            close(fd)
            throw ServerError.failedToStart("bind() 失败 errno=\(e)")
        }
        guard listen(fd, 16) == 0 else {
            let e = errno
            close(fd)
            throw ServerError.failedToStart("listen() 失败 errno=\(e)")
        }

        // 读回实际端口（preferredPort 为 0 时由内核分配）
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        var actual = sockaddr_in()
        let nameResult = withUnsafeMutablePointer(to: &actual) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &len)
            }
        }
        guard nameResult == 0 else {
            close(fd)
            throw ServerError.failedToStart("getsockname() 失败 errno=\(errno)")
        }
        listenFD = fd
        return UInt16(bigEndian: actual.sin_port)
    }

    private func startAccepting() {
        let source = DispatchSource.makeReadSource(fileDescriptor: listenFD, queue: acceptSourceQueue)
        source.setCancelHandler { [weak self] in
            // close 统一在 stop() 中做，避免与 stop() 双重关闭
            guard let self, self.listenFD >= 0 else { return }
            close(self.listenFD)
            self.listenFD = -1
        }
        source.setEventHandler { [weak self] in
            guard let self else { return }
            // 一次通知可能对应多个待接受连接
            while true {
                var clientAddr = sockaddr()
                var clientLen = socklen_t(MemoryLayout<sockaddr>.size)
                let clientFD = accept(self.listenFD, &clientAddr, &clientLen)
                if clientFD < 0 {
                    if errno == EWOULDBLOCK || errno == EAGAIN || errno == EINTR { break }
                    break
                }
                // 监听 socket 是非阻塞的，accept 返回的新 fd 会继承 O_NONBLOCK；
                // 客户端连接在自己的队列里用阻塞 recv 读，这里清掉该标志
                let clientFlags = fcntl(clientFD, F_GETFL)
                _ = fcntl(clientFD, F_SETFL, clientFlags & ~O_NONBLOCK)
                // 空闲连接 10 秒收不到完整请求即回收，避免浏览器保持连接导致线程长期挂住
                var tv = timeval(tv_sec: 10, tv_usec: 0)
                setsockopt(clientFD, SOL_SOCKET, SO_RCVTIMEO, &tv,
                           socklen_t(MemoryLayout<timeval>.size))
                self.handleConnection(clientFD)
            }
        }
        source.resume()
        acceptSource = source
    }

    // MARK: - 连接与请求

    private func handleConnection(_ fd: Int32) {
        // 每个连接一条串行队列，读完一个请求即处理并关闭
        let connQueue = DispatchQueue(label: "com.example.mockserver.conn.\(fd)")
        connQueue.async { [weak self] in
            guard let self else { close(fd); return }
            guard let request = self.readRequest(fd) else {
                _ = SocketIO.writeAll(fd, data: Self.http500())
                close(fd)
                return
            }
            self.handle(request) { response in
                _ = SocketIO.writeAll(fd, data: Self.encode(response))
                // 给客户端留出接收时间后关闭
                connQueue.asyncAfter(deadline: .now() + 0.05) { close(fd) }
            }
        }
    }

    private func readRequest(_ fd: Int32) -> HTTPRequest? {
        var buffer = Data()
        var headerEnd: Range<Data.Index>?
        // 读到头部结束
        while headerEnd == nil {
            if buffer.count > 1 * 1024 * 1024 { return nil }
            guard let chunk = SocketIO.readSome(fd), !chunk.isEmpty else { return nil }
            buffer.append(chunk)
            if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
                headerEnd = range
            }
        }
        guard let end = headerEnd else { return nil }

        let headerData = buffer.subdata(in: buffer.startIndex..<end.lowerBound)
        guard let headerText = String(data: headerData, encoding: .utf8) else { return nil }
        var lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first?.split(separator: " "), requestLine.count >= 2 else { return nil }
        let method = String(requestLine[0])
        let target = String(requestLine[1])
        lines.removeFirst()

        var headers: [String: String] = [:]
        for line in lines {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            headers[parts[0].trimmingCharacters(in: .whitespaces).lowercased()] =
                parts[1].trimmingCharacters(in: .whitespaces)
        }

        let bodyStart = end.upperBound
        let contentLength = Int(headers["content-length"] ?? "0") ?? 0
        // 继续读齐 body
        while buffer.count < bodyStart + contentLength {
            guard let chunk = SocketIO.readSome(fd), !chunk.isEmpty else { return nil }
            buffer.append(chunk)
        }
        let body = buffer.subdata(in: bodyStart..<(bodyStart + contentLength))

        var path = target
        var query: [String: String] = [:]
        if let qIndex = target.firstIndex(of: "?") {
            path = String(target[target.startIndex..<qIndex])
            let queryString = String(target[target.index(after: qIndex)...])
            for pair in queryString.split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1)
                let key = String(kv[0]).removingPercentEncoding ?? String(kv[0])
                let value = kv.count == 1 ? "" : (String(kv[1]).removingPercentEncoding ?? String(kv[1]))
                query[key] = value
            }
        }
        return HTTPRequest(method: method, path: path, queryItems: query, headers: headers, body: body)
    }

    // MARK: - 路由

    fileprivate func handle(_ request: HTTPRequest, completion: @escaping (HTTPResponse) -> Void) {
        switch (request.method, request.path) {
        case ("GET", "/"):
            completion(HTTPResponse(status: 200, statusText: "OK",
                                    headers: ["Content-Type": "text/html; charset=utf-8"],
                                    body: loadHTML()))
        case ("GET", "/api/stations"):
            respondJSON(MockData.stations, completion: completion)
        case ("GET", "/api/devices"):
            let stationId = request.queryItems["stationId"] ?? ""
            let delayMs = UInt64.random(in: deviceLatency)
            queue.asyncAfter(deadline: .now() + .milliseconds(Int(delayMs))) { [weak self] in
                guard let self else { return }
                guard let list = MockData.devices[stationId] else {
                    self.respondError(status: 400, text: "未知场站：\(stationId)", completion: completion)
                    return
                }
                self.respondJSON(list, completion: completion)
            }
        case ("POST", "/api/inspections"):
            handleSubmit(body: request.body, completion: completion)
        default:
            respondError(status: 404, text: "Not Found", completion: completion)
        }
    }

    private func handleSubmit(body: Data, completion: @escaping (HTTPResponse) -> Void) {
        let submission: InspectionSubmission
        do {
            submission = try JSONDecoder().decode(InspectionSubmission.self, from: body)
        } catch {
            respondError(status: 400, text: "请求体不是有效的巡检记录：\(error.localizedDescription)", completion: completion)
            return
        }
        if let reason = MockData.rejectionReason(submission) {
            // 应用层拒绝：HTTP 200 + ok=false + 原因，页面据此渲染拒绝提示
            respondJSON(SubmitPayload(ok: false, receiptNo: nil, reason: reason), completion: completion)
            return
        }
        respondJSON(SubmitPayload(ok: true, receiptNo: MockData.makeReceiptNo(), reason: nil),
                    completion: completion)
    }

    private func respondJSON<T: Encodable>(_ value: T, completion: (HTTPResponse) -> Void) {
        do {
            let data = try encoder.encode(value)
            completion(HTTPResponse(status: 200, statusText: "OK",
                                    headers: ["Content-Type": "application/json; charset=utf-8"],
                                    body: data))
        } catch {
            respondError(status: 500, text: "JSON 编码失败：\(error)", completion: completion)
        }
    }

    private func respondError(status: Int, text: String, completion: (HTTPResponse) -> Void) {
        completion(HTTPResponse(status: status,
                                statusText: status == 404 ? "Not Found" : "Bad Request",
                                headers: ["Content-Type": "text/plain; charset=utf-8"],
                                body: Data(text.utf8)))
    }

    private func loadHTML() -> Data {
        if let htmlCache { return htmlCache }
        if let url = Bundle.module.url(forResource: "index", withExtension: "html"),
           let data = try? Data(contentsOf: url) {
            htmlCache = data
            return data
        }
        return Data("<!doctype html><meta charset=utf-8><body>登记页资源缺失，请重新构建 App。</body>".utf8)
    }

    private static func encode(_ response: HTTPResponse) -> Data {
        var head = "HTTP/1.1 \(response.status) \(response.statusText)\r\n"
        var headers = response.headers
        headers["Content-Length"] = "\(response.body.count)"
        headers["Connection"] = "close"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var packet = Data(head.utf8)
        packet.append(response.body)
        return packet
    }

    private static func http500() -> Data {
        Data("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)
    }
}

private struct SubmitPayload: Encodable {
    let ok: Bool
    let receiptNo: String?
    let reason: String?
}

enum SocketIO {
    /// 读一次，返回 nil 表示对端关闭、出错或接收超时
    static func readSome(_ fd: Int32) -> Data? {
        var tmp = [UInt8](repeating: 0, count: 8192)
        let n = recv(fd, &tmp, tmp.count, 0)
        if n <= 0 { return nil }   // n<0 为出错/超时(EAGAIN)，n==0 为对端关闭
        return Data(tmp[0..<n])
    }

    /// 阻塞写完整段数据
    @discardableResult
    static func writeAll(_ fd: Int32, data: Data) -> Bool {
        data.withUnsafeBytes { raw in
            var sent = 0
            let total = data.count
            while sent < total {
                let n = send(fd, raw.baseAddress!.advanced(by: sent), total - sent, 0)
                if n <= 0 {
                    if errno == EINTR { continue }
                    return false
                }
                sent += n
            }
            return true
        }
    }
}

struct HTTPRequest {
    let method: String
    let path: String
    let queryItems: [String: String]
    let headers: [String: String]
    let body: Data
}

struct HTTPResponse {
    let status: Int
    let statusText: String
    let headers: [String: String]
    let body: Data
}

import Foundation

/// 巡检录入流水线。
///
/// 串行处理 CSV 行，在两个节点暂停等待人工：
/// 1. `.needsChoice` —— 同名设备匹配到多条，等人选；
/// 2. `.awaitingReview` —— 表单已填好，等人核对后点提交。
/// 提交拿到结果（成功/拒绝/失败）后自动继续下一条，不中断后续记录。
@MainActor
public final class InspectionPipeline: ObservableObject {

    @Published public private(set) var rowStates: [RowState]
    @Published public private(set) var currentLine: Int?
    @Published public private(set) var isRunning = false
    @Published public var lastError: String?

    private let api: InspectionAPI
    private let driver: FormDriver
    private let coordinator: StationDeviceCoordinator
    private var stations: [Station] = []
    private var deviceCache: [String: [DeviceOption]] = [:]
    private var pumpTask: Task<Void, Never>?

    public init(csvRows: [CSVRow], api: InspectionAPI, driver: FormDriver) {
        self.rowStates = csvRows.map { RowState(row: $0) }
        self.api = api
        self.driver = driver
        self.coordinator = StationDeviceCoordinator(api: api)
    }

    // MARK: - 对外操作

    public func start() {
        guard !isRunning else { return }
        isRunning = true
        pump()
    }

    /// 同名设备多条时，人工选定后继续
    public func chooseDevice(lineNumber: Int, device: DeviceOption) {
        guard let idx = index(of: lineNumber),
              case .needsChoice(let candidates) = rowStates[idx].status,
              candidates.contains(where: { $0.id == device.id }) else { return }
        Task { await self.fillAndPause(at: idx, device: device) }
    }

    /// 人工核对完成，提交当前行；提交后自动处理后续行
    public func confirmCurrent() {
        guard let line = currentLine, let idx = index(of: line),
              case .awaitingReview = rowStates[idx].status else { return }
        Task { await self.submitAndContinue(idx: idx) }
    }

    public func skip(lineNumber: Int) {
        guard let idx = index(of: lineNumber) else { return }
        rowStates[idx].status = .skipped
        if currentLine == lineNumber { currentLine = nil }
        pump()
    }

    public func retry(lineNumber: Int) {
        guard let idx = index(of: lineNumber) else { return }
        rowStates[idx].status = .pending
        if currentLine == lineNumber { currentLine = nil }
        pump()
    }

    public var currentRow: RowState? {
        guard let line = currentLine else { return nil }
        return rowStates.first { $0.row.lineNumber == line }
    }

    public var hasPendingWork: Bool {
        rowStates.contains { state in
            if case .pending = state.status { return true }
            return false
        }
    }

    // MARK: - 内部流水线

    private func pump() {
        pumpTask?.cancel()
        pumpTask = Task { [weak self] in
            guard let self else { return }
            self.isRunning = true
            while let idx = self.rowStates.firstIndex(where: { state in
                if case .pending = state.status { return true }
                return false
            }) {
                await self.processRow(idx)
                // 遇到人工节点（待选择 / 待核对）就停下等人
                if self.rowStates[idx].isHumanGate { break }
            }
            if !Task.isCancelled {
                self.isRunning = self.rowStates.contains { state in
                    switch state.status {
                    case .pending, .filling, .submitting: return true
                    default: return false
                    }
                }
            }
        }
    }

    private func processRow(_ idx: Int) async {
        let csvRow = rowStates[idx].row
        rowStates[idx].status = .filling
        currentLine = csvRow.lineNumber

        do {
            try await ensureStations()
        } catch {
            rowStates[idx].status = .failed(reason: "加载场站失败：\(error.localizedDescription)")
            return
        }

        guard let station = stations.first(where: { $0.name == csvRow.stationName }) else {
            rowStates[idx].status = .failed(reason: "场站不存在：\(csvRow.stationName)")
            return
        }

        let devices: [DeviceOption]
        if let cached = deviceCache[station.id] {
            devices = cached
        } else {
            do {
                let list = try await coordinator.devices(for: station)
                deviceCache[station.id] = list
                devices = list
            } catch RaceError.superseded {
                rowStates[idx].status = .failed(reason: "场站联动响应已过期，请重试本行")
                return
            } catch {
                rowStates[idx].status = .failed(reason: "加载设备失败：\(error.localizedDescription)")
                return
            }
        }

        switch DeviceMatcher.match(name: csvRow.deviceName, in: devices) {
        case .none:
            rowStates[idx].status = .failed(reason: "场站「\(station.name)」下找不到设备：\(csvRow.deviceName)")
        case .multiple(let candidates):
            // 停在这一行，等人选
            rowStates[idx].status = .needsChoice(candidates: candidates)
        case .unique(let device):
            await fillAndPause(at: idx, device: device)
        }
    }

    /// 把数据填进登记页，然后停在核对态
    private func fillAndPause(at idx: Int, device: DeviceOption) async {
        let csvRow = rowStates[idx].row
        guard let station = stations.first(where: { $0.name == csvRow.stationName }) else {
            rowStates[idx].status = .failed(reason: "场站不存在：\(csvRow.stationName)")
            pump()
            return
        }
        do {
            try await driver.fill(station: station, device: device,
                                  date: csvRow.date, result: csvRow.result)
            let form: FilledForm
            if let readback = try await driver.readBack() {
                let rbDevice = deviceCache[station.id]?.first { $0.id == readback.deviceId } ?? device
                form = FilledForm(station: station, device: rbDevice,
                                  date: readback.date, result: readback.result)
            } else {
                form = FilledForm(station: station, device: device,
                                  date: csvRow.date, result: csvRow.result)
            }
            rowStates[idx].status = .awaitingReview(form)
            currentLine = csvRow.lineNumber
        } catch {
            rowStates[idx].status = .failed(reason: "填写登记页失败：\(error.localizedDescription)")
            // 填写失败不阻断后续行
            pump()
        }
    }

    private func submitAndContinue(idx: Int) async {
        let csvRow = rowStates[idx].row
        rowStates[idx].status = .submitting
        do {
            let outcome = try await driver.submit()
            switch outcome {
            case .success(let receiptNo):
                rowStates[idx].status = .succeeded(receiptNo: receiptNo)
            case .rejected(let reason):
                // 拒绝原因从页面带回；本行停在拒绝态，后续记录继续
                rowStates[idx].status = .rejected(reason: reason)
            }
        } catch {
            rowStates[idx].status = .failed(reason: "提交请求失败：\(error.localizedDescription)")
        }
        if currentLine == csvRow.lineNumber { currentLine = nil }
        pump()
    }

    private func ensureStations() async throws {
        if stations.isEmpty {
            stations = try await api.fetchStations()
        }
    }

    private func index(of lineNumber: Int) -> Int? {
        rowStates.firstIndex { $0.row.lineNumber == lineNumber }
    }
}

private extension RowState {
    /// 人工闸门：到达这些状态必须暂停流水线
    var isHumanGate: Bool {
        switch status {
        case .needsChoice, .awaitingReview: return true
        default: return false
        }
    }
}

import SwiftUI
import InspectionCore

struct ContentView: View {
    @StateObject private var state = AppState()

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 420)
        } detail: {
            detail
        }
        .frame(minWidth: 1080, minHeight: 680)
        .task { await state.boot() }
        .onAppear {
            if let url = Bundle.main.url(forResource: "sample", withExtension: "csv") {
                state.sampleCSVURL = url
            }
        }
    }

    // MARK: 左侧：记录列表

    private var sidebar: some View {
        VStack(spacing: 0) {
            header
            if let notice = state.importNotice {
                Text(notice)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
            }
            if let pipeline = state.pipeline {
                summaryBar(pipeline)
                Divider()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(pipeline.rowStates) { row in
                            RowRow(row: row,
                                   isCurrent: pipeline.currentLine == row.row.lineNumber,
                                   isSelected: state.selectedLine == row.row.lineNumber)
                                .onTapGesture { state.selectedLine = row.row.lineNumber }
                        }
                    }
                    .padding(12)
                }
            } else {
                emptyState
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("巡检录入助手").font(.headline)
                Spacer()
                Button("导入 CSV") { state.importCSV() }
                    .buttonStyle(.borderedProminent)
            }
            if let port = state.serverPort {
                Label("本地登记服务运行中 · 端口 \(port)", systemImage: "point.connected")
                    .font(.caption).foregroundStyle(.secondary)
            } else if let err = state.serverError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.red)
            } else {
                Label("正在启动本地登记服务…", systemImage: "clock")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
    }

    private func summaryBar(_ pipeline: InspectionPipeline) -> some View {
        let s = state.summary
        return HStack(spacing: 6) {
            Chip(text: "共 \(s.total)", color: .secondary)
            Chip(text: "成功 \(s.succeeded)", color: .green)
            Chip(text: "拒绝 \(s.rejected)", color: .orange)
            Chip(text: "失败 \(s.failed)", color: .red)
            Chip(text: "待人 \(s.waitingHuman)", color: .yellow)
        }
        .font(.caption2)
        .padding(.horizontal, 14)
        .padding(.bottom, 10)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "tray")
                .font(.system(size: 40)).foregroundStyle(.tertiary)
            Text("导入包含「场站、设备名称、巡检日期、结果」四列的 CSV")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            if let url = state.sampleCSVURL {
                Button("载入示例 CSV") { state.loadCSV(url: url) }
                    .buttonStyle(.bordered)
            }
            Spacer()
        }
        .padding(24)
    }

    // MARK: 右侧：当前行核对 + 登记页

    private var detail: some View {
        VStack(spacing: 0) {
            if let pipeline = state.pipeline {
                ReviewPanel(pipeline: pipeline, state: state)
                Divider()
            }
            if let url = state.serverURL {
                WebViewContainer(url: url) { wv in
                    if state.webView == nil { state.webView = wv }
                }
            } else {
                VStack {
                    Spacer()
                    Text(state.serverError ?? "登记服务准备中…").foregroundStyle(.secondary)
                    Spacer()
                }
            }
        }
    }
}

// MARK: - 行徽标

private struct RowRow: View {
    let row: RowState
    let isCurrent: Bool
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("第 \(row.row.lineNumber) 行")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(row.status.label)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(badgeColor.opacity(0.15), in: Capsule())
                    .foregroundStyle(badgeColor)
            }
            Text("\(row.row.stationName) · \(row.row.deviceName)")
                .font(.subheadline.weight(isCurrent ? .semibold : .regular))
            Text("\(row.row.date) · \(row.row.result)")
                .font(.caption).foregroundStyle(.secondary)
            detailText
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(isSelected ? Color.accentColor.opacity(0.08) : Color.secondary.opacity(0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(isCurrent ? Color.accentColor : .clear, lineWidth: 1.5)
        )
    }

    @ViewBuilder private var detailText: some View {
        switch row.status {
        case .succeeded(let no):
            Text("回执号：\(no)").font(.caption2).foregroundStyle(.green)
        case .rejected(let reason), .failed(let reason):
            Text(reason).font(.caption2).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
        case .needsChoice:
            Text("同名设备多条，请在右侧选择").font(.caption2).foregroundStyle(.orange)
        case .awaitingReview:
            Text("已填入登记页，请核对后提交").font(.caption2).foregroundStyle(.blue)
        default:
            EmptyView()
        }
    }

    private var badgeColor: Color {
        switch row.status {
        case .succeeded: .green
        case .rejected: .orange
        case .failed: .red
        case .needsChoice, .awaitingReview: .yellow
        case .skipped: .secondary
        case .pending: .gray
        case .filling, .submitting: .blue
        }
    }
}

private struct Chip: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

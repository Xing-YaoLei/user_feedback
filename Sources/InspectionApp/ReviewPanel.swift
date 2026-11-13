import SwiftUI
import InspectionCore

/// 顶部操作区：根据当前行状态在「设备选择 / 核对提交 / 结果展示」之间切换
struct ReviewPanel: View {
    @ObservedObject var pipeline: InspectionPipeline
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let current = pipeline.currentRow {
                header(current)
                switch current.status {
                case .needsChoice(let candidates):
                    choiceView(candidates: candidates, line: current.row.lineNumber)
                case .awaitingReview(let form):
                    reviewView(form: form, line: current.row.lineNumber)
                case .submitting:
                    ProgressView("正在提交登记…").controlSize(.small)
                case .filling:
                    ProgressView("正在填入登记页…").controlSize(.small)
                case .succeeded(let no):
                    resultBanner(kind: .ok, title: "登记成功", detail: "回执号：\(no)")
                case .rejected(let reason):
                    resultBanner(kind: .warn, title: "登记被拒绝（后续记录继续处理）", detail: reason)
                case .failed(let reason):
                    resultBanner(kind: .error, title: "处理失败（后续记录继续处理）", detail: reason)
                case .skipped:
                    resultBanner(kind: .neutral, title: "本行已跳过", detail: "")
                case .pending:
                    Text("排队中…").foregroundStyle(.secondary)
                }
            } else {
                Text(pipeline.isRunning ? "流水线运行中，等待下一条…" : "没有进行中的记录")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func header(_ row: RowState) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text("第 \(row.row.lineNumber) 行").font(.headline)
            Text(row.status.label).font(.caption.weight(.semibold))
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(Color.accentColor.opacity(0.12), in: Capsule())
            Spacer()
            Button("跳过本行") { pipeline.skip(lineNumber: row.row.lineNumber) }
                .buttonStyle(.borderless)
        }
    }

    // MARK: 同名设备多条

    private func choiceView(candidates: [DeviceOption], line: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("「\(pipeline.rowStates.first(where: { $0.row.lineNumber == line })?.row.deviceName ?? "")」匹配到多台同名设备，请选择后继续：")
                .font(.callout)
            ForEach(candidates) { device in
                Button {
                    pipeline.chooseDevice(lineNumber: line, device: device)
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(device.name).font(.body.weight(.medium))
                            Text("安装位置：\(device.location) · 编号 \(device.id)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                    }
                    .padding(10)
                    .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: 核对态

    private func reviewView(form: FilledForm, line: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("以下内容已填入登记页，请在下方页面中核对（可直接在页面上修改），确认后提交：")
                .font(.callout).foregroundStyle(.secondary)
            LazyVGrid(columns: [GridItem(.fixed(90)), GridItem(.flexible()),
                                GridItem(.fixed(90)), GridItem(.flexible())],
                      alignment: .leading, spacing: 8) {
                Text("场站").foregroundStyle(.secondary)
                Text(form.station.name)
                Text("设备").foregroundStyle(.secondary)
                Text("\(form.device.name)（\(form.device.location)）")
                Text("巡检日期").foregroundStyle(.secondary)
                Text(form.date)
                Text("结果").foregroundStyle(.secondary)
                Text(form.result)
            }
            .font(.callout)
            HStack(spacing: 12) {
                Button("确认无误，提交登记") { pipeline.confirmCurrent() }
                    .buttonStyle(.borderedProminent)
                Button("跳过本行") { pipeline.skip(lineNumber: line) }
            }
        }
    }

    private enum BannerKind { case ok, warn, error, neutral }

    private func resultBanner(kind: BannerKind, title: String, detail: String) -> some View {
        let color: Color = {
            switch kind {
            case .ok: .green
            case .warn: .orange
            case .error: .red
            case .neutral: .secondary
            }
        }()
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: kind == .ok ? "checkmark.circle.fill" :
                    (kind == .neutral ? "minus.circle" : "xmark.octagon.fill"))
                .foregroundStyle(color)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.callout.weight(.semibold)).foregroundStyle(color)
                if !detail.isEmpty {
                    Text(detail).font(.callout).fixedSize(horizontal: false, vertical: true)
                }
                if case .rejected = pipeline.currentRow?.status {
                    Text("可在页面修改后重新提交，或点击下方重试本行。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if case .failed = pipeline.currentRow?.status {
                Button("重试本行") { pipeline.retry(lineNumber: pipeline.currentLine ?? 0) }
                    .buttonStyle(.bordered)
            }
        }
        .padding(12)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
    }
}

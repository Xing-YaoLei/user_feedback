import Foundation

public enum CSVError: Error, Equatable {
    case emptyFile
    case missingHeader(columns: [String])
    case columnCountMismatch(line: Int, expected: Int, actual: Int)
    case missingField(line: Int, field: String)
    case unreadableFile(path: String)
}

extension CSVError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .emptyFile:
            return "CSV 文件为空"
        case .missingHeader(let columns):
            return "表头缺少必需列：\(columns.joined(separator: "、"))。需要：场站、设备名称、巡检日期、结果"
        case .columnCountMismatch(let line, let expected, let actual):
            return "第 \(line) 行列数不符：应有 \(expected) 列，实际 \(actual) 列"
        case .missingField(let line, let field):
            return "第 \(line) 行「\(field)」为空"
        case .unreadableFile(let path):
            return "无法读取文件：\(path)"
        }
    }
}

/// 极简 RFC 4180 风格解析器：支持引号包裹、引号内逗号/换行、"" 转义、UTF-8 BOM
public enum CSVParser {

    public static let requiredHeaders = ["场站", "设备名称", "巡检日期", "结果"]

    public static func parse(url: URL) throws -> [CSVRow] {
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else {
            throw CSVError.unreadableFile(path: url.path)
        }
        return try parse(text: text)
    }

    public static func parse(text raw: String) throws -> [CSVRow] {
        var text = raw
        if text.first == "\u{FEFF}" { text.removeFirst() }

        var records: [(fields: [String], startLine: Int)] = []
        var fields: [String] = []
        var field = ""
        var inQuotes = false
        var line = 1                 // 当前扫描位置所在物理行
        var recordStartLine = 1
        var recordStarted = false
        let chars = Array(text)
        var i = 0

        func pushField() {
            fields.append(field)
            field = ""
        }
        func pushRecord() {
            pushField()
            records.append((fields, recordStartLine))
            fields = []
            recordStarted = false
        }

        while i < chars.count {
            let c = chars[i]
            if !recordStarted {
                recordStarted = true
                recordStartLine = line
            }
            if inQuotes {
                if c == "\"" {
                    if i + 1 < chars.count && chars[i + 1] == "\"" {
                        field.append("\"")
                        i += 2
                        continue
                    }
                    inQuotes = false
                    i += 1
                    continue
                }
                if c == "\n" { line += 1 }
                if c == "\r" && i + 1 < chars.count && chars[i + 1] == "\n" {
                    // CRLF 按一个换行计
                    field.append(c)
                    field.append("\n")
                    line += 1
                    i += 2
                    continue
                }
                field.append(c)
                i += 1
            } else {
                switch c {
                case "\"":
                    inQuotes = true
                    i += 1
                case ",":
                    pushField()
                    i += 1
                case "\r":
                    if i + 1 < chars.count && chars[i + 1] == "\n" {
                        i += 2
                    } else {
                        i += 1
                    }
                    line += 1
                    pushRecord()
                case "\n":
                    i += 1
                    line += 1
                    pushRecord()
                default:
                    field.append(c)
                    i += 1
                }
            }
        }
        if recordStarted || !field.isEmpty || !fields.isEmpty {
            pushRecord()
        }

        guard !records.isEmpty else { throw CSVError.emptyFile }

        let header = records[0].fields.map { $0.trimmingCharacters(in: .whitespaces) }
        var index: [String: Int] = [:]
        for (idx, name) in header.enumerated() where index[name] == nil {
            index[name] = idx
        }
        let missing = requiredHeaders.filter { index[$0] == nil }
        guard missing.isEmpty else { throw CSVError.missingHeader(columns: missing) }

        let colCount = header.count
        var rows: [CSVRow] = []

        for record in records.dropFirst() {
            let fields = record.fields
            // 跳过完全空白的行
            if fields.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty }) { continue }
            guard fields.count == colCount else {
                throw CSVError.columnCountMismatch(line: record.startLine,
                                                   expected: colCount,
                                                   actual: fields.count)
            }
            func value(_ name: String) -> String {
                fields[index[name]!].trimmingCharacters(in: .whitespaces)
            }
            let stationName = value("场站")
            let deviceName = value("设备名称")
            let date = value("巡检日期")
            let result = value("结果")
            if stationName.isEmpty { throw CSVError.missingField(line: record.startLine, field: "场站") }
            if deviceName.isEmpty { throw CSVError.missingField(line: record.startLine, field: "设备名称") }
            if date.isEmpty { throw CSVError.missingField(line: record.startLine, field: "巡检日期") }
            if result.isEmpty { throw CSVError.missingField(line: record.startLine, field: "结果") }

            rows.append(CSVRow(lineNumber: record.startLine,
                               stationName: stationName,
                               deviceName: deviceName,
                               date: date,
                               result: result))
        }
        return rows
    }
}

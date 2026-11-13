import Testing
@testable import InspectionCore

struct CSVParserTests {

    @Test func parsesBasicRowsWithPhysicalLineNumbers() throws {
        let text = """
        场站,设备名称,巡检日期,结果
        北京朝阳站,高压开关柜,2026-11-10,正常
        上海虹桥站,UPS电源柜,2026-11-11,异常
        """
        let rows = try CSVParser.parse(text: text)
        #expect(rows.count == 2)
        #expect(rows[0].lineNumber == 2)
        #expect(rows[0].stationName == "北京朝阳站")
        #expect(rows[0].deviceName == "高压开关柜")
        #expect(rows[1].lineNumber == 3)
    }

    @Test func skipsBlankLinesAndStripsBOM() throws {
        let text = "\u{FEFF}场站,设备名称,巡检日期,结果\n\n北京朝阳站,高压开关柜,2026-11-10,正常\n\n"
        let rows = try CSVParser.parse(text: text)
        #expect(rows.count == 1)
        #expect(rows[0].lineNumber == 3)
    }

    @Test func quotedFieldWithCommaAndNewlineKeepsLineNumber() throws {
        let text = """
        场站,设备名称,巡检日期,结果
        北京朝阳站,"带,引号的\n设备",2026-11-10,正常
        广州南站,空调主机,2026-11-12,正常
        """
        let rows = try CSVParser.parse(text: text)
        #expect(rows.count == 2)
        #expect(rows[0].deviceName == "带,引号的\n设备")
        #expect(rows[1].lineNumber == 4)
    }

    @Test func escapedQuote() throws {
        let text = "场站,设备名称,巡检日期,结果\n北京朝阳站,\"设备\"\"A\",2026-11-10,正常\n"
        let rows = try CSVParser.parse(text: text)
        #expect(rows[0].deviceName == "设备\"A")
    }

    @Test func missingHeader() {
        #expect(throws: CSVError.self) {
            _ = try CSVParser.parse(text: "场站,设备名称,结果\nA,B,正常")
        }
    }

    @Test func columnCountMismatch() {
        let text = "场站,设备名称,巡检日期,结果\n北京朝阳站,高压开关柜,2026-11-10\n"
        do {
            _ = try CSVParser.parse(text: text)
            Issue.record("应当抛错")
        } catch let error as CSVError {
            guard case .columnCountMismatch(let line, let expected, let actual) = error else {
                Issue.record("错误类型不符：\(error)")
                return
            }
            #expect(line == 2)
            #expect(expected == 4)
            #expect(actual == 3)
        } catch {
            Issue.record("错误类型不符：\(error)")
        }
    }

    @Test func emptyFieldReportedWithLine() {
        let text = "场站,设备名称,巡检日期,结果\n北京朝阳站,,2026-11-10,正常\n"
        do {
            _ = try CSVParser.parse(text: text)
            Issue.record("应当抛错")
        } catch let error as CSVError {
            guard case .missingField(let line, let field) = error else {
                Issue.record("错误类型不符：\(error)")
                return
            }
            #expect(line == 2)
            #expect(field == "设备名称")
        } catch {
            Issue.record("错误类型不符：\(error)")
        }
    }
}

import Foundation
import PilotVisualsKit
import Testing

struct VisualTreeTests {
    static let repository = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../..")
        .standardizedFileURL

    @Test func decodesEveryTreeTheKernelProduces() throws {
        let data = try Data(contentsOf: Self.repository.appending(path: "packages/protocol/fixtures/visual/conformance.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var trees = 0
        for item in try #require(fixture["cases"] as? [[String: Any]]) {
            for step in try #require(item["steps"] as? [[String: Any]]) {
                let json = try JSONSerialization.data(withJSONObject: try #require(step["tree"]))
                let tree = try VisualTree(VisualValue(json: json))
                #expect(tree.api == 1)
                trees += 1
            }
        }
        #expect(trees > 0)
    }

    @Test func runtimeIsTheKernelsByteForByte() throws {
        let runtime = try String(contentsOf: Self.repository.appending(path: "packages/artifacts/src/visual/runtime.js"),
                                 encoding: .utf8)
        #expect(VisualRuntime.source + "\n" == runtime)
    }

    @Test func newerAPIsAskForAnUpdate() {
        #expect(throws: VisualTree.DecodingError.unsupportedAPI(2)) {
            try VisualTree(["api": 2, "root": ["type": "future"]])
        }
        #expect(throws: VisualTree.DecodingError.invalid("unknown node type future at 0")) {
            try VisualTree(["api": 1, "root": ["type": "future"]])
        }
    }

    @Test func appliesTheSchemaDefaults() throws {
        let tree = try VisualTree([
            "api": 1,
            "root": ["type": "column", "children": [
                ["type": "text", "runs": [["text": "Hi"]]],
                ["type": "table", "columns": [["label": "Region"], ["label": "p95"]], "rows": [["eu", 120], ["us", nil]]],
                ["type": "chart", "kind": "bar", "x": ["a", "b"], "height": 200,
                 "series": [["name": "one", "values": [1, nil]], ["name": "two", "values": [2, 3], "color": "chart5"]]],
                ["type": "slider", "id": "0.3", "min": 0, "max": 10, "value": 4],
            ]],
        ])
        guard case .column(let column) = tree.root.kind, column.children.count == 4 else {
            Issue.record("expected a column of four")
            return
        }
        if case .text(let text) = column.children[0].kind {
            #expect(text.size == .md && text.weight == 400 && text.color == .text && text.align == .start)
            #expect(text.plain == "Hi")
        } else { Issue.record("expected text") }
        if case .table(let table) = column.children[1].kind {
            // Figures align to the end; an empty cell doesn't change that.
            #expect(table.columns.map(\.align) == [.start, .end])
            #expect(table.rows[1] == [.text("us"), .empty])
        } else { Issue.record("expected a table") }
        if case .chart(let chart) = column.children[2].kind {
            #expect(chart.series.map(\.color) == [.chart1, .chart5])
            #expect(chart.series[0].values == [1, nil])
            #expect(!chart.stacked)
        } else { Issue.record("expected a chart") }
        #expect(column.children[3].path == "0.3")
        #expect(column.children.map(\.id) == ["i:0", "i:1", "i:2", "i:3"])
    }

    @Test func fingerprintsChangeOnlyAlongTheChangedPath() throws {
        func tree(_ label: String) throws -> VisualTree {
            try VisualTree(["api": 1, "root": ["type": "column", "children": [
                ["type": "text", "key": "title", "runs": [["text": "Latency"]]],
                ["type": "row", "children": [["type": "button", "id": "0.1.0", "label": .string(label)]]],
            ]]])
        }
        let before = try tree("Run")
        let after = try tree("Stop")
        guard case .column(let old) = before.root.kind, case .column(let new) = after.root.kind else {
            Issue.record("expected columns")
            return
        }
        #expect(before.root.fingerprint != after.root.fingerprint)
        #expect(old.children[0].fingerprint == new.children[0].fingerprint)
        #expect(old.children[0].id == "k:title")
        #expect(old.children[1].fingerprint != new.children[1].fingerprint)
        #expect(try tree("Run") == before)
    }
}

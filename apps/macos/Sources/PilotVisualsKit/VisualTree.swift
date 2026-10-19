import Foundation

/// A visual's node tree, API 1, as packages/artifacts/src/visual/schema.ts defines it: {"api":1,"root":Node}.
/// The runtime validates every tree before it leaves the engine, so decoding only rejects shapes no runtime
/// produces, and tolerates absent optional props by applying the schema's defaults.
public struct VisualTree: Hashable, Sendable {
    /// The node tree API version this app renders.
    public static let supportedAPI = 1

    public var api: Int
    public var root: VisualNode

    public init(api: Int = VisualTree.supportedAPI, root: VisualNode) {
        self.api = api
        self.root = root
    }

    public enum DecodingError: Error, Equatable {
        /// A newer API version: the app shows an update hint.
        case unsupportedAPI(Int)
        case invalid(String)
    }

    public init(_ value: VisualValue) throws {
        guard let api = value["api"]?.numberValue.map({ Int($0) }) else { throw DecodingError.invalid("api") }
        guard api == Self.supportedAPI else { throw DecodingError.unsupportedAPI(api) }
        guard let root = value["root"] else { throw DecodingError.invalid("root") }
        self.api = api
        self.root = try VisualNode(root, path: "0")
    }
}

public enum VisualColor: String, CaseIterable, Hashable, Sendable {
    case text, muted, accent, success, warning, danger, border, chart1, chart2, chart3, chart4, chart5, chart6

    /// The chart palette, in the order series without a color take it.
    public static let palette: [VisualColor] = [.chart1, .chart2, .chart3, .chart4, .chart5, .chart6]
}

public enum VisualTextSize: String, Hashable, Sendable {
    case xs, sm, md, lg, xl
}

public enum VisualAlignment: String, Hashable, Sendable {
    case start, center, end
}

/// One run of text with its own style.
public struct VisualRun: Hashable, Sendable {
    public var text: String
    public var weight: Int?
    public var color: VisualColor?
    public var mono: Bool?
    public var italic: Bool?
    public var strike: Bool?

    public init(text: String, weight: Int? = nil, color: VisualColor? = nil, mono: Bool? = nil, italic: Bool? = nil,
                strike: Bool? = nil) {
        self.text = text
        self.weight = weight
        self.color = color
        self.mono = mono
        self.italic = italic
        self.strike = strike
    }
}

/// A cell of a table: text, a number, or empty.
public enum VisualCell: Hashable, Sendable {
    case text(String)
    case number(Double)
    case empty
}

/// A chart's x entry: a category label, or a number for scatter charts.
public enum VisualChartX: Hashable, Sendable {
    case label(String)
    case number(Double)
}

public struct VisualNode: Hashable, Sendable, Identifiable {
    /// Identity among siblings: the node's key, or its index when it has none.
    public let id: String
    /// Path of child indices from the root ("0", "0.2.1"): a control's event id.
    public let path: String
    public let kind: Kind
    /// Hash of the whole subtree, computed once when decoding, so views can skip unchanged subtrees cheaply.
    public let fingerprint: Int

    public init(id: String, path: String, kind: Kind) {
        self.id = id
        self.path = path
        self.kind = kind
        var hasher = Hasher()
        hasher.combine(id)
        hasher.combine(kind)
        fingerprint = hasher.finalize()
    }

    public static func == (lhs: VisualNode, rhs: VisualNode) -> Bool {
        lhs.fingerprint == rhs.fingerprint && lhs.id == rhs.id && lhs.path == rhs.path && lhs.kind == rhs.kind
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(fingerprint)
    }

    public indirect enum Kind: Hashable, Sendable {
        case column(Column)
        case row(Row)
        case grid(Grid)
        case text(Text)
        case stat(Stat)
        case table(Table)
        case chart(Chart)
        case rule
        case space(Double?)
        case link(label: String, href: URL)
        case tabs(Tabs)
        case toggle(Toggle)
        case slider(Slider)
        case button(Button)
        case canvas(Canvas)
        case shader(Shader)
    }

    public struct Column: Hashable, Sendable {
        public var gap: Double?
        public var align: VisualAlignment
        public var children: [VisualNode]
    }

    public struct Row: Hashable, Sendable {
        public enum Align: String, Hashable, Sendable { case start, center, end, baseline }
        public enum Justify: String, Hashable, Sendable { case start, center, end, between }
        public var gap: Double?
        public var align: Align
        public var justify: Justify
        public var children: [VisualNode]
    }

    public struct Grid: Hashable, Sendable {
        public var columns: Int
        public var gap: Double?
        public var children: [VisualNode]
    }

    public struct Text: Hashable, Sendable {
        public var runs: [VisualRun]
        public var size: VisualTextSize
        public var weight: Int
        public var color: VisualColor
        public var mono: Bool
        public var italic: Bool
        public var align: VisualAlignment
        public var lines: Int?

        /// The text without styles, for accessibility and copying.
        public var plain: String { runs.map(\.text).joined() }
    }

    public struct Stat: Hashable, Sendable {
        public enum Tone: String, Hashable, Sendable { case neutral, success, warning, danger }
        public var label: String
        public var value: String
        public var unit: String?
        public var delta: String?
        public var tone: Tone
        public var caption: String?
    }

    public struct Table: Hashable, Sendable {
        public struct Column: Hashable, Sendable {
            public var label: String
            public var align: VisualAlignment
        }

        public var columns: [Column]
        public var rows: [[VisualCell]]
    }

    public struct Chart: Hashable, Sendable {
        public enum Kind: String, Hashable, Sendable { case bar, line, area, scatter }
        public struct Series: Hashable, Sendable {
            public var name: String
            public var values: [Double?]
            public var color: VisualColor
        }

        public var kind: Kind
        public var x: [VisualChartX]
        public var series: [Series]
        public var height: Double
        public var unit: String?
        public var stacked: Bool
        public var yMin: Double?
        public var yMax: Double?
        public var xLabel: String?
        public var yLabel: String?
    }

    public struct Tabs: Hashable, Sendable {
        public struct Option: Hashable, Sendable {
            public var value: String
            public var label: String
        }

        public var options: [Option]
        public var value: String
    }

    public struct Toggle: Hashable, Sendable {
        public var label: String
        public var value: Bool
    }

    public struct Slider: Hashable, Sendable {
        public var label: String?
        public var min: Double
        public var max: Double
        public var step: Double?
        public var value: Double
        public var unit: String?
    }

    public struct Button: Hashable, Sendable {
        public var label: String
        public var primary: Bool
        public var disabled: Bool
    }

    /// A 2D drawing as wide as the column. Its commands come from the engine's draw(), not the tree.
    public struct Canvas: Hashable, Sendable {
        public var height: Double
        public var animated: Bool
        public var label: String?

        public init(height: Double, animated: Bool, label: String?) {
            self.height = height
            self.animated = animated
            self.label = label
        }
    }

    /// A fragment shader as wide as the column. Its Metal comes from the artifact revision, found by glsl and the
    /// input names; input values change with state and need no new translation.
    public struct Shader: Hashable, Sendable {
        public struct Input: Hashable, Sendable {
            public var name: String
            public var value: Double

            public init(name: String, value: Double) {
                self.name = name
                self.value = value
            }
        }

        public var height: Double
        public var animated: Bool
        public var label: String?
        public var glsl: String
        /// In name order, as the uniforms are laid out.
        public var inputs: [Input]

        public init(height: Double, animated: Bool, label: String?, glsl: String, inputs: [Input]) {
            self.height = height
            self.animated = animated
            self.label = label
            self.glsl = glsl
            self.inputs = inputs
        }

        /// The key of its translation: input names, then the GLSL, as the kernel stores it.
        public var translationKey: String { Self.translationKey(glsl: glsl, inputs: inputs.map(\.name)) }

        public static func translationKey(glsl: String, inputs: [String]) -> String {
            inputs.joined(separator: ",") + "\n" + glsl
        }
    }
}

// MARK: - Decoding

extension VisualNode {
    init(_ value: VisualValue, path: String, index: Int? = nil) throws {
        guard let object = value.objectValue, let type = object["type"]?.stringValue else {
            throw VisualTree.DecodingError.invalid("node at \(path)")
        }
        let key = object["key"].flatMap(Self.text)
        let id = key.map { "k:" + $0 } ?? "i:\(index ?? 0)"
        func children() throws -> [VisualNode] {
            guard let items = object["children"]?.arrayValue else { return [] }
            return try items.enumerated().map { try VisualNode($1, path: "\(path).\($0)", index: $0) }
        }
        func string(_ name: String) -> String? { object[name].flatMap(Self.text) }
        func number(_ name: String) -> Double? { object[name]?.numberValue }
        func flag(_ name: String) -> Bool? { object[name]?.boolValue }
        func color(_ name: String) -> VisualColor? { string(name).flatMap(VisualColor.init(rawValue:)) }
        func align(_ name: String) -> VisualAlignment? { string(name).flatMap(VisualAlignment.init(rawValue:)) }
        // Controls carry the runtime's own path; events go to it.
        let controlPath = string("id") ?? path

        let kind: Kind
        switch type {
        case "column":
            kind = .column(Column(gap: number("gap"), align: align("align") ?? .start, children: try children()))
        case "row":
            kind = .row(Row(gap: number("gap"), align: string("align").flatMap(Row.Align.init(rawValue:)) ?? .center,
                            justify: string("justify").flatMap(Row.Justify.init(rawValue:)) ?? .start,
                            children: try children()))
        case "grid":
            kind = .grid(Grid(columns: max(1, min(12, Int(number("columns") ?? 1))), gap: number("gap"),
                              children: try children()))
        case "text":
            let runs = (object["runs"]?.arrayValue ?? []).compactMap { run -> VisualRun? in
                guard let text = run["text"]?.stringValue else { return nil }
                return VisualRun(text: text, weight: run["weight"]?.numberValue.map { Int($0) },
                                 color: run["color"]?.stringValue.flatMap(VisualColor.init(rawValue:)),
                                 mono: run["mono"]?.boolValue, italic: run["italic"]?.boolValue,
                                 strike: run["strike"]?.boolValue)
            }
            kind = .text(Text(runs: runs, size: string("size").flatMap(VisualTextSize.init(rawValue:)) ?? .md,
                              weight: number("weight").map { Int($0) } ?? 400, color: color("color") ?? .text,
                              mono: flag("mono") ?? false, italic: flag("italic") ?? false,
                              align: align("align") ?? .start, lines: number("lines").map { Int($0) }))
        case "stat":
            kind = .stat(Stat(label: string("label") ?? "", value: string("value") ?? "", unit: string("unit"),
                              delta: string("delta"),
                              tone: string("tone").flatMap(Stat.Tone.init(rawValue:)) ?? .neutral,
                              caption: string("caption")))
        case "table":
            let rows: [[VisualCell]] = (object["rows"]?.arrayValue ?? []).map { row in
                (row.arrayValue ?? []).map { cell in
                    switch cell {
                    case .string(let text): .text(text)
                    case .number(let number): .number(number)
                    default: .empty
                    }
                }
            }
            let columns = (object["columns"]?.arrayValue ?? []).enumerated().map { index, column in
                // Default: end when every cell in the column is a number, else start. Empty cells are gaps in a
                // column of figures, so they don't count either way.
                let cells = rows.map { index < $0.count ? $0[index] : .empty }.filter { $0 != .empty }
                let numeric = !cells.isEmpty && cells.allSatisfy { if case .number = $0 { true } else { false } }
                return Table.Column(label: column["label"].flatMap(Self.text) ?? "",
                                    align: column["align"]?.stringValue.flatMap(VisualAlignment.init(rawValue:))
                                        ?? (numeric ? .end : .start))
            }
            kind = .table(Table(columns: columns, rows: rows))
        case "chart":
            let items = object["series"]?.arrayValue ?? []
            let chosen = items.map { $0["color"]?.stringValue.flatMap(VisualColor.init(rawValue:)) }
            // Series without a color take chart1...chart6 in order, skipping colors other series chose.
            var palette = VisualColor.palette.filter { !chosen.contains($0) }
            if palette.isEmpty { palette = VisualColor.palette }
            var next = 0
            let series = items.enumerated().map { index, item in
                let color = chosen[index] ?? {
                    defer { next += 1 }
                    return palette[next % palette.count]
                }()
                return Chart.Series(name: item["name"].flatMap(Self.text) ?? "",
                                    values: (item["values"]?.arrayValue ?? []).map(\.numberValue), color: color)
            }
            let x: [VisualChartX] = (object["x"]?.arrayValue ?? []).map { entry in
                if case .number(let number) = entry { return .number(number) }
                return .label(Self.text(entry) ?? "")
            }
            kind = .chart(Chart(kind: string("kind").flatMap(Chart.Kind.init(rawValue:)) ?? .bar, x: x,
                                series: series, height: number("height") ?? 220, unit: string("unit"),
                                stacked: flag("stacked") ?? false, yMin: number("yMin"), yMax: number("yMax"),
                                xLabel: string("xLabel"), yLabel: string("yLabel")))
        case "rule":
            kind = .rule
        case "space":
            kind = .space(number("size"))
        case "link":
            guard let href = string("href"), let url = URL(string: href),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
                throw VisualTree.DecodingError.invalid("link at \(path)")
            }
            kind = .link(label: string("label") ?? href, href: url)
        case "tabs":
            let options = (object["options"]?.arrayValue ?? []).compactMap { option -> Tabs.Option? in
                guard let value = option["value"].flatMap(Self.text) else { return nil }
                return Tabs.Option(value: value, label: option["label"].flatMap(Self.text) ?? value)
            }
            kind = .tabs(Tabs(options: options, value: string("value") ?? options.first?.value ?? ""))
        case "toggle":
            kind = .toggle(Toggle(label: string("label") ?? "", value: flag("value") ?? false))
        case "slider":
            let lower = number("min") ?? 0
            let upper = max(lower, number("max") ?? lower)
            kind = .slider(Slider(label: string("label"), min: lower, max: upper,
                                  step: number("step").flatMap { $0 > 0 ? $0 : nil },
                                  value: Swift.min(upper, Swift.max(lower, number("value") ?? lower)),
                                  unit: string("unit")))
        case "button":
            kind = .button(Button(label: string("label") ?? "", primary: flag("primary") ?? false,
                                  disabled: flag("disabled") ?? false))
        case "canvas":
            kind = .canvas(Canvas(height: Swift.max(24, Swift.min(600, number("height") ?? 240)),
                                  animated: flag("animated") ?? false, label: string("label")))
        case "shader":
            guard let glsl = object["glsl"]?.stringValue else { throw VisualTree.DecodingError.invalid("shader at \(path)") }
            let inputs = (object["inputs"]?.objectValue?.entries ?? [])
                .compactMap { entry in entry.value.numberValue.map { Shader.Input(name: entry.key, value: $0) } }
                .sorted { $0.name < $1.name }
            kind = .shader(Shader(height: Swift.max(24, Swift.min(600, number("height") ?? 240)),
                                  animated: flag("animated") ?? true, label: string("label"), glsl: glsl,
                                  inputs: inputs))
        default:
            throw VisualTree.DecodingError.invalid("unknown node type \(type) at \(path)")
        }
        self.init(id: id, path: controlPath, kind: kind)
    }

    /// Strings, and numbers as JavaScript prints them, for labels.
    static func text(_ value: VisualValue) -> String? {
        switch value {
        case .string(let text): return text
        case .number(let number): return VisualValue.formatNumber(number)
        default: return nil
        }
    }
}

extension VisualValue {
    /// A number as a label: integers without a fraction, others in their shortest form.
    public static func label(_ number: Double) -> String {
        formatNumber(number)
    }
}

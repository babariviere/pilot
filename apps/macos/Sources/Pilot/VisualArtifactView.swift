import AppKit
import Charts
import PilotCore
import PilotVisualsKit
import SwiftUI

// Native agent visuals (docs/native-visuals.md): the sandboxed visual service runs the agent's function and returns
// a node tree; these views draw it with Theme tokens, Swift Charts and Pilot's controls, and send control events back.

/// Reader state and the last tree of each visual revision. State persists across launches, bounded; trees stay in
/// memory so a visual scrolled back into view draws at once while its engine restarts.
@MainActor
enum VisualReaderMemory {
    private static var states = VisualStateMemory()
    private static var trees: [String: VisualTree] = [:]
    private static var treeOrder: [String] = []
    static let treeLimit = 32
    private static var persistence: UserDefaults?
    private static var saveTask: Task<Void, Never>?
    static let defaultsKey = "PilotVisualReaderState"

    static func state(for key: String) -> Data? { states[key].map { Data($0.utf8) } }

    static func tree(for key: String) -> VisualTree? { trees[key] }

    static func store(state: Data, tree: VisualTree, for key: String) {
        if trees.updateValue(tree, forKey: key) != nil { treeOrder.removeAll { $0 == key } }
        treeOrder.append(key)
        while treeOrder.count > treeLimit { trees[treeOrder.removeFirst()] = nil }
        guard states.store(String(decoding: state, as: UTF8.self), for: key), persistence != nil else { return }
        scheduleSave()
    }

    /// Restore state saved by an earlier launch and keep saving. Tests never call this.
    static func enablePersistence(_ defaults: UserDefaults = .standard) {
        persistence = defaults
        guard let data = defaults.data(forKey: defaultsKey),
              let saved = try? JSONDecoder().decode([VisualStateMemory.Entry].self, from: data) else { return }
        states = VisualStateMemory(entries: saved + states.entries)
    }

    private static func scheduleSave() {
        guard saveTask == nil else { return }
        saveTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            flush()
        }
    }

    static func flush() {
        saveTask?.cancel()
        saveTask = nil
        guard let persistence, let data = try? JSONEncoder().encode(states.entries) else { return }
        persistence.set(data, forKey: defaultsKey)
    }
}

/// One live visual: its engine in the visual service, its latest tree, and the events the reader sends. Discrete
/// events (tabs, toggles, buttons) run in order; slider drags coalesce to one handler per display frame, and never
/// more than one request is in flight.
@MainActor
final class VisualArtifactModel: ObservableObject {
    @Published private(set) var tree: VisualTree?
    @Published private(set) var failure: VisualFailure?
    @Published private(set) var unsupportedAPI: Int?
    @Published private(set) var loading = false
    /// Counts rendered trees, so canvases redraw when state their draw functions read may have changed.
    @Published private(set) var frames = 0

    private let engine: VisualEngineClient
    private let instance = "visual-\(UUID().uuidString)"
    private var request: VisualLoadRequest?
    private var memoryKey = ""
    private var started = false
    private var busy = false
    private var queued: [(id: String, value: VisualValue)] = []
    private var slider: (id: String, value: Double)?
    private lazy var pacer = DisplayFramePacer { [weak self] in self?.flushSlider() }
    /// Each canvas's last drawing, by path: shown at once when a canvas view is recreated, and in screenshots.
    private var drawings: [String: VisualDrawing] = [:]
    /// The revision's Metal translations, by input names and GLSL.
    private var shaders: [String: ArtifactVisualShader] = [:]

    init(engine: VisualEngineClient = .shared) {
        self.engine = engine
    }

    deinit {
        let engine = engine
        let instance = instance
        Task { await engine.release(instance) }
    }

    func start(revision: ArtifactRevision, memoryKey: String) {
        guard !started else { return }
        started = true
        self.memoryKey = memoryKey
        for shader in revision.visual?.shaders ?? [] {
            shaders[VisualNode.Shader.translationKey(glsl: shader.glsl, inputs: shader.inputs)] = shader
        }
        if let api = revision.visual?.api, api != VisualTree.supportedAPI {
            unsupportedAPI = api
            return
        }
        // The last tree draws at once; the engine starts again from the saved state.
        tree = VisualReaderMemory.tree(for: memoryKey)
        request = VisualLoadRequest(runtime: VisualRuntime.source, source: revision.source,
                                    data: revision.visualDataJSON, seed: revision.id, now: revision.createdAt)
        load()
    }

    func retry() {
        failure = nil
        load()
    }

    /// A discrete control event: tabs, toggles and buttons.
    func send(_ id: String, _ value: VisualValue) {
        queued.append((id, value))
        pump()
    }

    /// A slider position. Only the latest one per display frame reaches the handler.
    func slide(_ id: String, to value: Double) {
        slider = (id, value)
        pump()
    }

    /// Runs a canvas's draw function in the visual service.
    func draw(_ request: VisualDrawRequest) async -> Result<VisualDrawing, VisualFailure> {
        await engine.draw(instance, request)
    }

    func drawing(for path: String) -> VisualDrawing? { drawings[path] }

    func remember(_ drawing: VisualDrawing, for path: String) {
        drawings[path] = drawing
    }

    /// The Metal translation of a shader node, published with the revision.
    func translation(for shader: VisualNode.Shader) -> ArtifactVisualShader? {
        shaders[shader.translationKey]
    }

    private func load() {
        guard var request, !busy else { return }
        request.state = VisualReaderMemory.state(for: memoryKey)
        let loadRequest = request
        busy = true
        loading = true
        let engine = engine
        let instance = instance
        Task { [weak self] in
            let result = await engine.load(instance, loadRequest)
            await self?.finish(result)
        }
    }

    private func pump() {
        guard !busy, tree != nil else { return }
        if !queued.isEmpty {
            let event = queued.removeFirst()
            perform(event.id, event.value)
        } else if slider != nil {
            pacer.request()
        }
    }

    private func flushSlider() {
        guard !busy, let slider else { return }
        self.slider = nil
        perform(slider.id, .number(slider.value))
    }

    private func perform(_ id: String, _ value: VisualValue) {
        busy = true
        let engine = engine
        let instance = instance
        Task { [weak self] in
            let result = await engine.event(instance, handler: id, value: value)
            await self?.finish(result)
        }
    }

    private func finish(_ result: Result<VisualFrame, VisualFailure>) async {
        switch result {
        case .success(let frame):
            // Decoding a large tree stays off the main thread.
            let decoded = await Task.detached(priority: .userInitiated) {
                Result { try VisualTree(frame.tree) }
            }.value
            switch decoded {
            case .success(let tree):
                if tree != self.tree { self.tree = tree }
                failure = nil
                frames += 1
                VisualReaderMemory.store(state: frame.state, tree: tree, for: memoryKey)
            case .failure(VisualTree.DecodingError.unsupportedAPI(let api)):
                unsupportedAPI = api
            case .failure:
                failure = .invalidReply
            }
        case .failure(let failure):
            self.failure = failure
        }
        busy = false
        loading = false
        pump()
    }
}

/// A visual in the chat or the viewer. Inline, it hugs the tree's height and scrolls inside above the card's ceiling;
/// the card remembers the height, so the row keeps its size when it is recreated.
struct VisualArtifactView: View {
    let revision: ArtifactRevision
    let memoryKey: String
    var inline = true
    @ObservedObject var render: ArtifactRenderState
    @StateObject private var model = VisualArtifactModel()
    @State private var contentHeight: CGFloat?
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        Group {
            if model.unsupportedAPI != nil {
                VisualNotice(text: "This visual needs a newer version of Pilot. Update Pilot to view it.")
            } else if let tree = model.tree {
                content(tree)
            } else if let failure = model.failure {
                VisualFailureLine(failure: failure, retry: model.retry)
            } else {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 64)
            }
        }
        .onAppear {
            model.start(revision: revision, memoryKey: memoryKey)
            render.loading = false
            render.error = nil
            render.nativeSnapshot = { [weak model = model, fonts] in
                guard let tree = model?.tree, let model else { throw ClientError("The visual is not ready") }
                return try VisualSnapshot.png(tree: tree, model: model, fonts: fonts)
            }
        }
    }

    @ViewBuilder
    private func content(_ tree: VisualTree) -> some View {
        let tall = inline && (contentHeight ?? 0) > ArtifactViewerLayout.inlineMaxHeight
        let drawn = VStack(alignment: .leading, spacing: 8) {
            VisualNodeView(node: tree.root, model: model).equatable()
            if let failure = model.failure {
                VisualFailureLine(failure: failure, retry: model.retry)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { height in
            guard height > 0, height != contentHeight else { return }
            contentHeight = height
            render.contentSize = CGSize(width: ArtifactViewerLayout.inlineColumnWidth, height: height.rounded(.up))
        }
        if tall || !inline {
            ScrollView(.vertical) { drawn.padding(inline ? 0 : 16) }
        } else {
            drawn.frame(maxHeight: .infinity, alignment: .top)
        }
    }
}

/// A short muted line, for example the update hint.
private struct VisualNotice: View {
    let text: String

    var body: some View {
        Text(text).font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
    }
}

/// The visual's error and, when it may help, a retry: a handler that threw, a limit, or the service stopping.
struct VisualFailureLine: View {
    let failure: VisualFailure
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            PilotSymbol(PilotIcon.warning, context: .row).foregroundStyle(Theme.error)
            Text(failure.message).font(.pilot(.label, design: .monospaced)).foregroundStyle(Theme.foreground)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Reload", action: retry).controlSize(.small)
        }
        .padding(10)
        .card(radius: Theme.Radius.control)
    }
}

/// Renders one node. Equal when the subtree's fingerprint is, so a change re-renders only the nodes on its path.
struct VisualNodeView: View, Equatable {
    let node: VisualNode
    let model: VisualArtifactModel
    @Environment(\.visualAxis) private var axis
    @Environment(\.visualStill) private var still

    nonisolated static func == (lhs: VisualNodeView, rhs: VisualNodeView) -> Bool {
        lhs.node.fingerprint == rhs.node.fingerprint && lhs.node.id == rhs.node.id && lhs.node.path == rhs.node.path
    }

    var body: some View {
        switch node.kind {
        case .column(let column):
            VStack(alignment: column.align.horizontal, spacing: column.gap ?? 8) {
                children(column.children)
            }
            .environment(\.visualAxis, .vertical)
            .frame(maxWidth: .infinity, alignment: column.align.frame)
        case .row(let row):
            HStack(alignment: row.align.vertical, spacing: row.gap ?? 8) {
                ForEach(row.children) { child in
                    if row.justify == .between, child.id != row.children.first?.id { VisualFlexibleSpace() }
                    VisualNodeView(node: child, model: model).equatable()
                }
            }
            .environment(\.visualAxis, .horizontal)
            .frame(maxWidth: .infinity, alignment: row.justify.frame)
        case .grid(let grid):
            // Equal columns, filled row by row. Not lazy: a visual is at most a few thousand nodes, and lazy grids
            // report no height outside a scroll view.
            Grid(alignment: .topLeading, horizontalSpacing: grid.gap ?? 8, verticalSpacing: grid.gap ?? 8) {
                ForEach(Array(stride(from: 0, to: grid.children.count, by: grid.columns)), id: \.self) { start in
                    GridRow {
                        ForEach(start..<min(start + grid.columns, grid.children.count), id: \.self) { index in
                            VisualNodeView(node: grid.children[index], model: model).equatable()
                                .frame(maxWidth: .infinity, alignment: .topLeading)
                        }
                        ForEach(0..<max(0, start + grid.columns - grid.children.count), id: \.self) { _ in
                            Color.clear.frame(maxWidth: .infinity, maxHeight: 0)
                        }
                    }
                }
            }
        case .text(let text):
            VisualTextView(text: text)
        case .stat(let stat):
            VisualStatView(stat: stat)
        case .table(let table):
            VisualTableView(table: table)
        case .chart(let chart):
            VisualChartView(chart: chart)
        case .rule:
            Divider()
        case .space(let size):
            // Space runs along the enclosing stack. Flexible space pushes row children apart; columns hug their
            // content, so there it adds nothing.
            if let size {
                Color.clear.frame(width: axis == .horizontal ? size : 0, height: axis == .horizontal ? 0 : size)
            } else if axis == .horizontal {
                VisualFlexibleSpace()
            }
        case .link(let label, let href):
            Link(destination: href) {
                Text(label).foregroundStyle(Theme.accent)
            }
            .help(href.absoluteString)
        case .tabs(let tabs):
            Picker("", selection: Binding(get: { tabs.value }, set: { model.send(node.path, .string($0)) })) {
                ForEach(tabs.options, id: \.value) { option in Text(option.label).tag(option.value) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
        case .toggle(let toggle):
            Toggle(toggle.label, isOn: Binding(get: { toggle.value }, set: { model.send(node.path, .bool($0)) }))
                .toggleStyle(.switch)
                .controlSize(.small)
        case .slider(let slider):
            VisualSliderView(slider: slider, path: node.path, model: model)
        case .button(let button):
            VisualButtonView(button: button) { model.send(node.path, nil) }
        case .canvas(let canvas):
            if still {
                VisualCanvasStill(canvas: canvas, drawing: model.drawing(for: node.path))
            } else {
                VisualCanvasView(canvas: canvas, path: node.path, model: model)
            }
        case .shader(let shader):
            if still {
                VisualShaderStill(shader: shader, model: model)
            } else {
                VisualShaderView(shader: shader, model: model)
            }
        }
    }

    private func children(_ nodes: [VisualNode]) -> some View {
        ForEach(nodes) { child in VisualNodeView(node: child, model: model).equatable() }
    }
}

/// Horizontal room only. A zero height keeps it from moving a baseline-aligned row's text.
private struct VisualFlexibleSpace: View {
    var body: some View {
        Spacer(minLength: 0).frame(height: 0)
    }
}

private struct VisualAxisKey: EnvironmentKey {
    static let defaultValue = Axis.vertical
}

private struct VisualStillKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// The axis of the stack a visual node sits in.
    fileprivate var visualAxis: Axis {
        get { self[VisualAxisKey.self] }
        set { self[VisualAxisKey.self] = newValue }
    }

    /// Draws canvases from their last drawing instead of running them, for screenshots.
    fileprivate var visualStill: Bool {
        get { self[VisualStillKey.self] }
        set { self[VisualStillKey.self] = newValue }
    }
}

private struct VisualButtonView: View {
    let button: VisualNode.Button
    let action: () -> Void

    var body: some View {
        if button.primary {
            Button(button.label, action: action).buttonStyle(.borderedProminent).disabled(button.disabled)
        } else {
            Button(button.label, action: action).buttonStyle(.bordered).disabled(button.disabled)
        }
    }
}

/// Follows the drag locally and sends positions through the model, which coalesces them per display frame. The
/// tree's value (clamped and snapped by the runtime) takes over when the drag ends.
private struct VisualSliderView: View {
    let slider: VisualNode.Slider
    let path: String
    let model: VisualArtifactModel
    @State private var dragging: Double?
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        let value = dragging ?? slider.value
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                if let label = slider.label { Text(label) }
                Spacer(minLength: 8)
                Text(VisualValue.label(value) + (slider.unit.map { " " + $0 } ?? ""))
                    .monospacedDigit()
                    .foregroundStyle(Theme.mutedForeground)
            }
            .font(fonts.chat(fonts.chatSize - 1.5))
            let binding = Binding<Double>(get: { dragging ?? slider.value }, set: { position in
                dragging = position
                model.slide(path, to: position)
            })
            Group {
                if let step = slider.step, slider.max > slider.min {
                    Slider(value: binding, in: slider.min...slider.max, step: step) { editing in
                        if !editing { dragging = nil }
                    }
                } else {
                    Slider(value: binding, in: slider.min...max(slider.max, slider.min + .ulpOfOne)) { editing in
                        if !editing { dragging = nil }
                    }
                }
            }
            .controlSize(.small)
        }
        .frame(maxWidth: 320, alignment: .leading)
    }
}

// MARK: - Text

extension VisualTextSize {
    /// Steps on the chat's type scale.
    func points(_ fonts: PilotFonts) -> Double {
        switch self {
        case .xs: fonts.chatSize - 3
        case .sm: fonts.chatSize - 1.5
        case .md: fonts.chatSize
        case .lg: fonts.chatSize + 3
        case .xl: fonts.chatSize + 8
        }
    }
}

extension VisualColor {
    var color: Color {
        switch self {
        case .text: Theme.foreground
        case .muted: Theme.mutedForeground
        case .accent: Theme.accent
        case .success: Theme.successInk
        case .warning: Theme.warningInk
        case .danger: Theme.error
        case .border: Theme.border
        case .chart1: Theme.chart1
        case .chart2: Theme.chart2
        case .chart3: Theme.chart3
        case .chart4: Theme.chart4
        case .chart5: Theme.chart5
        case .chart6: Theme.chart6
        }
    }
}

extension VisualAlignment {
    var horizontal: HorizontalAlignment {
        switch self {
        case .start: .leading
        case .center: .center
        case .end: .trailing
        }
    }

    var frame: Alignment {
        switch self {
        case .start: .leading
        case .center: .center
        case .end: .trailing
        }
    }

    var text: TextAlignment {
        switch self {
        case .start: .leading
        case .center: .center
        case .end: .trailing
        }
    }
}

extension VisualNode.Row.Align {
    var vertical: VerticalAlignment {
        switch self {
        case .start: .top
        case .center: .center
        case .end: .bottom
        case .baseline: .firstTextBaseline
        }
    }
}

extension VisualNode.Row.Justify {
    /// Where the row's children sit when they leave room; between spreads them with flexible space instead.
    var frame: Alignment {
        switch self {
        case .start, .between: .leading
        case .center: .center
        case .end: .trailing
        }
    }
}

func visualWeight(_ weight: Int) -> Font.Weight {
    switch weight {
    case ..<450: .regular
    case ..<550: .medium
    case ..<650: .semibold
    default: .bold
    }
}

private struct VisualTextView: View {
    let text: VisualNode.Text
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        Text(attributed)
            .lineLimit(text.lines)
            .multilineTextAlignment(text.align.text)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: text.align.frame)
    }

    /// Node styles apply to every run; run styles override them.
    private var attributed: AttributedString {
        let size = text.size.points(fonts)
        var string = AttributedString()
        for run in text.runs {
            let weight = visualWeight(run.weight ?? text.weight)
            var font = run.mono ?? text.mono ? fonts.code(size).weight(weight) : fonts.chat(size, weight: weight)
            if run.italic ?? text.italic { font = font.italic() }
            var piece = AttributedString(run.text)
            piece.font = font
            piece.foregroundColor = (run.color ?? text.color).color
            if run.strike == true { piece.strikethroughStyle = .single }
            string += piece
        }
        return string
    }
}

private struct VisualStatView: View {
    let stat: VisualNode.Stat
    @Environment(\.pilotFonts) private var fonts

    private var tone: Color {
        switch stat.tone {
        case .neutral: Theme.mutedForeground
        case .success: Theme.successInk
        case .warning: Theme.warningInk
        case .danger: Theme.error
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(stat.label).font(fonts.chat(fonts.chatSize - 1.5)).foregroundStyle(Theme.mutedForeground)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(stat.value).font(fonts.chat(fonts.chatSize + 10, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(Theme.foreground)
                if let unit = stat.unit {
                    Text(unit).font(fonts.chat(fonts.chatSize - 1)).foregroundStyle(Theme.mutedForeground)
                }
            }
            if stat.delta != nil || stat.caption != nil {
                HStack(spacing: 6) {
                    if let delta = stat.delta { Text(delta).foregroundStyle(tone).monospacedDigit() }
                    if let caption = stat.caption { Text(caption).foregroundStyle(Theme.mutedForeground) }
                }
                .font(fonts.chat(fonts.chatSize - 1.5))
            }
        }
        .textSelection(.enabled)
    }
}

private struct VisualTableView: View {
    let table: VisualNode.Table
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow {
                    ForEach(Array(table.columns.enumerated()), id: \.offset) { _, column in
                        Text(column.label).font(fonts.chat(fonts.chatSize - 1.5, weight: .medium))
                            .foregroundStyle(Theme.mutedForeground)
                            .gridColumnAlignment(column.align.horizontal)
                    }
                }
                Rectangle().fill(Theme.border).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(table.columns.indices), id: \.self) { index in
                            cell(index < row.count ? row[index] : .empty)
                        }
                    }
                }
            }
            .font(fonts.chat(fonts.chatSize - 1))
            .textSelection(.enabled)
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder
    private func cell(_ cell: VisualCell) -> some View {
        switch cell {
        case .text(let text): Text(verbatim: text).foregroundStyle(Theme.foreground)
        case .number(let number): Text(VisualValue.label(number)).monospacedDigit().foregroundStyle(Theme.foreground)
        case .empty: Text(verbatim: "")
        }
    }
}

// MARK: - Charts

/// Swift Charts for bar, line, area and scatter charts, with a hover readout of every series at the pointer's x.
private struct VisualChartView: View {
    let chart: VisualNode.Chart
    @State private var selectedLabel: String?
    @State private var selectedNumber: Double?

    struct Point: Identifiable {
        let id: Int
        let series: String
        let index: Int
        let label: String
        let number: Double
        let y: Double
    }

    private var labels: [String] {
        var seen = Set<String>()
        return chart.x.map(Self.label).filter { seen.insert($0).inserted }
    }

    private var points: [Point] {
        var points: [Point] = []
        for (seriesIndex, series) in chart.series.enumerated() {
            for (index, value) in series.values.enumerated() where index < chart.x.count {
                guard let value, value.isFinite else { continue }
                let x = chart.x[index]
                let number: Double
                switch x {
                case .number(let value): number = value
                case .label: number = Double(index)
                }
                points.append(Point(id: seriesIndex * 4096 + index, series: series.name, index: index,
                                    label: Self.label(x), number: number, y: value))
            }
        }
        return points
    }

    static func label(_ x: VisualChartX) -> String {
        switch x {
        case .label(let label): label
        case .number(let number): VisualValue.label(number)
        }
    }

    private var yDomain: ClosedRange<Double>? {
        guard chart.yMin != nil || chart.yMax != nil else { return nil }
        let values = points.map(\.y)
        let lower = chart.yMin ?? min(0, values.min() ?? 0)
        let upper = chart.yMax ?? max(lower + 1, values.max() ?? lower + 1)
        return lower...max(upper, lower + .ulpOfOne)
    }

    var body: some View {
        let points = points
        let plot = Chart {
            ForEach(points) { point in mark(point) }
            if let selection = selectedIndex(points) {
                rule(selection)
            }
        }
        .chartForegroundStyleScale(domain: chart.series.map(\.name), range: chart.series.map(\.color.color))
        .chartLegend(chart.series.count > 1 ? .visible : .hidden)
        .visualYDomain(yDomain)
        .visualAxisLabels(x: chart.xLabel, y: chart.yLabel ?? chart.unit)
        .frame(height: chart.height)
        if chart.kind == .scatter {
            plot.chartXSelection(value: $selectedNumber)
        } else {
            plot.chartXScale(domain: labels).chartXSelection(value: $selectedLabel)
        }
    }

    @ChartContentBuilder
    private func mark(_ point: Point) -> some ChartContent {
        switch chart.kind {
        case .bar:
            if chart.stacked || chart.series.count == 1 {
                BarMark(x: .value("x", point.label), y: .value("y", point.y))
                    .foregroundStyle(by: .value("Series", point.series))
            } else {
                BarMark(x: .value("x", point.label), y: .value("y", point.y))
                    .foregroundStyle(by: .value("Series", point.series))
                    .position(by: .value("Series", point.series))
            }
        case .line:
            LineMark(x: .value("x", point.label), y: .value("y", point.y))
                .foregroundStyle(by: .value("Series", point.series))
        case .area:
            AreaMark(x: .value("x", point.label), y: .value("y", point.y),
                     stacking: chart.stacked ? .standard : .unstacked)
                .foregroundStyle(by: .value("Series", point.series))
                .opacity(chart.stacked ? 1 : 0.5)
        case .scatter:
            PointMark(x: .value("x", point.number), y: .value("y", point.y))
                .foregroundStyle(by: .value("Series", point.series))
        }
    }

    @ChartContentBuilder
    private func rule(_ selection: Point) -> some ChartContent {
        if chart.kind == .scatter {
            RuleMark(x: .value("x", selection.number))
                .foregroundStyle(Theme.border)
                .annotation(position: .top, alignment: .center, spacing: 4,
                            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                    readout(at: selection.index)
                }
        } else {
            RuleMark(x: .value("x", selection.label))
                .foregroundStyle(Theme.border)
                .annotation(position: .top, alignment: .center, spacing: 4,
                            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                    readout(at: selection.index)
                }
        }
    }

    /// The x entry under the pointer: the selected category, or the nearest point of a scatter chart.
    private func selectedIndex(_ points: [Point]) -> Point? {
        if chart.kind == .scatter {
            guard let selectedNumber else { return nil }
            return points.min { abs($0.number - selectedNumber) < abs($1.number - selectedNumber) }
        }
        guard let selectedLabel else { return nil }
        return points.first { $0.label == selectedLabel }
    }

    private func readout(at index: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Self.label(chart.x[index])).font(.pilot(.caption, weight: .semibold))
            ForEach(Array(chart.series.enumerated()), id: \.offset) { _, series in
                if index < series.values.count, let value = series.values[index] {
                    HStack(spacing: 4) {
                        Circle().fill(series.color.color).frame(width: 6, height: 6)
                        Text(series.name).foregroundStyle(Theme.mutedForeground)
                        Text(VisualValue.label(value) + (chart.unit.map { " " + $0 } ?? "")).monospacedDigit()
                    }
                    .font(.pilot(.caption))
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .card(radius: Theme.Radius.control, shadow: true)
    }
}

private extension View {
    @ViewBuilder
    func visualYDomain(_ domain: ClosedRange<Double>?) -> some View {
        if let domain { chartYScale(domain: domain) } else { self }
    }

    @ViewBuilder
    func visualAxisLabels(x: String?, y: String?) -> some View {
        switch (x, y) {
        case (let x?, let y?): chartXAxisLabel(x).chartYAxisLabel(y)
        case (let x?, nil): chartXAxisLabel(x)
        case (nil, let y?): chartYAxisLabel(y)
        case (nil, nil): self
        }
    }
}

// MARK: - Snapshot

/// A PNG of the visual's current tree for "Copy screenshot", drawn natively at the reading column's width.
@MainActor
enum VisualSnapshot {
    static func png(tree: VisualTree, model: VisualArtifactModel, fonts: PilotFonts) throws -> Data {
        let content = VisualNodeView(node: tree.root, model: model)
            .padding(16)
            .frame(width: ArtifactViewerLayout.inlineColumnWidth)
            .fixedSize(horizontal: false, vertical: true)
            .background(Theme.background)
            .environment(\.pilotFonts, fonts)
            .environment(\.visualStill, true)
        let renderer = ImageRenderer(content: content)
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2
        guard let image = renderer.cgImage else { throw ClientError("Cannot draw the visual") }
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw ClientError("Cannot encode the visual's screenshot")
        }
        return data
    }
}

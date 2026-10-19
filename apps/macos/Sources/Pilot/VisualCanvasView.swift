import AppKit
import PilotVisualsKit
import QuartzCore
import SwiftUI

// Canvas nodes of native visuals (docs/native-visuals.md, phase 2): the visual service runs a canvas's draw function
// and returns its commands, which replay into a SwiftUI Canvas. Animated canvases draw once per display frame from one
// shared clock, only while they are on screen in a visible window and Reduce Motion is off.

/// One display link for every animated canvas. It runs only while some canvas subscribes and stops with the last.
@MainActor
final class VisualDisplayClock {
    static let shared = VisualDisplayClock()

    private var subscribers: [ObjectIdentifier: (CFTimeInterval) -> Void] = [:]
    private var link: CADisplayLink?
    private lazy var target = Target(self)
    private let usesDisplayLink: Bool

    /// usesDisplayLink false leaves ticking to the caller, for tests.
    init(usesDisplayLink: Bool = true) {
        self.usesDisplayLink = usesDisplayLink
    }

    var isRunning: Bool { link?.isPaused == false }
    var subscriberCount: Int { subscribers.count }

    func subscribe(_ owner: AnyObject, _ tick: @escaping (CFTimeInterval) -> Void) {
        subscribers[ObjectIdentifier(owner)] = tick
        if link == nil, usesDisplayLink, let screen = NSScreen.main {
            let link = screen.displayLink(target: target, selector: #selector(Target.tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
        link?.isPaused = false
    }

    func unsubscribe(_ owner: AnyObject) {
        subscribers[ObjectIdentifier(owner)] = nil
        if subscribers.isEmpty { link?.isPaused = true }
    }

    /// Calls every subscriber with the frame's time. The display link calls it; tests call it directly.
    func fire(_ time: CFTimeInterval) {
        for tick in subscribers.values { tick(time) }
    }

    /// The display link retains its target; this one holds the clock weakly.
    private final class Target: NSObject {
        weak var clock: VisualDisplayClock?
        init(_ clock: VisualDisplayClock) { self.clock = clock }
        @objc func tick(_ link: CADisplayLink) {
            let time = link.targetTimestamp
            MainActor.assumeIsolated { clock?.fire(time) }
        }
    }
}

/// What a canvas shows: its last drawing and, after a failure, the error. Only the drawing surface observes it.
@MainActor
final class VisualCanvasOutput: ObservableObject {
    @Published fileprivate(set) var drawing: VisualDrawing?
    @Published fileprivate(set) var failure: VisualFailure?
}

/// Asks the visual service for a canvas's commands: on resize, pointer moves and new trees, and once per display frame
/// while animated and visible. One draw is in flight at a time; requests in between merge into the next. Two draws in
/// a row that miss the frame limit stop the canvas with the error, as does any other draw error, until Reload.
@MainActor
final class VisualCanvasDrawer: ObservableObject {
    let output = VisualCanvasOutput()
    private(set) var drawsSent = 0

    private weak var model: VisualArtifactModel?
    private var path = ""
    private var canvas = VisualNode.Canvas(height: 240, animated: false, label: nil)
    private var reduceMotion = false
    private var size: CGSize = .zero
    private var pointer: CGPoint?
    private var visible = false
    private var stopped = false
    private var inFlight = false
    private var dirty = false
    private var misses = 0
    /// Seconds of animation shown so far; it pauses while the canvas can't be seen.
    private var elapsed: Double = 0
    private var lastTick: CFTimeInterval?
    private var frames: Int?
    private let clock: VisualDisplayClock

    init(clock: VisualDisplayClock? = nil) {
        self.clock = clock ?? .shared
    }

    deinit {
        let clock = clock
        let id = ObjectIdentifier(self)
        Task { @MainActor in clock.unsubscribe(id: id) }
    }

    var animating: Bool { canvas.animated && visible && !reduceMotion && !stopped && size.width > 0 }

    func configure(model: VisualArtifactModel, path: String, canvas: VisualNode.Canvas, reduceMotion: Bool) {
        let changed = self.model !== model || self.path != path || self.canvas != canvas
            || self.reduceMotion != reduceMotion
        self.model = model
        self.path = path
        self.canvas = canvas
        self.reduceMotion = reduceMotion
        if output.drawing == nil, let last = model.drawing(for: path) { output.drawing = last }
        guard changed else { return }
        if reduceMotion { elapsed = 0 }
        updateClock()
        request()
    }

    func resize(_ size: CGSize) {
        guard size != self.size else { return }
        self.size = size
        updateClock()
        request()
    }

    func point(_ location: CGPoint?) {
        guard location != pointer else { return }
        pointer = location
        // Animated canvases pick the pointer up on their next frame.
        if !animating { request() }
    }

    func setVisible(_ visible: Bool) {
        guard visible != self.visible else { return }
        self.visible = visible
        updateClock()
        if visible { pump() }
    }

    /// The model rendered a new tree, so state the draw function reads may have changed.
    func modelRendered(_ frames: Int) {
        guard frames != self.frames else { return }
        self.frames = frames
        request()
    }

    func retry() {
        stopped = false
        misses = 0
        output.failure = nil
        updateClock()
        request()
    }

    private func request() {
        dirty = true
        pump()
    }

    private func updateClock() {
        if animating {
            clock.subscribe(self) { [weak self] time in self?.tick(time) }
        } else {
            clock.unsubscribe(self)
            lastTick = nil
        }
    }

    private func tick(_ time: CFTimeInterval) {
        // A long gap (a hitch, or a pause) advances at most a tenth of a second.
        if let lastTick { elapsed += min(max(0, time - lastTick), 0.1) }
        lastTick = time
        request()
    }

    private func pump() {
        // A canvas out of sight draws only its first frame; it catches up when it appears.
        guard dirty, !inFlight, !stopped, size.width > 0, visible || output.drawing == nil, let model else { return }
        dirty = false
        inFlight = true
        drawsSent += 1
        let request = VisualDrawRequest(
            canvas: path, width: size.width, height: size.height,
            time: canvas.animated && !reduceMotion ? elapsed : 0,
            pointer: pointer.map { VisualPoint(x: $0.x, y: $0.y) })
        Task { [weak self, weak model] in
            guard let model else { return }
            let result = await model.draw(request)
            self?.finish(result, path: request.canvas)
        }
    }

    private func finish(_ result: Result<VisualDrawing, VisualFailure>, path: String) {
        inFlight = false
        switch result {
        case .success(let drawing):
            misses = 0
            if drawing != output.drawing { output.drawing = drawing }
            model?.remember(drawing, for: path)
        case .failure(.script(let error)) where error.kind == .timeout:
            misses += 1
            if misses >= 2 { stop(.script(error)) } else { dirty = true }
        case .failure(let failure):
            stop(failure)
        }
        pump()
    }

    private func stop(_ failure: VisualFailure) {
        stopped = true
        output.failure = failure
        updateClock()
    }
}

extension VisualDisplayClock {
    fileprivate func unsubscribe(id: ObjectIdentifier) {
        subscribers[id] = nil
        if subscribers.isEmpty { link?.isPaused = true }
    }
}

/// A canvas node: as wide as the column and as tall as the tree says, so the row never jumps when it draws.
struct VisualCanvasView: View {
    let canvas: VisualNode.Canvas
    let path: String
    let model: VisualArtifactModel
    @StateObject private var drawer = VisualCanvasDrawer()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            VisualCanvasSurface(output: drawer.output)
                .frame(maxWidth: .infinity)
                .frame(height: canvas.height)
                .contentShape(Rectangle())
                .onGeometryChange(for: CGSize.self, of: { $0.size }) { drawer.resize($0) }
                .onContinuousHover(coordinateSpace: .local) { phase in
                    switch phase {
                    case .active(let location): drawer.point(location)
                    case .ended: drawer.point(nil)
                    }
                }
                .background(VisualCanvasVisibility { drawer.setVisible($0) })
                .accessibilityElement()
                .accessibilityLabel(canvas.label ?? "Drawing")
                .accessibilityAddTraits(.isImage)
            VisualCanvasFailure(output: drawer.output, retry: drawer.retry)
        }
        .onAppear { configure() }
        .onChange(of: canvas) { configure() }
        .onChange(of: path) { configure() }
        .onChange(of: reduceMotion) { configure() }
        .onReceive(model.$frames) { drawer.modelRendered($0) }
    }

    private func configure() {
        drawer.configure(model: model, path: path, canvas: canvas, reduceMotion: reduceMotion)
    }
}

/// A canvas's last drawing, without drawing again: for screenshots, which render once and offscreen.
struct VisualCanvasStill: View {
    let canvas: VisualNode.Canvas
    let drawing: VisualDrawing?
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        Canvas { context, _ in drawing?.replay(in: &context, fonts: fonts) }
            .frame(maxWidth: .infinity)
            .frame(height: canvas.height)
            .clipped()
    }
}

/// The drawing itself. The only view that observes each new frame.
private struct VisualCanvasSurface: View {
    @ObservedObject var output: VisualCanvasOutput
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        let drawing = output.drawing
        Canvas { context, _ in
            drawing?.replay(in: &context, fonts: fonts)
        }
        .clipped()
    }
}

private struct VisualCanvasFailure: View {
    @ObservedObject var output: VisualCanvasOutput
    let retry: () -> Void

    var body: some View {
        if let failure = output.failure {
            VisualFailureLine(failure: failure, retry: retry)
        }
    }
}

/// Reports whether the canvas can be seen: in a window on screen and not occluded, not hidden, and at least partly
/// inside its scroll view. Rechecked when the window's occlusion changes or any of its clip views scrolls.
private struct VisualCanvasVisibility: NSViewRepresentable {
    let changed: (Bool) -> Void

    func makeNSView(context: Context) -> VisibilityView { VisibilityView() }

    func updateNSView(_ view: VisibilityView, context: Context) {
        view.changed = changed
        view.check()
    }

    static func dismantleNSView(_ view: VisibilityView, coordinator: ()) {
        view.stopObserving()
        view.changed?(false)
        view.changed = nil
    }

    final class VisibilityView: NSView {
        var changed: ((Bool) -> Void)?
        private var observers: [NSObjectProtocol] = []
        private var reported: Bool?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func isAccessibilityElement() -> Bool { false }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stopObserving()
            if let window {
                let center = NotificationCenter.default
                for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                             NSWindow.didDeminiaturizeNotification] {
                    observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                        MainActor.assumeIsolated { self?.check() }
                    })
                }
                observers.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: nil,
                                                    queue: .main) { [weak self] notification in
                    MainActor.assumeIsolated {
                        guard let clip = notification.object as? NSClipView, clip.window === self?.window else { return }
                        self?.check()
                    }
                })
            }
            check()
        }

        override func viewDidHide() {
            super.viewDidHide()
            check()
        }

        override func viewDidUnhide() {
            super.viewDidUnhide()
            check()
        }

        override func setFrameSize(_ newSize: NSSize) {
            super.setFrameSize(newSize)
            check()
        }

        func check() {
            guard let window else { return report(false) }
            report(window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible)
                && !isHiddenOrHasHiddenAncestor && !visibleRect.isEmpty)
        }

        private func report(_ visible: Bool) {
            guard visible != reported else { return }
            reported = visible
            changed?(visible)
        }

        func stopObserving() {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers.removeAll()
        }

        deinit {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
        }
    }
}

// MARK: - Replay

extension VisualDrawing {
    /// Replays the commands into a SwiftUI graphics context, in points with the origin at the top left. Colors are
    /// Theme tokens, so drawings follow light and dark appearance.
    func replay(in context: inout GraphicsContext, fonts: PilotFonts) {
        let colors = VisualColor.allCases.map(\.color)
        var stack: [GraphicsContext] = []
        var current = context
        func paint(_ path: Path, _ paint: Paint) {
            let shading = GraphicsContext.Shading.color(colors[paint.color].opacity(paint.opacity))
            if paint.stroke {
                current.stroke(path, with: shading,
                               style: StrokeStyle(lineWidth: paint.lineWidth, lineCap: .round, lineJoin: .round))
            } else {
                current.fill(path, with: shading)
            }
        }
        forEach { command in
            switch command {
            case .save:
                if stack.count < 64 { stack.append(current) }
            case .restore:
                if let saved = stack.popLast() { current = saved }
            case .translate(let x, let y):
                current.translateBy(x: x, y: y)
            case .rotate(let radians):
                current.rotate(by: .radians(radians))
            case .scale(let x, let y):
                current.scaleBy(x: x, y: y)
            case .opacity(let factor):
                current.opacity *= factor
            case .rect(let style, let x, let y, let width, let height, let radius):
                let rect = CGRect(x: x, y: y, width: width, height: height).standardized
                let corner = min(radius, min(rect.width, rect.height) / 2)
                paint(corner > 0 ? Path(roundedRect: rect, cornerRadius: corner) : Path(rect), style)
            case .circle(let style, let x, let y, let radius):
                paint(Path(ellipseIn: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)),
                      style)
            case .line(let style, let x1, let y1, let x2, let y2):
                var path = Path()
                path.move(to: CGPoint(x: x1, y: y1))
                path.addLine(to: CGPoint(x: x2, y: y2))
                paint(path, style)
            case .path(let style, let closed, let points):
                var path = Path()
                var index = points.startIndex
                while index + 1 < points.endIndex {
                    let point = CGPoint(x: points[index], y: points[index + 1])
                    if index == points.startIndex { path.move(to: point) } else { path.addLine(to: point) }
                    index += 2
                }
                if closed { path.closeSubpath() }
                paint(path, style)
            case .arc(let style, let x, let y, let radius, let inner, let start, let end):
                let center = CGPoint(x: x, y: y)
                var path = Path()
                if style.stroke {
                    path.addArc(center: center, radius: radius, startAngle: .radians(start), endAngle: .radians(end),
                                clockwise: false)
                } else {
                    if inner > 0 {
                        path.addArc(center: center, radius: radius, startAngle: .radians(start),
                                    endAngle: .radians(end), clockwise: false)
                        path.addArc(center: center, radius: min(inner, radius), startAngle: .radians(end),
                                    endAngle: .radians(start), clockwise: true)
                    } else {
                        path.move(to: center)
                        path.addArc(center: center, radius: radius, startAngle: .radians(start),
                                    endAngle: .radians(end), clockwise: false)
                    }
                    path.closeSubpath()
                }
                paint(path, style)
            case .text(let text):
                let size = [VisualTextSize.xs, .sm, .md, .lg, .xl][text.size].points(fonts)
                let weight = visualWeight(text.weight)
                let font = text.mono ? fonts.code(size).weight(weight) : fonts.chat(size, weight: weight)
                let anchor = UnitPoint(x: [0, 0.5, 1][text.align], y: [0, 0.5, 1][text.baseline])
                current.draw(SwiftUI.Text(verbatim: text.string).font(font)
                    .foregroundStyle(colors[text.color].opacity(text.opacity)),
                             at: CGPoint(x: text.x, y: text.y), anchor: anchor)
            }
        }
    }
}

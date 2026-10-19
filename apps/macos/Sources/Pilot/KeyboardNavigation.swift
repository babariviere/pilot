import AppKit
import SwiftUI
import WebKit

// Shared keyboard navigation: named focus regions, input guards and the few reserved app-level keys.
//
// Ordinary shortcuts stay menu key equivalents, so a focused editor or embedded view keeps its own equivalents
// first. Only the routes in `KeyboardRoute` are read before the focused view: ⌘L composer focus everywhere, and the
// palette and terminal toggle out of embedded content. Plain letters are never taken from the focused view, so
// typing, IME composition and native type-select behave as usual. Nothing is recorded or replayed.

/// The window's keyboard regions, in on-screen order. Regions that are not on screen are skipped.
enum KeyboardRegion: String, CaseIterable {
    case sidebar
    case content
    case composer
    case inspector

    var title: String {
        switch self {
        case .sidebar: "Sidebar"
        case .content: "Page"
        case .composer: "Composer"
        case .inspector: "Inspector"
        }
    }
}

/// Who owns typed keys right now.
enum KeyboardInputContext: Equatable {
    /// Browsing: no editor or embedded content owns typed keys. Arrows, Return and Tab navigate.
    case navigation
    /// A text field or editor, including IME composition. Letters are text.
    case text
    /// Terminal or web content. Every key is its input except the reserved app routes.
    case embedded
}

enum KeyboardInputGuard {
    /// Reads the AppKit first responder, not SwiftUI focus, so field editors and native views count.
    @MainActor
    static func context(for responder: NSResponder?) -> KeyboardInputContext {
        guard let responder else { return .navigation }
        if let view = responder as? NSView, isEmbedded(view) { return .embedded }
        if let client = responder as? NSTextInputClient, client.hasMarkedText() { return .text }
        if let text = responder as? NSTextView {
            return text.isEditable || text.isFieldEditor ? .text : .navigation
        }
        if responder is NSTextField || responder is NSSearchField { return .text }
        return .navigation
    }

    /// Terminal surfaces and web views, or a view inside one.
    @MainActor
    static func isEmbedded(_ view: NSView) -> Bool {
        isInside(view) { $0 is WKWebView || isTerminal($0) }
    }

    /// A terminal surface or a view inside one.
    @MainActor
    static func isInTerminal(_ view: NSView) -> Bool { isInside(view, where: isTerminal) }

    @MainActor
    private static func isInside(_ view: NSView, where matches: (NSView) -> Bool) -> Bool {
        var current: NSView? = view
        while let candidate = current {
            if matches(candidate) { return true }
            current = candidate.superview
        }
        return false
    }

    /// libghostty's surface view, without importing the terminal package here.
    static func isTerminal(_ view: NSView) -> Bool {
        let name = String(describing: type(of: view))
        return name.hasSuffix("TerminalView") && !name.hasPrefix("NSHosting")
    }
}

/// A key press reduced to what routing reads. Letters use the layout's characters, not key codes, so
/// non-US layouts get the letters printed on their keys.
struct KeyboardChord: Equatable {
    var characters: String
    var keyCode: UInt16
    var modifiers: NSEvent.ModifierFlags

    static let relevantModifiers: NSEvent.ModifierFlags = [.command, .control, .option, .shift]

    init(characters: String, keyCode: UInt16 = 0, modifiers: NSEvent.ModifierFlags = []) {
        self.characters = characters.lowercased()
        self.keyCode = keyCode
        self.modifiers = modifiers.intersection(Self.relevantModifiers)
    }

    init(_ event: NSEvent) {
        self.init(characters: event.charactersIgnoringModifiers ?? "", keyCode: event.keyCode,
                  modifiers: event.modifierFlags)
    }

    static let tabKeyCode: UInt16 = 48
    static let escapeKeyCode: UInt16 = 53
}

/// What the window does with one key press, before the focused view sees it.
enum KeyboardRoute: Equatable {
    /// Deliver normally.
    case pass
    case focusComposer
    case commandPalette
    case toggleTerminal

    /// Only modified chords are reserved; every unmodified key reaches the focused view.
    static func decide(_ chord: KeyboardChord, context: KeyboardInputContext) -> KeyboardRoute {
        let mods = chord.modifiers
        if mods == [.command], chord.characters == "l" { return .focusComposer }
        if context == .embedded, mods == [.command] {
            if chord.characters == "k" { return .commandPalette }
            if chord.characters == "j" { return .toggleTerminal }
        }
        return .pass
    }
}

/// Region anchors and focus handlers. Separate from AppModel so the anchors never re-render views that observe the
/// app model.
@MainActor
final class KeyboardFocus: ObservableObject {
    /// The last region focus moved to by a command or a region's own focus report.
    private(set) var lastRegion: KeyboardRegion?
    private var anchors: [KeyboardRegion: [WeakAnchor]] = [:]
    private var handlers: [KeyboardRegion: [(id: UUID, perform: () -> Bool)]] = [:]
    /// A region to focus once its destination view registers, after a navigation command.
    private var pendingFocus: (region: KeyboardRegion, at: TimeInterval)?
    /// When arrow keys last moved a native list (the sidebar), so a chat it opens leaves focus there.
    private var listKeyAt: TimeInterval?
    /// Composers offering their controls to the palette, oldest first.
    private(set) var composerProviders: [(id: UUID, provide: @MainActor () -> [ComposerCommand])] = []

    /// Rows fixed above the sidebar's list (the Control chat), which arrow keys reach as the list's first items
    /// (`SidebarStickyNavigation`). Set by the sidebar while it is on screen.
    struct StickyRows {
        let keys: @MainActor () -> [String]
        let current: @MainActor () -> String?
        let select: @MainActor (String) -> Void
    }

    var sidebarStickyRows: StickyRows?

    func setComposerProvider(_ id: UUID, _ provide: @escaping @MainActor () -> [ComposerCommand]) {
        if let index = composerProviders.firstIndex(where: { $0.id == id }) {
            composerProviders[index].provide = provide
        } else {
            composerProviders.append((id, provide))
        }
    }

    func removeComposerProvider(_ id: UUID) { composerProviders.removeAll { $0.id == id } }

    private(set) var selectionProviders: [(id: UUID, provide: @MainActor () -> (title: String, commands: [ComposerCommand])?)] = []

    func setSelectionProvider(_ id: UUID, _ provide: @escaping @MainActor () -> (title: String, commands: [ComposerCommand])?) {
        if let index = selectionProviders.firstIndex(where: { $0.id == id }) {
            selectionProviders[index].provide = provide
        } else {
            selectionProviders.append((id, provide))
        }
    }

    func removeSelectionProvider(_ id: UUID) { selectionProviders.removeAll { $0.id == id } }

    /// Escape after any picker, marked text or queue edit: leave the composer for the page, keeping the draft.
    static func leaveComposer(_ focus: KeyboardFocus? = nil) {
        let focus = focus ?? AppModel.shared.keyboard
        if !focus.focus(.content) {
            NSApp.keyWindow?.makeFirstResponder(nil)
            focus.noteFocused(.content)
        }
    }

    private struct WeakAnchor {
        weak var view: NSView?
    }

    // MARK: Registration

    func register(anchor: NSView, for region: KeyboardRegion) {
        var list = anchors[region, default: []].filter { $0.view != nil && $0.view !== anchor }
        list.append(WeakAnchor(view: anchor))
        anchors[region] = list
    }

    func unregister(anchor: NSView) {
        for region in anchors.keys { anchors[region]?.removeAll { $0.view == nil || $0.view === anchor } }
    }

    /// A view able to take focus for a region, such as a page's list. The most recently registered runs first.
    func addHandler(_ id: UUID, for region: KeyboardRegion, perform: @escaping () -> Bool) {
        handlers[region, default: []].removeAll { $0.id == id }
        handlers[region, default: []].append((id, perform))
        if let pending = pendingFocus, pending.region == region,
           ProcessInfo.processInfo.systemUptime - pending.at < 1 {
            pendingFocus = nil
            // After the view's first layout, so its focusable views exist.
            DispatchQueue.main.async { [weak self] in
                if perform() { self?.lastRegion = region }
            }
        }
    }

    func removeHandler(_ id: UUID) {
        for region in handlers.keys { handlers[region]?.removeAll { $0.id == id } }
    }

    /// A region reports that the user focused it, as by clicking a SwiftUI list.
    func noteFocused(_ region: KeyboardRegion) { lastRegion = region }

    /// A navigation command succeeded: focus the destination's region once its view appears, or, when the
    /// destination was already on screen, shortly after.
    func focusAfterNavigation(_ region: KeyboardRegion) {
        let at = ProcessInfo.processInfo.systemUptime
        pendingFocus = (region, at)
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard let self, let pending = self.pendingFocus, pending.region == region, pending.at == at else { return }
            self.pendingFocus = nil
            self.focus(region)
        }
    }

    /// Arrow keys moved a native list, as when browsing sidebar rows.
    func noteListKey() { listKeyAt = ProcessInfo.processInfo.systemUptime }

    /// True right after arrow keys moved a list that still has focus. A composer appearing then must not take it.
    var isBrowsingList: Bool {
        guard let listKeyAt, ProcessInfo.processInfo.systemUptime - listKeyAt < 1 else { return false }
        return window?.firstResponder is NSTableView
    }

    // MARK: Geometry

    /// The window holding the regions, or nil before any is on screen.
    var window: NSWindow? {
        for region in KeyboardRegion.allCases {
            if let view = anchor(for: region) { return view.window }
        }
        return nil
    }

    private func anchor(for region: KeyboardRegion) -> NSView? {
        anchors[region]?.reversed().lazy.compactMap(\.view).first { view in
            view.window != nil && !view.isHiddenOrHasHiddenAncestor && view.bounds.width > 1 && view.bounds.height > 1
        }
    }

    func frame(of region: KeyboardRegion) -> NSRect? {
        anchor(for: region).map { $0.convert($0.bounds, to: nil) }
    }

    /// Regions on screen, in sidebar, page, composer, inspector order.
    var visibleRegions: [KeyboardRegion] { KeyboardRegion.allCases.filter { anchor(for: $0) != nil } }

    /// The region holding the first responder, else the last one focused.
    func currentRegion() -> KeyboardRegion? {
        guard let window else { return lastRegion }
        var responder = window.firstResponder
        if let text = responder as? NSTextView, text.isFieldEditor, let owner = text.delegate as? NSView {
            responder = owner
        }
        if let view = responder as? NSView, view !== window.contentView {
            let rect = view.convert(view.bounds, to: nil)
            let content = window.contentLayoutRect
            // A whole-window host says nothing about where SwiftUI focus is; trust the last report instead.
            if rect.width * rect.height < content.width * content.height * 0.8 {
                let center = NSPoint(x: rect.midX, y: rect.midY)
                let containing = visibleRegions.compactMap { region in
                    frame(of: region).flatMap { $0.contains(center) ? (region, $0.width * $0.height) : nil }
                }
                if let smallest = containing.min(by: { $0.1 < $1.1 }) { return smallest.0 }
            }
        }
        return lastRegion.flatMap { visibleRegions.contains($0) ? $0 : nil }
    }

    // MARK: Focus commands

    /// Asks the region's views to take focus, falling back to its first native key view.
    @discardableResult
    func focus(_ region: KeyboardRegion) -> Bool {
        guard anchor(for: region) != nil else { return false }
        for handler in handlers[region, default: []].reversed() where handler.perform() {
            lastRegion = region
            return true
        }
        guard focusFirstKeyView(in: region) else { return false }
        lastRegion = region
        return true
    }

    /// The first native view inside the region that accepts keyboard focus and `accept`s, in view order. Views
    /// inside a smaller region on screen (the composer within a chat page) belong to that region instead.
    /// Terminals are never chosen here: a cached one stays mounted, hidden, behind other inspector panes, so only
    /// the terminal pane itself focuses its surface.
    func focusFirstKeyView(in region: KeyboardRegion, where accept: (NSView) -> Bool = { _ in true }) -> Bool {
        guard let anchor = anchor(for: region), let window = anchor.window, let root = window.contentView else { return false }
        let rect = anchor.convert(anchor.bounds, to: nil)
        let content = window.contentLayoutRect
        let inner = visibleRegions.filter { $0 != region }.compactMap(frame(of:))
            .filter { $0.width * $0.height < rect.width * rect.height }
        func candidate(in view: NSView) -> NSView? {
            guard !view.isHidden, view.alphaValue > 0.01 else { return nil }
            let frame = view.convert(view.bounds, to: nil)
            guard frame.intersects(rect) else { return nil }
            let center = NSPoint(x: frame.midX, y: frame.midY)
            if view !== anchor, view !== root, view.acceptsFirstResponder, view.canBecomeKeyView,
               frame.width * frame.height < content.width * content.height * 0.8,
               rect.contains(center), !inner.contains(where: { $0.contains(center) }), accept(view),
               !KeyboardInputGuard.isInTerminal(view) {
                return view
            }
            for child in view.subviews {
                if let found = candidate(in: child) { return found }
            }
            return nil
        }
        guard let target = candidate(in: root) else { return false }
        return window.makeFirstResponder(target)
    }
}

// MARK: - Router

/// Reads key presses in the main window before its focused view, for the routes `KeyboardRoute` reserves.
@MainActor
final class KeyboardRouter {
    static let shared = KeyboardRouter()
    private var monitor: Any?
    private var pointerMonitor: Any?
    /// Performs an app action for a route. Returns false to deliver the key normally.
    var perform: ((KeyboardRoute) -> Bool)?
    var focus: KeyboardFocus?
    /// Shows keyboard-only decoration after navigation keys and hides it on clicks, in every window.
    var cue: KeyboardCue = .shared

    func install(focus: KeyboardFocus, perform: @escaping (KeyboardRoute) -> Bool) {
        self.focus = focus
        self.perform = perform
        guard monitor == nil else { return }
        // Local monitors run on the main thread, like CompletionPicker's.
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handle(event) ?? event
        }
        // Clicks only hide keyboard decoration; the event is delivered unchanged.
        pointerMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) {
            [weak self] event in
            self?.handlePointer(event) ?? event
        }
    }

    /// The event to deliver, or nil when a route consumed it.
    func handle(_ event: NSEvent) -> NSEvent? {
        if let window = event.window {
            // Before delivery, so focus that the key moves arrives with the cue already shown.
            let responder = window.firstResponder
            cue.note(KeyboardChord(event), context: KeyboardInputGuard.context(for: responder),
                     fieldEditor: (responder as? NSTextView)?.isFieldEditor == true)
        }
        guard let focus, let window = event.window else { return event }
        if window !== focus.window || window.attachedSheet != nil {
            // Sheets and other windows (an artifact viewer, a link preview) keep every key, except that ⌘L leaves
            // web or terminal content, so the window's own controls and Escape are reachable again.
            let target = window.attachedSheet ?? window
            let chord = KeyboardChord(event)
            guard target === window, KeyboardInputGuard.context(for: window.firstResponder) == .embedded,
                  chord.modifiers == [.command], chord.characters == "l" else { return event }
            Self.leaveEmbeddedContent(in: window)
            return nil
        }
        let context = KeyboardInputGuard.context(for: window.firstResponder)
        if context == .navigation, window.firstResponder is NSTableView, [125, 126].contains(event.keyCode) {
            focus.noteListKey()
        }
        if context == .navigation, let table = window.firstResponder as? NSTableView,
           let down = Self.verticalStep(event), let sticky = focus.sidebarStickyRows, focus.currentRegion() == .sidebar {
            let step = SidebarStickyNavigation.step(down: down, sticky: sticky.keys(), current: sticky.current(),
                                                    listHasSelection: table.selectedRow >= 0)
            switch step {
            case .native:
                break
            case .stay:
                return nil
            case let .select(key):
                sticky.select(key)
                return nil
            case let .nativeOr(key):
                // The list's own move first: only when its first row was already selected does up reach the slot.
                let before = table.selectedRow
                table.keyDown(with: Self.arrowEvent(down: down, like: event) ?? event)
                if table.selectedRow == before { sticky.select(key) }
                return nil
            }
        }
        let route = KeyboardRoute.decide(KeyboardChord(event), context: context)
        guard route != .pass else { return event }
        return perform?(route) == true ? nil : event
    }

    /// A mouse button went down: hide keyboard-only decoration, including for focus the click moves later.
    func handlePointer(_ event: NSEvent) -> NSEvent {
        cue.notePointer()
        return event
    }

    static func arrowEvent(down: Bool, like event: NSEvent) -> NSEvent? {
        let characters = down ? "\u{f701}" : "\u{f700}"
        return NSEvent.keyEvent(with: .keyDown, location: event.locationInWindow, modifierFlags: [.function, .numericPad],
                                timestamp: event.timestamp, windowNumber: event.windowNumber, context: nil,
                                characters: characters, charactersIgnoringModifiers: characters,
                                isARepeat: event.isARepeat, keyCode: down ? 125 : 126)
    }

    /// Down (true) or up (false) for an unmodified arrow; nil for any other key.
    static func verticalStep(_ event: NSEvent) -> Bool? {
        let chord = KeyboardChord(event)
        guard chord.modifiers.isEmpty else { return nil }
        switch chord.keyCode {
        case 125: return true
        case 126: return false
        default: return nil
        }
    }

    /// Moves focus from web or terminal content to the window's first other control, or to the window itself.
    static func leaveEmbeddedContent(in window: NSWindow) {
        func candidate(in view: NSView) -> NSView? {
            guard !view.isHidden, !KeyboardInputGuard.isEmbedded(view) else { return nil }
            if view.acceptsFirstResponder, view.canBecomeKeyView, view !== window.contentView { return view }
            for child in view.subviews {
                if let found = candidate(in: child) { return found }
            }
            return nil
        }
        if let target = window.contentView.flatMap(candidate), window.makeFirstResponder(target) { return }
        window.makeFirstResponder(nil)
    }
}

// MARK: - Views

extension View {
    /// Marks this view as a keyboard region. `onFocus` moves focus into it and returns false when it cannot,
    /// leaving the region's first native key view to take focus.
    func keyboardRegion(_ region: KeyboardRegion, onFocus: (() -> Bool)? = nil) -> some View {
        modifier(KeyboardRegionModifier(region: region, onFocus: onFocus))
    }

    /// Lets a view inside a region take focus for it, as a page's list does for the page region.
    func keyboardFocusHandler(_ region: KeyboardRegion, perform: @escaping () -> Bool) -> some View {
        modifier(KeyboardFocusHandlerModifier(region: region, perform: perform))
    }
}

private struct KeyboardRegionModifier: ViewModifier {
    let region: KeyboardRegion
    let onFocus: (() -> Bool)?
    @Environment(\.keyboardFocus) private var keyboard

    func body(content: Content) -> some View {
        content
            .background(KeyboardRegionAnchor(region: region, focus: keyboard))
            .modifier(OptionalFocusHandler(region: region, perform: onFocus))
    }
}

private struct OptionalFocusHandler: ViewModifier {
    let region: KeyboardRegion
    let perform: (() -> Bool)?

    func body(content: Content) -> some View {
        if let perform {
            content.keyboardFocusHandler(region, perform: perform)
        } else {
            content
        }
    }
}

private struct KeyboardFocusHandlerModifier: ViewModifier {
    let region: KeyboardRegion
    let perform: () -> Bool
    @State private var id = UUID()
    @Environment(\.keyboardFocus) private var keyboard

    func body(content: Content) -> some View {
        content
            .onAppear { keyboard.addHandler(id, for: region, perform: perform) }
            .onDisappear { keyboard.removeHandler(id) }
    }
}

/// A zero-cost view behind a region that tells the router where the region is.
struct KeyboardRegionAnchor: NSViewRepresentable {
    let region: KeyboardRegion
    let focus: KeyboardFocus

    func makeNSView(context: Context) -> AnchorView {
        let view = AnchorView()
        view.region = region
        view.focus = focus
        return view
    }

    func updateNSView(_ view: AnchorView, context: Context) {
        if view.region != region {
            view.region = region
            view.registerIfNeeded()
        }
    }

    static func dismantleNSView(_ view: AnchorView, coordinator: ()) {
        view.focus?.unregister(anchor: view)
    }

    final class AnchorView: NSView {
        var region: KeyboardRegion = .content
        weak var focus: KeyboardFocus?

        override var acceptsFirstResponder: Bool { false }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            registerIfNeeded()
        }

        func registerIfNeeded() {
            guard let focus else { return }
            focus.unregister(anchor: self)
            if window != nil { focus.register(anchor: self, for: region) }
        }
    }
}

/// A Go menu and palette destination. Navigation only: a destination that is not available does nothing.
enum GoDestination: String, CaseIterable {
    case home
    case inbox
    case overview
    case mission
    case tasks
    case brief
    case archive
    case slack
    case linear
    case control
}

/// The keyboard state views register their regions, handlers and commands with: the app's, or a fixture window's.
private struct KeyboardFocusKey: EnvironmentKey {
    static var defaultValue: KeyboardFocus { MainActor.assumeIsolated { AppModel.shared.keyboard } }
}

extension EnvironmentValues {
    var keyboardFocus: KeyboardFocus {
        get { self[KeyboardFocusKey.self] }
        set { self[KeyboardFocusKey.self] = newValue }
    }
}

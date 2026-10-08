import AppKit
import Combine
import GhosttyTerminal
import PilotCore
import SwiftUI

/// One libghostty terminal per session, rendering a shell that pilotd owns. The shell outlives the
/// app: reopening Pilot reattaches and replays its scrollback. A small LRU of inactive surfaces stays
/// mounted for fast switching. Eviction loses local selection/scroll position and libghostty history,
/// not the daemon shell or its replay buffer. When a shell exits, its slot becomes a placeholder, so the
/// split view never loses its pane.
@MainActor
final class TerminalStore: ObservableObject {
    @Published private(set) var order: [String] = []
    /// Sessions whose shell has exited; their pane shows a restart placeholder.
    @Published private(set) var exited: Set<String> = []
    private(set) var states: [String: TerminalViewState] = [:]
    /// Host side of each surface, for tests that read the screen.
    private(set) var memories: [String: InMemoryTerminalSession] = [:]
    private var settings: AppSettings?
    private var subscriptions: Set<AnyCancellable> = []
    private var retention = TerminalSurfaceRetention()

    private static let ghosttyConfig = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: ".config/ghostty/config").path

    private lazy var controller: TerminalController = TerminalController(
        configSource: configSource,
        terminalConfiguration: settings?.terminalConfiguration ?? TerminalConfiguration()
    )

    private var configSource: TerminalController.ConfigSource {
        let useGhostty = settings?.useGhosttyConfig ?? true
        return useGhostty && FileManager.default.fileExists(atPath: Self.ghosttyConfig) ? .file(Self.ghosttyConfig) : .none
    }

    private var client: PilotClient { AppModel.shared.client }

    /// Applies font and config changes from Settings to every open terminal, live.
    func bind(to settings: AppSettings) {
        self.settings = settings
        settings.objectWillChange
            .debounce(for: .milliseconds(150), scheduler: RunLoop.main)
            .sink { [weak self] in self?.applySettings() }
            .store(in: &subscriptions)
    }

    private func applySettings() {
        guard let settings, !states.isEmpty else { return }
        controller.updateConfigSource(configSource)
        controller.setTerminalConfiguration(settings.terminalConfiguration)
    }

    /// Attaches to the session's shell unless attached or exited (restart is explicit).
    func ensure(_ session: SessionSummary) {
        if states[session.id] != nil {
            retention.touch(session.id)
            return
        }
        guard session.state != "starting", states[session.id] == nil, !exited.contains(session.id) else { return }
        start(session, restart: false)
    }

    /// Only the displayed surface is protected. A hidden tab/window has no active surface.
    func select(_ session: SessionSummary, isVisible: Bool, paneID: UUID) {
        retention.select(session.id, isVisible: isVisible, paneID: paneID)
        ensure(session)
        synchronizeSurfaceVisibility()
        evictInactiveSurfaces()
    }

    func paneDidDisappear(sessionId: String, paneID: UUID) {
        guard retention.hide(sessionId: sessionId, paneID: paneID) else { return }
        states[sessionId]?.isSurfaceVisible = false
        evictInactiveSurfaces()
    }

    /// Cached states are shared by outgoing/incoming SessionDetail trees. Ignore all late leaf
    /// callbacks from the old owner, and callbacks capturing a surface replaced by restart.
    func surfaceVisibilityChanged(_ id: String, state: TerminalViewState, paneID: UUID) {
        guard retention.ownsSurfaceCallbacks(paneID: paneID), states[id] === state else { return }
        state.isSurfaceVisible = id == retention.visibleSessionId
    }

    func surfaceDidDisappear(_ id: String, state: TerminalViewState, paneID: UUID) {
        guard retention.ownsSurfaceCallbacks(paneID: paneID), states[id] === state else { return }
        state.isSurfaceVisible = false
    }

    private func synchronizeSurfaceVisibility() {
        for (id, state) in states { state.isSurfaceVisible = id == retention.visibleSessionId }
    }

    private func evictInactiveSurfaces() {
        for id in retention.evictions() { remove(id) }
    }

    func restart(_ session: SessionSummary) {
        guard session.state != "starting" else { return }
        exited.remove(session.id)
        if states[session.id] != nil { remove(session.id) }
        start(session, restart: true)
    }

    private func start(_ session: SessionSummary, restart: Bool) {
        let id = session.id
        let memory = InMemoryTerminalSession(
            write: { data in
                Task { @MainActor in AppModel.shared.client.terminalInput(id, data) }
            },
            resize: { viewport in
                Task { @MainActor in
                    AppModel.shared.client.terminalResize(id, cols: Int(viewport.columns), rows: Int(viewport.rows))
                }
            },
            suppressesPixelOnlyResizes: true
        )
        let state = TerminalViewState(controller: controller)
        state.isSurfaceVisible = id == retention.visibleSessionId
        state.configuration = TerminalSurfaceOptions(backend: .inMemory(memory))
        state.onClose = { [weak self, weak state] _ in
            // Reported from a libghostty callback; change the view tree on the next turn.
            DispatchQueue.main.async {
                guard let self, let state, self.states[id] === state else { return }
                self.shellExited(id)
            }
        }
        states[id] = state
        memories[id] = memory
        order.append(id)
        retention.touch(id)
        client.attachTerminal(
            id,
            cols: 80,
            rows: 24,
            restart: restart,
            .init(
                cols: 80,
                rows: 24,
                onData: { memory.receive($0) },
                onExit: { [weak self, weak state] code in
                    memory.finish(exitCode: UInt32(clamping: max(0, code)), runtimeMilliseconds: 0)
                    DispatchQueue.main.async {
                        guard let self, let state, self.states[id] === state else { return }
                        self.shellExited(id)
                    }
                },
                // Reset before the daemon replays scrollback, so reconnects do not duplicate output.
                onReplay: { memory.receive("\u{1B}c") }
            )
        )
        evictInactiveSurfaces()
    }

    private func shellExited(_ id: String) {
        guard states[id] != nil else { return }
        // The exited surface may hold keyboard focus; release it before it goes away.
        if let window = NSApp.keyWindow, window.firstResponder is NSView {
            window.makeFirstResponder(nil)
        }
        exited.insert(id)
        remove(id)
    }

    /// Detaches the view; the daemon keeps the shell (if still running) for the next attach.
    func remove(_ id: String) {
        client.detachTerminal(id)
        states[id]?.isSurfaceVisible = false
        states[id] = nil
        memories[id] = nil
        order.removeAll { $0 == id }
        retention.remove(id)
    }
}

/// Metadata only, so the bounded LRU policy can be tested without creating libghostty surfaces.
struct TerminalSurfaceRetention {
    let inactiveLimit: Int
    var visibleSessionId: String?
    private var paneID: UUID?
    private(set) var recency: [String] = []

    init(inactiveLimit: Int = 5) { self.inactiveLimit = max(0, inactiveLimit) }

    mutating func select(_ id: String, isVisible: Bool, paneID: UUID) {
        self.paneID = paneID
        visibleSessionId = isVisible ? id : nil
    }

    /// A superseded SwiftUI tree cannot unprotect the new pane's visible surface.
    mutating func hide(sessionId: String, paneID: UUID) -> Bool {
        guard self.paneID == paneID else { return false }
        if visibleSessionId != nil, !clearVisible(ifMatching: sessionId) { return false }
        self.paneID = nil
        return true
    }

    func ownsSurfaceCallbacks(paneID: UUID) -> Bool { self.paneID == paneID }

    mutating func clearVisible(ifMatching sessionId: String) -> Bool {
        guard visibleSessionId == sessionId else { return false }
        visibleSessionId = nil
        return true
    }

    mutating func touch(_ id: String) {
        recency.removeAll { $0 == id }
        recency.append(id)
    }

    mutating func remove(_ id: String) {
        recency.removeAll { $0 == id }
    }

    func evictions() -> [String] {
        let inactive = recency.filter { $0 != visibleSessionId }
        return Array(inactive.prefix(max(0, inactive.count - inactiveLimit)))
    }
}

struct TerminalPane: View {
    @StateObject private var lifetime = TerminalPaneLifetime()
    @ObservedObject var store: TerminalStore
    let session: SessionSummary
    var isVisible = true

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "terminal").font(.caption)
                Text(session.cwd.abbreviatingHome).font(.caption).lineLimit(1).truncationMode(.head)
                Spacer()
                Button {
                    store.restart(session)
                } label: {
                    Image(systemName: "arrow.clockwise").font(.caption)
                }
                .buttonStyle(.borderless)
                .disabled(session.state == "starting")
                .help("Restart shell")
                Button {
                    AppModel.shared.inspectorVisible = false
                } label: {
                    Image(systemName: "xmark").font(.caption)
                }
                .buttonStyle(.borderless)
                .help("Hide terminal (⌘J)")
            }
            .foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Theme.sidebar)
            Rectangle().fill(Theme.border).frame(height: 1)
            ZStack {
                ForEach(store.order, id: \.self) { id in
                    if let state = store.states[id] {
                        TerminalSurfaceView(context: state)
                            .opacity(id == session.id ? 1 : 0)
                            .allowsHitTesting(id == session.id)
                            .onChange(of: Self.surfaceIsVisible(id, selected: session.id, paneVisible: isVisible), initial: true) { _, _ in
                                store.surfaceVisibilityChanged(id, state: state, paneID: lifetime.id)
                            }
                            .onDisappear { store.surfaceDidDisappear(id, state: state, paneID: lifetime.id) }
                    }
                }
                if store.exited.contains(session.id) {
                    ExitedPlaceholder { store.restart(session) }
                } else if session.state == "starting" {
                    ProgressView("Preparing task…")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .onAppear { store.select(session, isVisible: isVisible, paneID: lifetime.id) }
        .onChange(of: session.id) { _, _ in store.select(session, isVisible: isVisible, paneID: lifetime.id) }
        .onChange(of: session.state) { _, _ in store.select(session, isVisible: isVisible, paneID: lifetime.id) }
        .onChange(of: isVisible) { _, visible in store.select(session, isVisible: visible, paneID: lifetime.id) }
        .onDisappear { store.paneDidDisappear(sessionId: session.id, paneID: lifetime.id) }
    }

    static func surfaceIsVisible(_ id: String, selected: String, paneVisible: Bool) -> Bool {
        paneVisible && id == selected
    }
}

private final class TerminalPaneLifetime: ObservableObject {
    let id = UUID()
}

private struct ExitedPlaceholder: View {
    let restart: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "terminal").font(.title2).foregroundStyle(Theme.faintForeground)
            Text("Shell exited").font(.callout).foregroundStyle(Theme.mutedForeground)
            Button("Restart Shell", action: restart)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }
}

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
    @Published private(set) var connections: [String: TerminalConnectionState] = [:]
    private var refs: [String: HostResourceRef] = [:]
    private var callbacks: [String: TerminalCallbacks] = [:]
    private let routing: HostClients?
    init(hosts: HostClients? = nil) { routing = hosts }
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

    private var hosts: HostClients { routing ?? AppModel.shared.hosts }

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
    func ensure(_ session: SessionSummary, ref: HostResourceRef) {
        let id = ref.storageKey
        if states[id] != nil {
            retention.touch(id)
            return
        }
        guard session.state != "starting", states[id] == nil, !exited.contains(id) else { return }
        start(session, ref: ref, restart: false)
    }

    /// Only the displayed surface is protected. A hidden tab/window has no active surface.
    func select(_ session: SessionSummary, ref: HostResourceRef, isVisible: Bool, paneID: UUID) {
        let id = ref.storageKey
        let shouldFocus = isVisible && (retention.visibleSessionId != id || !retention.ownsSurfaceCallbacks(paneID: paneID))
        retention.select(id, isVisible: isVisible, paneID: paneID)
        ensure(session, ref: ref)
        synchronizeSurfaceVisibility()
        if shouldFocus { states[id]?.requestFocus() }
        evictInactiveSurfaces()
    }

    func paneDidDisappear(sessionId: String, paneID: UUID) {
        guard retention.hide(sessionId: sessionId, paneID: paneID) else { return }
        states[sessionId]?.isSurfaceVisible = false
        evictInactiveSurfaces()
    }

    /// Moves keyboard focus into the shown terminal, as region focus does. False when none is shown.
    @discardableResult
    func focusVisible() -> Bool {
        guard let id = retention.visibleSessionId, let state = states[id] else { return false }
        state.requestFocus()
        return true
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

    func restart(_ session: SessionSummary, ref: HostResourceRef) {
        guard session.state != "starting" else { return }
        guard hosts.available.contains(ref.host) else { connections[ref.storageKey] = .disconnected; return }
        exited.remove(ref.storageKey)
        if states[ref.storageKey] != nil { remove(ref.storageKey) }
        start(session, ref: ref, restart: true)
    }

    func close(_ ref: HostResourceRef) {
        if !hosts.closeTerminal(ref) { connections[ref.storageKey] = .unavailable("Close was not delivered. Reconnect to inspect this shell.") }
    }

    private func start(_ session: SessionSummary, ref: HostResourceRef, restart: Bool) {
        guard ref.kind == .session, ref.localId == session.id else { return }
        let id = ref.storageKey
        let callback = TerminalCallbacks { [weak self] inputs, viewport, rejected, outputPaused in
            guard let self, self.refs[id] == ref else { return }
            var accepted = !rejected
            for data in inputs {
                if !self.hosts.terminalInput(ref, data: data) { accepted = false; break }
            }
            if let viewport { self.hosts.terminalResize(ref, cols: viewport.0, rows: viewport.1) }
            if let outputPaused { self.hosts.terminalReadPaused(ref, outputPaused) }
            if !accepted { self.connections[id] = .unavailable("Input was not accepted. Reconnect if needed; paste at most 16 KiB at once.") }
        }
        callback.setInputEnabled(false)
        callbacks[id] = callback
        refs[id] = ref
        connections[id] = .connecting
        let memory = InMemoryTerminalSession(
            write: { callback.write($0) },
            resize: { viewport in
                callback.resize(cols: Int(viewport.columns), rows: Int(viewport.rows))
            },
            suppressesPixelOnlyResizes: true
        )
        let state = TerminalViewState(controller: controller)
        memory.setOutputBacklogHandler(highWater: 512 * 1024, lowWater: 128 * 1024) { callback.backlog($0) }
        state.isSurfaceVisible = id == retention.visibleSessionId
        state.configuration = TerminalSurfaceOptions(backend: .inMemory(memory))
        state.onClose = { [weak self, weak state] _ in
            // Reported from a libghostty callback; change the view tree on the next turn.
            DispatchQueue.main.async {
                guard let self, let state, self.states[id] === state else { return }
                self.close(ref)
            }
        }
        states[id] = state
        memories[id] = memory
        // Covers shells created after workspace preparation and explicit restarts. Ghostty
        // replays this request once the new surface attaches to a window.
        if state.isSurfaceVisible { state.requestFocus() }
        order.append(id)
        retention.touch(id)
        do { try hosts.attachTerminal(ref, restart: restart, attachment: .init(
                cols: 80,
                rows: 24,
                onData: { [weak self] data in
                    memory.receive(data)
                    // Pause before requesting the next WebSocket frame, not after an unbounded
                    // queue of output has already reached the renderer's asynchronous parser.
                    if memory.pendingOutputByteCount >= 512 * 1024 { self?.hosts.terminalReadPaused(ref, true) }
                },
                onExit: { [weak self, weak state] code in
                    memory.finish(exitCode: UInt32(clamping: max(0, code)), runtimeMilliseconds: 0)
                    DispatchQueue.main.async {
                        guard let self, let state, self.states[id] === state else { return }
                        self.shellExited(id)
                    }
                },
                // Reset before the daemon replays scrollback, so reconnects do not duplicate output.
                onReplay: { memory.receive("\u{1B}c") },
                onStatus: { [weak self, weak state] status in
                    guard let self, let state, self.states[id] === state else { return }
                    callback.setInputEnabled(status == .connected)
                    self.connections[id] = status
                }
            ))
        } catch { connections[id] = .unavailable("This shell could not attach to its host.") }
        evictInactiveSurfaces()
    }

    private func shellExited(_ id: String) {
        guard states[id] != nil else { return }
        // The exited surface may hold keyboard focus; release it before it goes away.
        if let window = NSApp.keyWindow, window.firstResponder is NSView {
            window.makeFirstResponder(nil)
        }
        exited.insert(id)
        if exited.count > 128, let old = exited.first(where: { $0 != id }) { exited.remove(old) }
        remove(id)
    }

    /// Detaches the view; the daemon keeps the shell (if still running) for the next attach.
    func remove(_ id: String) {
        if let ref = refs.removeValue(forKey: id) { hosts.detachTerminal(ref) }
        callbacks.removeValue(forKey: id)?.close()
        memories[id]?.setOutputBacklogHandler(highWater: 512 * 1024, lowWater: 128 * 1024, nil)
        connections[id] = nil
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
    let ref: HostResourceRef
    @ObservedObject var hosts: HostClients
    var isVisible = true
    @State private var reconnecting = false
    @State private var reconnectError: String?
    private var key: String { ref.storageKey }

    var body: some View {
        VStack(spacing: 0) {
            InspectorPaneHeader("Shell", detail: {
                Text("\(ref.host.hostId == "local" ? "Local" : ref.host.hostId) · \(session.cwd)")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1).truncationMode(.head)
                    .help(session.cwd)
            }, trailing: {
                Menu {
                    Button("Restart shell") { store.restart(session, ref: ref) }
                    Button("Close shell") { store.close(ref) }
                } label: { PilotSymbol(PilotIcon.more, context: .toolbar) }
                .menuStyle(.borderlessButton)
                .disabled(session.state == "starting" || !hosts.available.contains(ref.host))
                .help("Shell actions")
            })
            if !hosts.available.contains(ref.host) {
                HStack {
                    Text("Disconnected. The shell may still be running on \(ref.host.hostId).")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    Spacer()
                    Button("Reconnect", action: reconnect).disabled(reconnecting)
                }.padding(8)
            } else if let status = store.connections[key] {
                switch status {
                case let .unavailable(message):
                    HStack {
                        Text(message).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        Spacer()
                        Button("Reconnect", action: reconnect).disabled(reconnecting)
                    }.padding(8)
                case .disconnected:
                    Text("Shell disconnected. Reconnecting without replaying input…")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).padding(8)
                case .closing:
                    Text("Closing shell. Waiting for process exit…")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).padding(8)
                case .connecting, .connected: EmptyView()
                }
            }
            if let reconnectError {
                Text(reconnectError).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).padding(8)
            }
            ZStack {
                ForEach(store.order, id: \.self) { id in
                    if let state = store.states[id] {
                        TerminalSurfaceView(context: state)
                            .opacity(id == key ? 1 : 0)
                            .allowsHitTesting(id == key && hosts.available.contains(ref.host) && store.connections[key] == .connected)
                            .onChange(of: Self.surfaceIsVisible(id, selected: key, paneVisible: isVisible), initial: true) { _, _ in
                                store.surfaceVisibilityChanged(id, state: state, paneID: lifetime.id)
                            }
                            .onDisappear { store.surfaceDidDisappear(id, state: state, paneID: lifetime.id) }
                    }
                }
                if store.exited.contains(key) {
                    ExitedPlaceholder { store.restart(session, ref: ref) }
                } else if session.state == "starting" {
                    ProgressView("Preparing task…")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .onAppear { store.select(session, ref: ref, isVisible: isVisible, paneID: lifetime.id) }
        .onChange(of: ref) { _, _ in store.select(session, ref: ref, isVisible: isVisible, paneID: lifetime.id) }
        .onChange(of: session.state) { _, _ in store.select(session, ref: ref, isVisible: isVisible, paneID: lifetime.id) }
        .onChange(of: isVisible) { _, visible in store.select(session, ref: ref, isVisible: visible, paneID: lifetime.id) }
        .onDisappear { store.paneDidDisappear(sessionId: key, paneID: lifetime.id) }
    }

    static func surfaceIsVisible(_ id: String, selected: String, paneVisible: Bool) -> Bool {
        paneVisible && id == selected
    }
    private func reconnect() {
        guard !reconnecting else { return }
        reconnecting = true
        reconnectError = nil
        Task { @MainActor in
            defer { reconnecting = false }
            do {
                if hosts.available.contains(ref.host) { try hosts.reconnectTerminal(ref) }
                else { try await hosts.reconnect(ref.host) }
            } catch { reconnectError = "Couldn't reconnect to this host. Check its connection settings." }
        }
    }
}

private final class TerminalPaneLifetime: ObservableObject {
    let id = UUID()
}

private struct ExitedPlaceholder: View {
    let restart: () -> Void

    var body: some View {
        EmptyStateView(icon: PilotIcon.terminal, title: "Shell exited",
                       message: "Restart the shell to run commands in this chat's workspace.") {
            Button("Restart Shell", action: restart)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }
}

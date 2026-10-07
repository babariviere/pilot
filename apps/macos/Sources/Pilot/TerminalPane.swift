import AppKit
import Combine
import GhosttyTerminal
import PilotCore
import SwiftUI

/// One libghostty terminal per session, rendering a shell that pilotd owns. The shell outlives the
/// app: reopening Pilot reattaches and replays its scrollback. Surfaces stay mounted while hidden so
/// switching sessions is instant. When a shell exits, its slot turns into a placeholder in place, so the
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
        guard states[session.id] == nil, !exited.contains(session.id) else { return }
        start(session, restart: false)
    }

    func restart(_ session: SessionSummary) {
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
        client.attachTerminal(
            id,
            cols: 80,
            rows: 24,
            restart: restart,
            .init(
                cols: 80,
                rows: 24,
                onData: { memory.receive($0) },
                onExit: { [weak self] code in
                    memory.finish(exitCode: UInt32(clamping: max(0, code)), runtimeMilliseconds: 0)
                    DispatchQueue.main.async { self?.shellExited(id) }
                },
                // Reset before the daemon replays scrollback, so reconnects do not duplicate output.
                onReplay: { memory.receive("\u{1B}c") }
            )
        )
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
    }
}

struct TerminalPane: View {
    @ObservedObject var store: TerminalStore
    let session: SessionSummary

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
                            .onChange(of: session.id, initial: true) { _, current in
                                state.isSurfaceVisible = current == id
                            }
                    }
                }
                if store.exited.contains(session.id) {
                    ExitedPlaceholder { store.restart(session) }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .onAppear { store.ensure(session) }
        .onChange(of: session.id) { _, _ in store.ensure(session) }
    }
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

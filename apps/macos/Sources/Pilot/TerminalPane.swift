import AppKit
import Combine
import GhosttyTerminal
import PilotCore
import SwiftUI

/// One libghostty terminal per session, in the session's working directory. Surfaces stay
/// mounted while hidden so switching sessions keeps their shells and scrollback. When a shell
/// exits, its slot turns into a placeholder in place, so the split view never loses its pane.
@MainActor
final class TerminalStore: ObservableObject {
    @Published private(set) var order: [String] = []
    /// Sessions whose shell has exited; their pane shows a restart placeholder.
    @Published private(set) var exited: Set<String> = []
    private(set) var states: [String: TerminalViewState] = [:]
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

    /// Starts the session's shell unless it is running or has exited (restart is explicit).
    func ensure(_ session: SessionSummary) {
        guard states[session.id] == nil, !exited.contains(session.id) else { return }
        start(session)
    }

    func restart(_ session: SessionSummary) {
        exited.remove(session.id)
        if states[session.id] != nil { remove(session.id) }
        start(session)
    }

    private func start(_ session: SessionSummary) {
        let state = TerminalViewState(controller: controller)
        state.configuration = TerminalSurfaceOptions(
            backend: .exec,
            workingDirectory: session.cwd,
            envVars: ["PILOT_SESSION_ID": session.id]
        )
        let id = session.id
        state.onClose = { [weak self, weak state] _ in
            // Ghostty reports from its callback; change the view tree on the next turn.
            DispatchQueue.main.async {
                guard let self, let state, self.states[id] === state else { return }
                self.shellExited(id)
            }
        }
        states[id] = state
        order.append(id)
    }

    private func shellExited(_ id: String) {
        // The exited surface may hold keyboard focus; release it before it goes away.
        if let window = NSApp.keyWindow, window.firstResponder is NSView {
            window.makeFirstResponder(nil)
        }
        exited.insert(id)
        remove(id)
    }

    private func remove(_ id: String) {
        states[id]?.isSurfaceVisible = false
        states[id] = nil
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
                    AppModel.shared.terminalVisible = false
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

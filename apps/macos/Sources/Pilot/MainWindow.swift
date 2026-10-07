import AppKit
import PilotCore
import SwiftUI

struct MainWindow: View {
    static let id = "main"

    @EnvironmentObject private var model: AppModel
    @ObservedObject private var daemon = AppModel.shared.daemon
    @ObservedObject private var client = AppModel.shared.client
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        NavigationSplitView {
            SessionSidebar(model: model, client: client)
                .navigationSplitViewColumnWidth(min: 230, ideal: 280, max: 400)
        } detail: {
            switch daemon.status {
            case .running:
                if let session = model.selectedSession {
                    SessionDetail(session: session)
                        .id(session.id)
                } else {
                    HomeView()
                        .navigationTitle("Pilot")
                }
            case let .failed(message):
                DaemonProblem(message: message)
            case .stopped:
                DaemonProblem(message: "pilotd is stopped.")
            case .unknown, .starting:
                ProgressView("Starting pilotd…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear {
            model.openWindowAction = { openWindow(id: MainWindow.id) }
            NSApp.setActivationPolicy(.regular)
        }
        .onDisappear {
            // The window is gone; stay available from the menu bar only.
            NSApp.setActivationPolicy(.accessory)
        }
    }
}

/// Chat on the left, the session's terminal on the right.
struct SessionDetail: View {
    let session: SessionSummary
    var feed: SessionFeed?
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HSplitView {
            ChatView(session: session, feed: feed)
                .frame(minWidth: 420, maxWidth: .infinity)
            if model.terminalVisible {
                TerminalPane(store: model.terminals, session: session)
                    .frame(minWidth: 320, idealWidth: 520, maxWidth: .infinity)
            }
        }
        .navigationTitle(session.title)
        .navigationSubtitle(subtitle)
        .toolbar {
            ToolbarItemGroup {
                StateBadge(state: session.state)
                Button {
                    NSWorkspace.shared.open(URL(filePath: session.cwd))
                } label: {
                    Label("Open in Finder", systemImage: "folder")
                }
                .help("Open \(session.cwd.abbreviatingHome) in Finder")
                Toggle(isOn: $model.terminalVisible) {
                    Label("Terminal", systemImage: "terminal")
                }
                .help("Toggle terminal (⌘J)")
            }
        }
    }

    private var subtitle: String {
        let place = client.project(session.projectId)?.name ?? session.cwd.abbreviatingHome
        return [place, session.branch, session.model].compactMap { $0 }.joined(separator: " · ")
    }
}

private struct DaemonProblem: View {
    let message: String
    @ObservedObject private var daemon = AppModel.shared.daemon

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(.orange)
            Text(message).multilineTextAlignment(.center).textSelection(.enabled)
            HStack {
                Button("Start pilotd") { Task { await daemon.restart() } }
                Button("Open Log") { NSWorkspace.shared.open(daemon.logURL) }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

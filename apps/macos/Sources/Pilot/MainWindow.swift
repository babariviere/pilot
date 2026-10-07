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
                } else if model.showingArchive {
                    ArchiveView()
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
        .alert("Session action failed", isPresented: Binding(
            get: { model.sessionActionError != nil },
            set: { if !$0 { model.sessionActionError = nil } }
        )) {
            Button("OK") { model.sessionActionError = nil }
        } message: {
            Text(model.sessionActionError ?? "")
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

/// Chat on the left, the inspector (changes, terminal) on the right.
struct SessionDetail: View {
    let session: SessionSummary
    var feed: SessionFeed?
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HSplitView {
            ChatView(session: session, feed: feed)
                .frame(minWidth: 420, maxWidth: .infinity)
            if model.inspectorVisible {
                Inspector(session: session)
                    .frame(minWidth: 340, idealWidth: 520, maxWidth: .infinity)
            }
        }
        .navigationTitle(session.title)
        .navigationSubtitle(subtitle)
        .toolbar {
            ToolbarItemGroup {
                SessionStatusIcon(status: session.status)
                if model.isUnread(session) { UnreadBadge() }
                PullRequestBadge(session: session)
                if session.isArchived {
                    Button { model.showArchive(in: model.archiveProjectId) } label: {
                        Label("Archived chats", systemImage: "archivebox")
                    }
                }
                SessionArchiveAction(session: session)
                if let branch = session.branch {
                    Label(branch, systemImage: "arrow.triangle.branch")
                        .labelStyle(.titleAndIcon)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.mutedForeground)
                        .lineLimit(1)
                        .help("Private clone on \(branch)")
                }
                Button {
                    NSWorkspace.shared.open(URL(filePath: session.cwd))
                } label: {
                    Label("Open in Finder", systemImage: "folder")
                }
                .help("Open \(session.cwd.abbreviatingHome) in Finder")
                InspectorToggle(tab: .changes, icon: "plusminus", help: "Changes (⇧⌘D)")
                InspectorToggle(tab: .terminal, icon: "terminal", help: "Terminal (⌘J)")
            }
        }
    }

    private var subtitle: String {
        let place = client.project(session.projectId)?.name ?? session.cwd.abbreviatingHome
        return [place, session.model].compactMap { $0 }.joined(separator: " · ")
    }
}

struct InspectorToggle: View {
    let tab: InspectorTab
    let icon: String
    let help: String
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let active = model.inspectorVisible && model.inspectorTab == tab
        Button { model.toggleInspector(tab) } label: {
            Image(systemName: icon)
                .foregroundStyle(active ? Theme.foreground : Theme.mutedForeground)
                .frame(width: 26, height: 22)
                .background(RoundedRectangle(cornerRadius: 6).fill(active ? Theme.selected : .clear))
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// Right-hand pane with tabs. Both tabs stay mounted so the terminal keeps its surface.
struct Inspector: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                tab("Changes", .changes)
                tab("Terminal", .terminal)
                Spacer()
                Button { model.inspectorVisible = false } label: {
                    Image(systemName: "sidebar.right").font(.system(size: 12))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.mutedForeground)
                .help("Hide inspector")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Theme.sidebar)
            Rectangle().fill(Theme.border).frame(height: 1)
            ZStack {
                ChangesPane(session: session)
                    .opacity(model.inspectorTab == .changes ? 1 : 0)
                    .allowsHitTesting(model.inspectorTab == .changes)
                // Mounted once opened, so looking at changes never starts a shell.
                if model.inspectorTab == .terminal || model.terminals.order.contains(session.id) {
                    TerminalPane(store: model.terminals, session: session)
                        .opacity(model.inspectorTab == .terminal ? 1 : 0)
                        .allowsHitTesting(model.inspectorTab == .terminal)
                }
            }
        }
        .background(Theme.background)
    }

    private func tab(_ title: String, _ value: InspectorTab) -> some View {
        Button { model.inspectorTab = value } label: {
            Text(title)
                .font(.system(size: 12, weight: model.inspectorTab == value ? .semibold : .regular))
                .foregroundStyle(model.inspectorTab == value ? Theme.foreground : Theme.mutedForeground)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 6).fill(model.inspectorTab == value ? Theme.card : .clear))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(model.inspectorTab == value ? Theme.border : .clear))
        }
        .buttonStyle(.plain)
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

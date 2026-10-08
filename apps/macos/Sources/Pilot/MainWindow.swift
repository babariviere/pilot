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
            // SwiftUI owns the window lifecycle; scene IDs need not be NSWindow identifiers.
            model.flushDrafts()
            // The window is gone; stay available from the menu bar only.
            NSApp.setActivationPolicy(.accessory)
        }
    }
}

/// Chat on the left, the inspector (changes, terminal, artifacts) on the right.
struct SessionDetail: View {
    let session: SessionSummary
    var feed: SessionFeed?
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HSplitView {
            ChatView(session: session, feed: feed, composer: model.composer(for: session.id))
                .frame(minWidth: 420, maxWidth: .infinity)
            if model.inspectorVisible && model.inspectorTab.isAvailable(for: session) {
                Inspector(session: session)
                    .frame(minWidth: 340, idealWidth: 520, maxWidth: .infinity)
            }
        }
        .navigationTitle(session.title)
        .navigationSubtitle(subtitle)
        .toolbar {
            repositoryToolbar
            ToolbarItem(placement: .primaryAction) {
                SessionInspectorActions(session: session)
            }
            if #available(macOS 26.0, *) {
                ToolbarSpacer(.fixed, placement: .primaryAction)
            }
            ToolbarItem(placement: .primaryAction) {
                SessionMoreActions(session: session)
            }
        }
    }

    @ToolbarContentBuilder
    private var repositoryToolbar: some ToolbarContent {
        if model.isUnread(session) || (!session.isAsk &&
            (session.branch != nil || session.pullRequest != nil || session.pullRequestError != nil)) {
            if #available(macOS 26.0, *) {
                repositoryToolbarItem.sharedBackgroundVisibility(.hidden)
            } else {
                repositoryToolbarItem
            }
        }
    }

    private var repositoryToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            HStack(spacing: 8) {
                if model.isUnread(session) { UnreadBadge() }
                SessionToolbarMetadata(session: session)
            }
        }
    }

    private var subtitle: String {
        let place = client.project(session.projectId)?.name ?? session.cwd.abbreviatingHome
        return [place, session.model].compactMap { $0 }.joined(separator: " · ")
    }
}

/// Read-only repository context sits beside, not inside, the toolbar's action group.
struct SessionToolbarMetadata: View {
    let session: SessionSummary

    var body: some View {
        if !session.isAsk {
            HStack(spacing: 8) {
                if let branch = session.branch, !branch.isEmpty {
                    HStack(spacing: 5) {
                        Image(nsImage: GitBranchGlyph.image)
                            .resizable()
                            .frame(width: 14, height: 14)
                            .accessibilityHidden(true)
                        Text(branch)
                            .font(.system(size: 11, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .foregroundStyle(Theme.mutedForeground)
                    .frame(maxWidth: 260)
                    .help("Branch: \(branch)")
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Branch \(branch)")
                }
                PullRequestBadge(session: session)
            }
        }
    }
}

struct SessionInspectorActions: View {
    let session: SessionSummary

    var body: some View {
        HStack(spacing: 2) {
            if !session.isAsk {
                InspectorToggle(tab: .changes, icon: "plusminus", help: "Changes (⇧⌘D)")
                InspectorToggle(tab: .terminal, icon: "terminal", help: "Terminal (⌘J)")
            }
            InspectorToggle(tab: .artifacts, icon: "cube.transparent", help: "Artifacts")
        }
    }
}

struct SessionMoreActions: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Menu {
            SessionArchiveAction(session: session)
            if session.isArchived {
                Button { model.showArchive(in: model.archiveProjectId) } label: {
                    Label("Archived chats", systemImage: "archivebox")
                }
            }
            Divider()
            Button { model.debugSession(session) } label: {
                Label("Debug session", systemImage: "ladybug")
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuIndicator(.hidden)
        .help("More session actions")
        .accessibilityLabel("More session actions")
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
        .accessibilityLabel(help)
    }
}

/// Right-hand pane with tabs. The terminal stays mounted once opened to keep its surface.
struct Inspector: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                if !session.isAsk {
                    tab("Changes", .changes)
                    tab("Terminal", .terminal)
                }
                tab("Artifacts", .artifacts)
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
                if !session.isAsk {
                    ChangesPane(session: session, isVisible: model.inspectorTab == .changes)
                        .opacity(model.inspectorTab == .changes ? 1 : 0)
                        .allowsHitTesting(model.inspectorTab == .changes)
                        .accessibilityHidden(model.inspectorTab != .changes)
                }
                // Mounted once opened, so browsing other tabs never starts a shell.
                if !session.isAsk && (model.inspectorTab == .terminal || model.terminals.order.contains(session.id)) {
                    TerminalPane(store: model.terminals, session: session, isVisible: model.inspectorTab == .terminal)
                        .opacity(model.inspectorTab == .terminal ? 1 : 0)
                        .allowsHitTesting(model.inspectorTab == .terminal)
                        .accessibilityHidden(model.inspectorTab != .terminal)
                }
                if model.inspectorTab == .artifacts {
                    SessionArtifactsPane(sessionId: session.id, client: model.client)
                        .id(session.id)
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

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
            contextToolbar
            SessionInspectorActions(session: session)
            if #available(macOS 26.0, *) {
                ToolbarSpacer(.fixed, placement: .primaryAction)
            }
            ToolbarItem(placement: .primaryAction) {
                SessionMoreActions(session: session)
            }
        }
    }

    @ToolbarContentBuilder
    private var contextToolbar: some ToolbarContent {
        if #available(macOS 26.0, *) {
            contextToolbarItem.sharedBackgroundVisibility(.hidden)
        } else {
            contextToolbarItem
        }
    }

    @ToolbarContentBuilder
    private var contextToolbarItem: some ToolbarContent {
        if model.isUnread(session) || session.isAsk {
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: 8) {
                    if model.isUnread(session) { UnreadBadge() }
                    // Ask has no Changes pane, so its read-only boundary stays visible here.
                    if session.isAsk { SessionContextBadge(session: session) }
                }
            }
        }
    }

    private var subtitle: String {
        let place = client.project(session.projectId)?.name ?? session.cwd.abbreviatingHome
        return SessionHeaderContext.subtitle(for: session, place: place)
    }
}

/// Keep orientation in the title area, leaving workspace and PR details to Changes.
enum SessionHeaderContext {
    static func source(for session: SessionSummary) -> String? {
        let source = session.isAsk ? session.sourceLabel : session.branch
        return source.flatMap { $0.isEmpty ? nil : $0 }
    }

    static func subtitle(for session: SessionSummary, place: String) -> String {
        [place, source(for: session)].compactMap { $0 }.joined(separator: " · ")
    }
}

struct SessionInspectorActions: ToolbarContent {
    let session: SessionSummary

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            SessionInspectorControls(session: session)
        }
    }
}

/// No custom container: the toolbar owns control spacing, backgrounds and selection.
struct SessionInspectorControls: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    @ViewBuilder
    var body: some View {
        if !session.isAsk {
            InspectorToggle(tab: .changes, icon: "plusminus", help: "Changes (⇧⌘D)")
            InspectorToggle(tab: .terminal, icon: "terminal", help: "Terminal (⌘J)")
            if !(session.subagents ?? []).isEmpty {
                InspectorToggle(tab: .agents, icon: "person.2", help: "Subagents")
                    .overlay(alignment: .topTrailing) {
                        if model.unreadSubagents(in: session) > 0 {
                            Circle().fill(Theme.success).frame(width: 6, height: 6).offset(x: -3, y: 3)
                        }
                    }
            }
        }
        InspectorToggle(tab: .artifacts, icon: "cube.transparent", help: "Artifacts")
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
                .frame(width: 36, height: 36)
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
        Toggle(isOn: Self.selection(for: tab, in: model)) {
            Image(systemName: icon)
        }
        .toggleStyle(.button)
        .help(help)
        .accessibilityLabel(help)
    }

    @MainActor
    static func selection(for tab: InspectorTab, in model: AppModel) -> Binding<Bool> {
        Binding(
            get: { model.inspectorVisible && model.inspectorTab == tab },
            set: { selected in
                // Ignore redundant writes; selecting another tab must keep the pane open.
                if selected != (model.inspectorVisible && model.inspectorTab == tab) {
                    model.toggleInspector(tab)
                }
            }
        )
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
                    tab("Agents", .agents, badge: model.unreadSubagents(in: session))
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
                if !session.isAsk && model.inspectorTab == .agents {
                    SubagentsPane(session: session)
                        .id(session.id)
                }
            }
        }
        .background(Theme.background)
    }

    private func tab(_ title: String, _ value: InspectorTab, badge: Int = 0) -> some View {
        Button { model.inspectorTab = value } label: {
            HStack(spacing: 5) {
                Text(title)
                    .font(.system(size: 12, weight: model.inspectorTab == value ? .semibold : .regular))
                    .foregroundStyle(model.inspectorTab == value ? Theme.foreground : Theme.mutedForeground)
                if badge > 0 {
                    Text("\(badge)")
                        .font(.system(size: 9, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Theme.success))
                        .accessibilityLabel("\(badge) new answers")
                }
            }
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

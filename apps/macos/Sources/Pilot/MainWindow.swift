import AppKit
import PilotCore
import PilotTelemetry
import SwiftUI

struct MainWindow: View {
    @Environment(\.hostViewContext) private var hostContext
    static let id = "main"

    @EnvironmentObject private var model: AppModel
    @ObservedObject private var daemon = AppModel.shared.daemon
    @EndpointClient private var client
    @ObservedObject private var hosts = AppModel.shared.hosts
    @Environment(\.openWindow) private var openWindow
    @State private var repositoryPollingVisible = false

    @ViewBuilder private var localDetail: some View {
        switch daemon.status {
        case .running:
            if let session = model.selectedSession {
                SessionDetail(session: session)
                    .id(session.id)
            } else if let missionId = model.selectedMissionId {
                MissionPage(missionId: missionId)
                    .id(missionId)
            } else if let projectId = model.selectedProjectId {
                if model.slackTriageProjectId == projectId {
                    SlackTriagePage(projectId: projectId, openCase: model.slackTriageCaseId)
                        .id("slack-triage-\(projectId)-\(model.slackTriageCaseId ?? "")")
                } else if model.memoryProjectId == projectId {
                    MemoryPage(projectId: projectId, context: model.localHost.map { HostViewContext(host: $0, hosts: hosts) })
                        .id("memory-\(projectId)")
                } else {
                    ProjectPage(projectId: projectId)
                        .id(projectId)
                }
            } else if model.showingControl {
                ControlScreen()
            } else if model.showingInbox {
                InboxPage().environment(\.hostViewContext, model.inboxHost.map { HostViewContext(host: $0, hosts: hosts) } ?? model.localHost.map { HostViewContext(host: $0, hosts: hosts) })
            } else if model.showingArchive {
                ArchiveView().environment(\.hostViewContext, model.archiveHost.map { HostViewContext(host: $0, hosts: hosts) } ?? model.localHost.map { HostViewContext(host: $0, hosts: hosts) })
            } else {
                HomeView()
                    .navigationTitle("Pilot")
            }
        case let .failed(message):
            if !hosts.offlineHosts.isEmpty { HomeView() } else { DaemonProblem(message: message) }
        case .stopped:
            if !hosts.offlineHosts.isEmpty { HomeView() } else { DaemonProblem(message: "pilotd is stopped.") }
        case .unknown, .starting:
            ProgressView("Starting pilotd…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    var body: some View {
        NavigationSplitView {
            SessionSidebar(model: model, client: client)
                .navigationSplitViewColumnWidth(min: 230, ideal: 280, max: 400)
        } detail: {
            Group {
                if let id = model.selectedMissionId, let ref = model.resourceRef(id, kind: .mission) {
                    LogicalMissionDestination(reference: ref, model: model, registry: model.missionRegistry)
                        .id(ref.storageKey)
                } else if let ref = hosts.selection, ref.host != model.localHost, ref.kind == .session,
                   let hosted = hosts.sessions.first(where: { $0.ref == ref }) {
                    SessionDetail(session: hosted.value, context: HostViewContext(host: ref.host, hosts: hosts))
                        .environment(\.hostViewContext, HostViewContext(host: ref.host, hosts: hosts))
                        .environment(\.openURL, HostViewContext(host: ref.host, hosts: hosts).openURL)
                        .id(ref.storageKey)
                } else if let ref = hosts.selection, ref.host != model.localHost, ref.kind == .project {
                    Group {
                        if model.slackTriageProjectId == ref.storageKey {
                            SlackTriagePage(projectId: ref.localId, openCase: model.slackTriageCaseId)
                        } else if model.memoryProjectId == ref.storageKey {
                            MemoryPage(projectId: ref.localId, context: HostViewContext(host: ref.host, hosts: hosts))
                        } else { ProjectPage(projectId: ref.localId) }
                    }
                        .environment(\.hostViewContext, HostViewContext(host: ref.host, hosts: hosts))
                        .environment(\.openURL, HostViewContext(host: ref.host, hosts: hosts).openURL)
                        .id(ref.storageKey)
                } else if let ref = hosts.selection, ref.host != model.localHost, ref.kind == .mission {
                    MissionPage(missionId: ref.localId)
                        .environment(\.hostViewContext, HostViewContext(host: ref.host, hosts: hosts))
                        .environment(\.openURL, HostViewContext(host: ref.host, hosts: hosts).openURL)
                        .id(ref.storageKey)
                } else if let ref = hosts.selection, ref.host != model.localHost {
                    EmptyStateView(icon: PilotIcon.message, title: "Chat unavailable", message: "Reconnect to load this chat.")
                } else {
                    localDetail
                }
            }
            .keyboardRegion(.content)
        }
        .sheet(isPresented: $model.githubImportPresented) {
            GitHubImportSheet(hosts: hosts, localHost: model.localHost, initialURL: model.githubImportURL,
                initialHost: model.githubImportHost) { project in
                    model.githubImportPresented = false
                    model.openProject(project.value.id, context: HostViewContext(host: project.ref.host, hosts: hosts))
                }
        }
        .environment(\.keyboardFocus, model.keyboard)
        .environment(\.hostViewContext, model.localHost.map { HostViewContext(host: $0, hosts: hosts) })
        .environment(\.repositoryPollingVisible, repositoryPollingVisible)
        .background(RepositoryWindowVisibility { visible in
            if visible { client.refreshRepositoryCaches() }
            repositoryPollingVisible = visible
        }.frame(width: 0, height: 0))
        .alert("Chat action failed", isPresented: Binding(
            get: { model.sessionActionError != nil },
            set: { if !$0 { model.sessionActionError = nil } }
        )) {
            Button("OK") { model.sessionActionError = nil }
        } message: {
            Text(model.sessionActionError ?? "")
        }
        .alert("Project action failed", isPresented: Binding(
            get: { model.projectActionError != nil },
            set: { if !$0 { model.projectActionError = nil } }
        )) {
            Button("OK") { model.projectActionError = nil }
        } message: {
            Text(model.projectActionError ?? "")
        }
        .confirmationDialog("Delete this mission?", isPresented: Binding(
            get: { model.pendingMissionDeletionId != nil },
            set: { if !$0 { model.pendingMissionDeletionId = nil } }
        ), presenting: model.pendingMissionDeletionId) { missionId in
            Button("Delete Mission", role: .destructive) {
                model.missionAction { try await model.deleteMission(missionId) }
            }
        } message: { _ in
            Text("Its brief, tasks and activity are deleted. Member chats are kept and detached from the mission.")
        }
        .sheet(item: $model.missionSheet) { sheet in
            MissionSheetView(sheet: sheet).environmentObject(model)
                .environment(\.hostViewContext, model.missionSheetContext ?? hostContext)
        }
        .sheet(item: $model.artifactLink) { link in
            ArtifactLinkView(link: link).id(link.id)
                .environment(\.hostViewContext, model.artifactLinkContext ?? hostContext)
        }
        .sheet(item: $model.renamingSession) { target in
            SessionRenameSheet(target: target).environmentObject(model)
                .environment(\.hostViewContext, model.resourceRef(target.id, kind: .session).map { HostViewContext(host: $0.host, hosts: hosts) })
        }
        .sheet(item: $model.mergingPullRequest) { target in
            PullRequestMergeSheet(target: target).environmentObject(model)
                .environment(\.hostViewContext, target.reference.map { HostViewContext(host: $0.host, hosts: hosts) } ?? hostContext)
        }
        .sheet(item: $model.diagnosticRepairTarget) { target in
            DiagnosticRepairSheet(target: target).environmentObject(model)
        }
        .sheet(item: $model.diagnosticSetupTarget) { target in
            DiagnosticSetupSheet(setup: target).environmentObject(model)
        }
        .sheet(isPresented: $model.showingCommandPalette, onDismiss: {
            let action = model.commandPaletteAction
            model.commandPaletteAction = nil
            action?()
        }) {
            CommandPaletteView().environmentObject(model)
        }
        .onAppear {
            model.missionRegistry.start(model)
            model.openWindowAction = { openWindow(id: MainWindow.id) }
            model.openKeyboardShortcutsAction = { openWindow(id: KeyboardShortcuts.windowID) }
            KeyboardRouter.shared.install(focus: model.keyboard) { [weak appModel = model] route in
                appModel?.performKeyboardRoute(route) ?? false
            }
            NSApp.setActivationPolicy(.regular)
        }
        .onDisappear {
            model.missionRegistry.stop()
            // SwiftUI owns the window lifecycle; scene IDs need not be NSWindow identifiers.
            model.flushDrafts()
            // Closing the window leaves the open chat, so a result read there leaves Needs you.
            model.leaveOpenChat()
            // The window is gone; stay available from the menu bar only.
            NSApp.setActivationPolicy(.accessory)
        }
    }
}

/// Chat on the left, the inspector (changes, terminal, artifacts) on the right.
struct SessionDetail: View {
    let session: SessionSummary
    var feed: SessionFeed?
    var context: HostViewContext? = nil
    @EnvironmentObject private var model: AppModel
    @Environment(\.hostViewContext) private var hostContext
    @EndpointClient private var client
    @StateObject private var slack = SessionSlackLinks()


    @ViewBuilder var body: some View {
        if let reference = (context ?? hostContext)?.ref(.session, session.id),
           PreviousControl.isHistory(session, reference: reference, localHost: model.localHost) {
            PreviousControlHistoryView(reference: reference, hosts: model.hosts)
        } else { liveDetail }
    }

    private var liveDetail: some View {
        ChatInspectorSplit(showsInspector: model.inspectorVisible && model.inspectorTab.isAvailable(for: session)) {
            ChatView(session: session, feed: feed, context: context ?? model.localHost.map { HostViewContext(host: $0, hosts: model.hosts) })
        } inspector: {
            Inspector(session: session, feed: feed, context: context ?? model.localHost.map { HostViewContext(host: $0, hosts: model.hosts) })
        }
        .navigationTitle(session.title)
        .navigationSubtitle(subtitle)
        .task(id: SessionSlackLinks.Key(client: ObjectIdentifier(client), sessionId: session.id,
                                        projectId: session.isAsk ? nil : session.projectId)) {
            // Ask chats never take a Slack message's work, and the control chat has no project.
            slack.attach(client: client, sessionId: session.id, projectId: session.isAsk ? nil : session.projectId)
        }
        .onDisappear { slack.detach() }
        .toolbar {
            contextToolbar
            if !slack.items.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    SessionSlackMenu(links: slack, context: context)
                }
            }
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
        // The control chat is Ask underneath, but it acts through its tools, so the Ask badge would mislead.
        let showsAsk = session.isAsk && !session.isControl
        if RemoteChatBadgeText(context: context) != nil
            || (context.map { model.isUnread(session, on: $0.host) } ?? model.isUnread(session)) || showsAsk
            || AttemptsMenu.label(for: session.attempts ?? []) != nil || session.trackedSource != nil {
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: 8) {
                    RemoteChatBadge(context: context)
                    if let source = session.trackedSource {
                        TrackedSourceBadge(source: source, projectId: session.projectId, context: context)
                    }
                    if (context.map { model.isUnread(session, on: $0.host) } ?? model.isUnread(session)) { UnreadBadge() }
                    AttemptsMenu(session: session)
                    // Ask has no Changes pane, so its read-only boundary stays visible here.
                    if showsAsk { SessionContextBadge(session: session) }
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
        let source = session.isMissionCoordinator ? nil : (session.isAsk ? session.sourceLabel : session.branch)
        return source.flatMap { $0.isEmpty ? nil : $0 }
    }

    static func subtitle(for session: SessionSummary, place: String) -> String {
        // The control chat has no project, checkout or source: it spans them all.
        if session.isControl { return ControlChatIdentity.scope }
        return [place, source(for: session)].compactMap { $0 }.joined(separator: " · ")
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
    @Environment(\.hostViewContext) private var hostContext
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    @ViewBuilder
    var body: some View {
        if session.missionId != nil {
            SessionMissionControl(session: session)
        }
        if session.isControl {
            InspectorToggle(tab: .watching, icon: PilotIcon.watch, help: "Watching and actions")
        }
        if session.supportsChanges {
            InspectorToggle(tab: .changes, icon: PilotIcon.changes, help: "Changes (⇧⌘D)")
            InspectorToggle(tab: .terminal, icon: PilotIcon.terminal, help: "Terminal (⌘J)")
        }
        if !session.isAsk {
            // Also while the Agents tab is open, so the toggle that closes it never disappears.
            if !(session.subagents ?? []).isEmpty || (model.inspectorVisible && model.inspectorTab == .agents) {
                InspectorToggle(tab: .agents, icon: PilotIcon.subagents, help: "Subagents")
            }
        }
        InspectorToggle(tab: .artifacts, icon: PilotIcon.artifact, help: "Artifacts")
        InspectorToggle(tab: .links, icon: PilotIcon.link, help: "Links")
    }
}

struct SessionMoreActions: View {
    @Environment(\.hostViewContext) private var hostContext
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Menu {
            SessionProjectAction(session: session)
            SessionRenameAction(session: session)
            SessionClipboardActions(session: session)
            Divider()
            SessionMissionActions(session: session)
            Divider()
            SessionArchiveAction(session: session)
            if session.isArchived {
                Button { model.showArchive(in: model.archiveProjectId, missionId: model.archiveMissionId) } label: {
                    Label("Archived chats", icon: PilotIcon.archive)
                }
            }
            Divider()
            if session.isDiagnosticsSpecialist {
                Button { model.prepareDiagnosticRepair(session, context: hostContext) } label: {
                    Label(session.diagnosticRepairProposal == nil ? "Suggest a repair…" : "Review repair proposal…",
                          icon: PilotIcon.handoff)
                }
            } else {
                Button { model.diagnose(session, context: hostContext) } label: {
                    Label(session.isControl ? "Ask about Pilot" : "Diagnose this chat", icon: PilotIcon.bug)
                }
                .disabled(model.isDiagnosing(session, context: hostContext))
                .onAppear {
                    guard !session.isControl else { return }
                    let availability: FeatureAvailability = (hostContext?.available ?? model.client.connected)
                        ? .available : .disconnected
                    PilotTelemetry.shared.recordFeature(.eligibility(.diagnoseChat, availability))
                    PilotTelemetry.shared.recordFeature(.exposure(.diagnoseChat))
                }
            }
        } label: {
            PilotSymbol(PilotIcon.more, context: .toolbar)
                .frame(width: 36, height: 36)
        }
        .menuIndicator(.hidden)
        .help("More chat actions")
        .accessibilityLabel("More chat actions")
    }
}

struct InspectorToggle: View {
    let tab: InspectorTab
    let icon: PilotIcon
    let help: String
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Toggle(isOn: Self.selection(for: tab, in: model)) {
            PilotSymbol(icon, context: .toolbar)
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

/// Right-hand pane. The toolbar's inspector toggles are its only picker (each pane has its own header), so the
/// selected tab never shows in two places. The terminal stays mounted once opened to keep its surface.
struct Inspector: View {
    let session: SessionSummary
    /// The chat's feed for the Links tab. Nil uses the cached feed the transcript shares.
    var feed: SessionFeed? = nil
    var context: HostViewContext? = nil
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var endpoint

    var body: some View {
        ZStack {
            if session.supportsChanges {
                ChangesPane(session: session, isVisible: model.inspectorTab == .changes)
                    .opacity(model.inspectorTab == .changes ? 1 : 0)
                    .allowsHitTesting(model.inspectorTab == .changes)
                    .accessibilityHidden(model.inspectorTab != .changes)
            }
            // Mounted once opened, so browsing other tabs never starts a shell.
            if let host = context?.host ?? model.localHost, session.supportsChanges,
               model.inspectorTab == .terminal || model.terminals.order.contains(HostResourceRef(host: host, kind: .session, localId: session.id).storageKey) {
                TerminalPane(store: model.terminals, session: session,
                             ref: HostResourceRef(host: host, kind: .session, localId: session.id),
                             hosts: model.hosts, isVisible: model.inspectorTab == .terminal)
                    .opacity(model.inspectorTab == .terminal ? 1 : 0)
                    .allowsHitTesting(model.inspectorTab == .terminal)
                    .accessibilityHidden(model.inspectorTab != .terminal)
            }
            if model.inspectorTab == .artifacts {
                SessionArtifactsPane(sessionId: session.id, client: endpoint)
                    .id(session.id)
            }
            if !session.isAsk && model.inspectorTab == .agents {
                SubagentsPane(session: session)
                    .id(session.id)
            }
            if model.inspectorTab == .mission, session.missionId != nil {
                MissionInspectorPane(session: session)
                    .id(session.id)
            }
            if model.inspectorTab == .links {
                SessionLinksPane(feed: feed ?? context.map { model.feeds.feed(ref: $0.ref(.session, session.id), hosts: $0.hosts) } ?? model.feeds.feed(sessionId: session.id, client: model.client))
                    .id(session.id)
            }
            if model.inspectorTab == .watching, session.isControl {
                ControlDetailsPane(client: endpoint, context: context)
                    .id(session.id)
            }
        }
        .background(Theme.background)
        .keyboardRegion(.inspector) { [model] in
            // Other panes' lists take focus with their own handlers, or the first native key view does.
            model.inspectorTab == .terminal && model.terminals.focusVisible()
        }
    }
}

private struct DaemonProblem: View {
    let message: String
    @ObservedObject private var daemon = AppModel.shared.daemon

    var body: some View {
        EmptyStateView(icon: PilotIcon.warning, title: "pilotd isn't running", message: message) {
            Button("Start pilotd") { Task { await daemon.restart() } }
            Button("Open Log") { NSWorkspace.shared.open(daemon.logURL) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

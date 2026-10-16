import AppKit
import PilotCore
import SwiftUI

/// Free text for small add/edit forms, held in each view's @State.
struct MissionInput {
    var text = ""
    var secondary = ""
    var option: String?
    var busy = false
    var editingId: String?
    var confirming = false

    func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// The main detail area for a selected mission. The window toolbar carries the title, the section
/// picker and the primary actions, like a chat; the page itself starts with content.
struct MissionPage: View {
    @Environment(\.hostViewContext) private var hostContext
    let missionId: String
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client
    @State private var width: CGFloat = 1000

    var body: some View {
        Group {
            if let mission = client.mission(missionId) {
                content(mission, detail: client.missionDetails[missionId])
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .navigationTitle(mission.title)
                    .navigationSubtitle(subtitle(mission))
                    .toolbar {
                        MissionToolbar(mission: mission, model: model,
                                       compactTabs: width < MissionPage.compactTabsWidth)
                    }
            } else {
                EmptyStateView(icon: PilotIcon.mission, title: "This mission no longer exists",
                               message: "It was deleted. Its chats are kept in their project.")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.background)
        .background(GeometryReader { geometry in
            Color.clear
                .onAppear { width = geometry.size.width }
                .onChange(of: geometry.size.width) { _, value in width = value }
        })
        .missionSubscription(missionId, client: client)
        // Prepare the brief's Markdown off the main thread as soon as it arrives, so opening Brief only
        // lays out the blocks on screen.
        .task(id: client.missionDetails[missionId]?.brief?.revision) {
            if let markdown = client.missionDetails[missionId]?.brief?.markdown { await MarkdownView.prewarm(markdown) }
        }
    }

    /// Below this detail width the section control becomes a pop-up button.
    static let compactTabsWidth: CGFloat = 760

    private func subtitle(_ mission: Mission) -> String {
        [client.project(mission.projectId)?.name, mission.status.label].compactMap { $0 }.joined(separator: " · ")
    }

    @ViewBuilder
    private func content(_ mission: Mission, detail: MissionDetail?) -> some View {
        if let detail {
            MissionTabContent(mission: mission, detail: detail, selection: model.missionTabSelection,
                              briefEditor: model.briefEditor(for: hostContext?.ref(.mission, mission.id).storageKey ?? mission.id))
        } else {
            ProgressView("Loading mission…")
        }
    }
}

/// The selected section in one scroll view shared by every tab, in the page's reading column.
///
/// Only this view and the section picker observe tab switches. Keeping a single scroll view matters: a new
/// scroll view makes AppKit rebuild the window toolbar, which cost more than a small tab itself.
private struct MissionTabContent: View {
    let mission: Mission
    let detail: MissionDetail
    @ObservedObject var selection: MissionTabSelection
    let briefEditor: BriefEditorState
    private static let top = "mission-tab-top"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Color.clear.frame(height: 0).id(Self.top)
                    tab(proxy)
                        .padding(.horizontal, 32)
                        .padding(.vertical, 24)
                        .frame(maxWidth: Theme.column, alignment: .leading)
                        .frame(maxWidth: .infinity)
                }
            }
            // Each section opens at its top, like a page.
            .onChange(of: selection.tab) { _, _ in proxy.scrollTo(Self.top, anchor: .top) }
        }
    }

    @ViewBuilder private func tab(_ proxy: ScrollViewProxy) -> some View {
        switch selection.tab {
        case .overview: MissionOverviewTab(mission: mission, detail: detail)
        case .brief: MissionBriefTab(mission: mission, detail: detail, editor: briefEditor)
        case .tasks: MissionTasksTab(mission: mission, detail: detail, scroll: proxy)
        case .chats: MissionChatsTab(mission: mission, detail: detail)
        case .artifacts: MissionArtifactsTab(mission: mission, detail: detail)
        case .activity: MissionActivityTab(mission: mission, detail: detail)
        }
    }
}

/// Section picker, New chat and mission actions in the window toolbar.
/// Toolbar hosts can sit outside the page's environment, so each root receives the model explicitly.
private struct MissionToolbar: ToolbarContent {
    @Environment(\.hostViewContext) private var hostContext
    let mission: Mission
    let model: AppModel
    let compactTabs: Bool

    var body: some ToolbarContent {
        coordinatorToolbar
        ToolbarItem(placement: .principal) {
            MissionTabPicker(mission: mission, compact: compactTabs, selection: model.missionTabSelection)
                .environmentObject(model)
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button { model.newSession(in: mission, context: hostContext) } label: { Label("New Chat", icon: PilotIcon.compose) }
                Menu("Add Existing Chat") { MissionExistingChatItems(mission: mission) }
            } label: {
                Label("New chat", icon: PilotIcon.compose)
                    .labelStyle(.titleAndIcon)
            } primaryAction: {
                model.newSession(in: mission, context: hostContext)
            }
            .environmentObject(model)
            .disabled(mission.status != .active)
            .help(mission.status == .active ? "Open a new chat in this mission" : "Reopen the mission to add chats")
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                MissionEditAction(missionId: mission.id)
                coordinatorItems
                Button { model.showArchive(in: mission.projectId, missionId: mission.id) } label: {
                    Label("Browse Archived Chats", icon: PilotIcon.archive)
                }
                Divider()
                MissionStatusActions(missionId: mission.id, status: mission.status)
                Divider()
                MissionDeleteAction(missionId: mission.id)
            } label: {
                PilotSymbol(PilotIcon.more, context: .toolbar)
            }
            .environmentObject(model)
            .menuIndicator(.hidden)
            .help("Mission actions")
            .accessibilityLabel("Mission actions")
        }
    }

    /// The coordinator is the chat people open most from a mission, so a plain icon sits beside the title rather
    /// than only in the actions menu. Without one, "Start a Coordinator…" stays in the menu.
    @ToolbarContentBuilder private var coordinatorToolbar: some ToolbarContent {
        if let coordinator = mission.coordinatorSessionId {
            if #available(macOS 26.0, *) {
                coordinatorItem(coordinator).sharedBackgroundVisibility(.hidden)
            } else {
                coordinatorItem(coordinator)
            }
        }
    }

    private func coordinatorItem(_ coordinator: String) -> some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            let title = (hostContext.map { $0.hosts.presentationClient($0.host) } ?? model.client).session(coordinator)?.title
            Button { model.navigate(.session, id: coordinator, context: hostContext) } label: {
                PilotSymbol(PilotIcon.coordinator, context: .toolbar)
            }
            .buttonStyle(.borderless)
            .help(title.map { "Open the coordinator, \($0)" } ?? "Open the coordinator")
            .accessibilityLabel("Open coordinator")
        }
    }

    @ViewBuilder private var coordinatorItems: some View {
        let members = model.members(of: mission, context: hostContext).filter { !$0.isArchived }
        if let coordinator = mission.coordinatorSessionId {
            Button { model.navigate(.session, id: coordinator, context: hostContext) } label: {
                Label("Open Coordinator", icon: PilotIcon.coordinator)
            }
            Button("Coordinate It Yourself") { model.setCoordinator(nil, missionId: mission.id, context: hostContext) }
        } else {
            Button { model.presentMissionSheet(.startCoordinator(missionId: mission.id), context: hostContext) } label: {
                Label("Start a Coordinator…", icon: PilotIcon.coordinator)
            }
            .disabled(mission.status != .active)
        }
        let candidates = members.filter { $0.id != mission.coordinatorSessionId }
        if !candidates.isEmpty {
            Menu("Make Coordinator") {
                ForEach(candidates) { session in
                    Button(session.title) { model.setCoordinator(session.id, missionId: mission.id, context: hostContext) }
                }
            }
        }
    }
}

/// Native segmented control for the mission sections; a pop-up button when the window is narrow.
struct MissionTabPicker: View {
    @Environment(\.hostViewContext) private var hostContext
    let mission: Mission
    var compact = false
    @ObservedObject var selection: MissionTabSelection
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client

    var body: some View {
        let picker = Picker("Mission section", selection: $selection.tab) {
            ForEach(MissionTab.allCases, id: \.self) { tab in
                Text(label(tab)).tag(tab)
            }
        }
        .labelsHidden()
        .help("Mission sections")
        if compact {
            picker.pickerStyle(.menu).fixedSize()
        } else {
            picker.pickerStyle(.segmented).fixedSize()
        }
    }

    private func label(_ tab: MissionTab) -> String {
        guard let count = count(tab), count > 0 else { return tab.title }
        return "\(tab.title) \(count)"
    }

    /// Open tasks and active chats: what is still in play.
    private func count(_ tab: MissionTab) -> Int? {
        switch tab {
        case .tasks: client.missionDetails[mission.id]?.tasks.filter { !$0.status.isClosed }.count
        case .chats: model.members(of: mission, context: hostContext).filter { !$0.isArchived }.count
        default: nil
        }
    }
}

struct MissionStatusChip: View {
    let status: MissionStatus

    var body: some View {
        Text(status.label)
            .font(.pilot(.small, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Capsule().fill(status == .active ? Theme.info.opacity(0.14) : Theme.muted))
            .foregroundStyle(status == .active ? Theme.info : Theme.mutedForeground)
    }
}

/// Tasks by status as one plain bar with a legend of counts under it ("9 done · 2 in review · 3 in progress ·
/// 1 blocked · 3 to do", zero counts omitted). VoiceOver reads `counts.summary`. Show it only when there are tasks.
struct MissionTaskProgress: View {
    let counts: MissionTaskCounts
    /// Widest the bar grows; nil fills the available width.
    var barWidth: CGFloat? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            SegmentedProgressBar(segments: counts.segments)
                .frame(maxWidth: barWidth ?? .infinity)
            ProgressLegend(entries: counts.legendEntries)
        }
        .frame(maxWidth: barWidth ?? .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(counts.summary)
    }
}

// MARK: Overview

/// The goal, one meta line and per-phase progress (one overall bar without phases), then what needs the user, the
/// tasks being worked on and the links. Phase task lists live in Tasks and history in Activity.
struct MissionOverviewTab: View {
    @Environment(\.hostViewContext) private var hostContext
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client

    /// Rows a section shows before its "Show all" line, as on a project's Overview.
    static let rowLimit = 5

    var body: some View {
        let counts = MissionTaskCounts(detail.tasks)
        let needs = model.needsYou(mission, context: hostContext)
        let working = MissionTaskOrdering.inFlight(detail.tasks)
        let taskLinks = MissionTaskLinkIndex(detail)
        VStack(alignment: .leading, spacing: 28) {
            summary(counts, working: working.count)
            if let context = hostContext {
                SharedMissionPageSection(mission: context.ref(.mission, mission.id), hosts: context.hosts)
            }
            if drafting {
                MissionDraftingEvent(mission: mission)
            } else if detail.tasks.isEmpty {
                EmptyStateView(icon: PilotIcon.tasks, title: "Plan the work",
                               message: mission.coordinatorSessionId == nil
                                   ? "Break the goal into tasks, or start a coordinator to draft them from the brief."
                                   : "Break the goal into tasks, or ask the coordinator to draft them from the brief.") {
                    Button("Add a Task") { model.missionTab = .tasks }
                        .buttonStyle(.borderedProminent)
                    if let coordinator = mission.coordinatorSessionId {
                        Button("Open Coordinator") { model.navigate(.session, id: coordinator, context: hostContext) }
                    }
                }
            }
            if !needs.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    PageSectionHeader(title: "Needs you", count: needs.count, countStyle: .attention)
                    ForEach(Array(needs.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { HairlineDivider(leading: InboxRowLayout.dividerInset) }
                        MissionNeedsYouRow(item: item)
                    }
                }
            }
            if !working.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    PageSectionHeader(title: "Working now", count: working.count, linkTitle: "All tasks") {
                        model.missionTab = .tasks
                    }
                    ForEach(Array(working.prefix(Self.rowLimit).enumerated()), id: \.element.id) { index, task in
                        if index > 0 { HairlineDivider(leading: 34) }
                        CompactTaskRow(task: task, resources: taskLinks.resources(of: task.id))
                    }
                    if working.count > Self.rowLimit {
                        Button("Show all \(working.count) working now") { model.missionTab = .tasks }
                            .buttonStyle(.plain)
                            .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                            .padding(.leading, 34)
                    }
                }
            }
            MissionTicketsSection(mission: mission, detail: detail)
            MissionLinksSection(mission: mission, detail: detail)
        }
    }

    /// A coordinator was just started and has not saved a goal, brief or task yet.
    private var drafting: Bool {
        mission.status == .active && mission.coordinatorSessionId != nil && mission.goal.isEmpty
            && detail.tasks.isEmpty && mission.briefRevision == 0
    }

    @ViewBuilder
    private func summary(_ counts: MissionTaskCounts, working: Int) -> some View {
        let phases = MissionTaskPhases(detail.tasks, phases: MissionPhaseIndex(detail), showDropped: false).progressRows
        VStack(alignment: .leading, spacing: 10) {
            if mission.goal.isEmpty {
                Button("Add a goal…") { model.presentMissionSheet(.edit(missionId: mission.id), context: hostContext) }
                    .buttonStyle(.plain)
                    .font(.pilot(.headline))
                    .foregroundStyle(Theme.faintForeground)
            } else {
                Text(mission.goal)
                    .font(.pilot(.headline))
                    .lineSpacing(3)
                    .foregroundStyle(Theme.foreground)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            MissionMetaLine(mission: mission, detail: detail, counts: counts, working: working)
            if !phases.isEmpty {
                MissionPhaseProgressList(rows: phases) { model.missionTab = .tasks }
                    .padding(.top, 4)
            } else if counts.total > 0 {
                Button { model.missionTab = .tasks } label: {
                    MissionTaskProgress(counts: counts, barWidth: 360).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Open Tasks")
                .padding(.top, 4)
            }
            if counts.total > 0, counts.done == counts.total, mission.status == .active {
                HStack(spacing: 8) {
                    Text("Every task is done.").font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                    Button("Mark Mission as Done") {
                        model.missionAction { [client, id = mission.id] in
                            try await client.updateMission(id, UpdateMissionRequest(status: .done))
                        }
                    }
                    .controlSize(.small)
                }
            }
        }
    }
}

/// One line under the goal: task progress in words, who coordinates and the brief revision. The bar and its legend
/// follow on their own lines.
private struct MissionMetaLine: View {
    @Environment(\.hostViewContext) private var hostContext
    let mission: Mission
    let detail: MissionDetail
    let counts: MissionTaskCounts
    let working: Int
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client

    var body: some View {
        HStack(spacing: 5) {
            Button(counts.progressLine(working: working)) { model.missionTab = .tasks }
                .buttonStyle(.plain)
                .monospacedDigit()
                .lineLimit(1)
                .fixedSize()
                .help("Open Tasks")
            Text("·")
            if let coordinator = mission.coordinatorSessionId {
                MissionCoordinatorIndicator()
                Button(client.session(coordinator)?.title ?? "Coordinator") { model.navigate(.session, id: coordinator, context: hostContext) }
                    .buttonStyle(.plain)
                    .lineLimit(1)
                    .help("Open the coordinator chat")
                    .accessibilityLabel("Coordinated by \(client.session(coordinator)?.title ?? "a chat")")
            } else {
                Text("You coordinate")
                if mission.status == .active {
                    Text("·")
                    Button("Start a coordinator…") { model.presentMissionSheet(.startCoordinator(missionId: mission.id), context: hostContext) }
                        .buttonStyle(.plain)
                }
            }
            Text("·")
            Button(detail.brief.map { "Brief revision \($0.revision)" } ?? "No brief yet") { model.missionTab = .brief }
                .buttonStyle(.plain)
                .lineLimit(1)
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
    }
}

/// While a new coordinator drafts the goal, brief and tasks: one line with the shared working ellipsis, like a chat's
/// automatic events, and a quiet link to its chat.
struct MissionDraftingEvent: View {
    @Environment(\.hostViewContext) private var hostContext
    let mission: Mission
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client

    var body: some View {
        let coordinator = mission.coordinatorSessionId.flatMap { client.session($0) }
        let working = coordinator?.isWorking ?? false
        HStack(spacing: 7) {
            if working {
                EllipsisSpinner(background: coordinator?.isWaitingOnJobs == true)
            } else {
                PilotSymbol(PilotIcon.coordinator).foregroundStyle(Theme.faintForeground).accessibilityHidden(true)
            }
            Text(working ? "The coordinator is drafting the goal, brief and tasks"
                         : "Waiting for the coordinator to draft the goal, brief and tasks")
                .foregroundStyle(Theme.mutedForeground)
                .lineLimit(1)
                .layoutPriority(1)
            if let id = coordinator?.id {
                Button("Open chat") { model.navigate(.session, id: id, context: hostContext) }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.info)
                    .fixedSize()
            }
            Spacer(minLength: 0)
        }
        .font(.pilot(.label))
        .help(working ? "They appear here as the coordinator saves them."
                      : "Open its chat to answer questions or tell it what to plan.")
        .accessibilityElement(children: .combine)
    }
}

/// A mission's Needs you item in the shared `NeedsYouRow`: an unread or failed chat reads like its sidebar row; a
/// blocked task, comment or proposed decision change shows its reason. The corner carries the state.
private struct MissionNeedsYouRow: View {
    @Environment(\.hostViewContext) private var hostContext
    @EndpointClient private var endpoint
    let item: MissionNeedsYouItem
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let reason = item.needsYouLabel()
        let detail = InboxRowDetail(session: session, reason: reason)
        NeedsYouRow(title: title, isChat: session != nil, action: action, help: reason, accessibilityDetail: detail.accessibilityText(using: model),
                    open: open) { detail }
            .inboxCorner(signal)
    }

    private var session: SessionSummary? {
        if case let .chat(session) = item { return endpoint.session(session.id) ?? session }
        return nil
    }

    private var signal: SessionSignal {
        guard let session else { return .needsYou }
        return session.signal(unread: model.isUnread(session)) ?? .needsYou
    }

    private var title: String {
        switch item {
        case let .chat(session): session.title
        case let .blockedTask(task): "#\(task.number) \(task.title)"
        case let .comment(comment): comment.text
        case let .decisionProposal(_, number): "Decision D\(number): proposed change"
        case let .linearTicket(resource): [resource.externalId, resource.title].compactMap { $0 }.joined(separator: " ")
        }
    }

    private var action: String {
        switch item {
        case let .chat(session): session.outcome == .failed || session.attentionReason != nil ? "Open chat" : "Review"
        case .blockedTask: "View task"
        case .comment: "Reply"
        case .decisionProposal: "Review"
        case .linearTicket: "Open in Linear"
        }
    }

    private func open() {
        switch item {
        case let .chat(session): model.navigate(.session, id: session.id, context: hostContext)
        case let .blockedTask(task): model.showMissionTask(task.id)
        case .comment, .decisionProposal: model.missionTab = .brief
        case let .linearTicket(resource): MissionTicketActions.open(resource.url)
        }
    }
}

/// A read-only task line: status, number, title and the chat working on it.
struct CompactTaskRow: View {
    @Environment(\.hostViewContext) private var hostContext
    let task: MissionTask
    var showsOwner = true
    var resources: [MissionResource] = []
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client

    var body: some View {
        HStack(spacing: 8) {
            PilotSymbol(task.workStatus.icon).foregroundStyle(task.isPhaseGated ? Theme.faintForeground : task.workStatus.color)
                .frame(width: 16)
                .help(task.delegationLabel ?? task.workStatus.label)
                .accessibilityLabel(task.delegationLabel ?? task.workStatus.label)
            Text("#\(task.number)").font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                .frame(minWidth: 20, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title).font(.pilot(.body)).lineLimit(1).strikethrough(task.status.isClosed)
                    .foregroundStyle(task.status.isClosed ? Theme.mutedForeground : Theme.foreground)
                MissionTaskDelegationLabel(task: task, resources: resources)
            }
            Spacer(minLength: 8)
            if showsOwner, let sessionId = task.sessionId {
                let title = client.session(sessionId)?.title
                Button { model.navigate(.session, id: sessionId, context: hostContext) } label: {
                    Label(MissionTaskOwnerLabel.text(task: task, chatTitle: title), icon: PilotIcon.message)
                        .lineLimit(1).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: 200, alignment: .trailing)
                .help(MissionTaskOwnerLabel.help(chatTitle: title))
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }
}

/// Author chat (a link) and health of an activity entry.
struct MissionEventByline: View {
    @Environment(\.hostViewContext) private var hostContext
    let event: MissionEvent
    var time: String? = nil
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client

    var body: some View {
        HStack(spacing: 5) {
            if let sessionId = event.sessionId {
                Button(client.session(sessionId)?.title ?? "A chat") { model.navigate(.session, id: sessionId, context: hostContext) }
                    .buttonStyle(.plain).lineLimit(1)
                    .help("Open this chat")
            } else {
                Text("You or Pilot")
            }
            if let health = event.health {
                Text("·")
                Circle().fill(health.color).frame(width: 6, height: 6)
                Text(health.label)
            }
            if let time {
                Text("·")
                Text(time).monospacedDigit()
            }
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
    }
}

// MARK: Links

/// A mission or task link as an inline chip: service mark, then the PR number with its readiness or the link's
/// title, in muted caption text. The one chip style for links inside task rows and the chat inspector; the
/// Overview lists links as rows (`MissionLinksSection`). The context menu copies or removes it.
/// A task's Linear link names its role: "Counts toward ENG-123" for a contribution; a reference keeps the plain
/// identifier and says so in its tooltip and VoiceOver label. Their menus change the role explicitly.
struct MissionLinkChip: View {
    let resource: MissionResource
    let missionId: String
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client

    var body: some View {
        let pr = resource.pullRequest ?? client.sessions.flatMap(\.linkedPullRequests).first { $0.url == resource.url }
        let role = linearRole
        let label = HStack(spacing: 5) {
            MissionLinkIcon(kind: resource.kind, pullRequestState: pr?.state, size: 10)
            Text(role == .contribution ? "Counts toward \(resource.badgeTitle)" : title(pr)).lineLimit(1)
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
        .contentShape(Rectangle())
        Group {
            if let url = URL(string: resource.url), url.scheme != nil {
                Link(destination: url) { label }.buttonStyle(.plain)
            } else {
                label
            }
        }
        .help([resource.url, pr?.stack?.helpText, roleHelp(role)].compactMap { $0 }.joined(separator: "\n"))
        .accessibilityLabel([resource.accessibilityName(pullRequest: pr), roleAccessibility(role)]
            .compactMap { $0 }.joined(separator: ", "))
        .contextMenu {
            Button("Copy Link") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(resource.url, forType: .string)
            }
            if role == .contribution {
                Button("Stop Counting Toward Ticket") {
                    MissionTicketActions.setRole(.reference, resourceId: resource.id, missionId: missionId)
                }
            } else if role == .reference, canContribute {
                Button("Count Toward Ticket") {
                    MissionTicketActions.setRole(.contribution, resourceId: resource.id, missionId: missionId)
                }
            }
            Button("Remove Link", role: .destructive, action: remove)
        }
        .accessibilityAction(named: "Remove link", remove)
    }

    /// Task-level Linear issue links only; mission-level tickets are listed on the Overview.
    private var linearRole: MissionLinearRole? {
        resource.kind == .linearIssue && resource.taskId != nil ? resource.effectiveLinearRole : nil
    }

    /// A task's reference can count toward the ticket only when this mission manages it.
    private var canContribute: Bool {
        guard let key = resource.linearKey, let detail = client.missionDetails[missionId] else { return false }
        return detail.resources.contains { $0.taskId == nil && $0.linearKey == key && $0.effectiveLinearRole == .managed }
    }

    private func roleHelp(_ role: MissionLinearRole?) -> String? {
        switch role {
        case .contribution: MissionLinearRoleText.contributionHelp(resource.badgeTitle)
        case .reference: MissionLinearRoleText.referenceHelp
        case .managed, nil: nil
        }
    }

    private func roleAccessibility(_ role: MissionLinearRole?) -> String? {
        switch role {
        case .contribution: "counts toward the ticket"
        case .reference: "reference only"
        case .managed, nil: nil
        }
    }

    /// "Ready to merge #412 · Stack 2/3", "Merged #398" or the link's title.
    private func title(_ pr: SessionPullRequest?) -> String {
        guard let pr else { return resource.badgeTitle }
        let state = pr.state == .open || pr.state == .draft ? PullRequestReadinessStyle(pr).label : pr.state.compactLabel
        return (["\(state) #\(pr.number)", pr.stack?.label].compactMap { $0 }).joined(separator: " · ")
    }

    private func remove() {
        model.missionAction { [client, missionId, id = resource.id] in
            try await client.deleteMissionResource(missionId, resourceId: id)
        }
    }
}

/// "+ Add link" with a small popover for the URL and an optional title.
struct MissionAddLinkButton: View {
    let missionId: String
    var taskId: String? = nil
    @State private var presented = false

    var body: some View {
        Button { presented = true } label: {
            HStack(spacing: 3) {
                PilotSymbol(PilotIcon.add)
                Text("Add link")
            }
            .font(.pilot(.caption))
            .foregroundStyle(Theme.mutedForeground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Link a Linear, GitHub or Slack item, or any URL")
        .popover(isPresented: $presented, arrowEdge: .bottom) {
            MissionAddLinkForm(missionId: missionId, taskId: taskId) { presented = false }
        }
    }
}

/// URL and optional title for a new mission or task link. Shown in a popover.
/// A Linear issue adds one checkbox for its role: a mission link manages the ticket's delivery (on by default), and
/// a task link to a ticket the mission manages can count toward it (off by default, so it stays a reference).
struct MissionAddLinkForm: View {
    @EndpointClient private var endpoint
    let missionId: String
    var taskId: String? = nil
    var title = "Add a link"
    let dismiss: () -> Void
    @EnvironmentObject private var model: AppModel
    @State private var input = MissionInput()
    /// The checkbox, once the user has touched it; nil follows the choice's default.
    @State private var linearOn: Bool?

    var body: some View {
        let choice = linearChoice
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.pilot(.body, weight: .semibold))
            TextField("Linear, GitHub, Slack or any URL", text: $input.text)
                .textFieldStyle(.roundedBorder).onSubmit(add)
            TextField("Title (optional)", text: $input.secondary)
                .textFieldStyle(.roundedBorder).onSubmit(add)
            if choice != .none {
                linearToggle(choice)
            }
            HStack {
                Spacer()
                Button("Cancel", action: dismiss).keyboardShortcut(.cancelAction)
                Button("Add", action: add).keyboardShortcut(.defaultAction)
                    .disabled(input.busy || URL(string: input.trimmed(input.text))?.scheme == nil)
            }
        }
        .padding(14)
        .frame(width: 340)
    }

    private var linearChoice: MissionLinearAttachChoice {
        MissionLinearAttachChoice.choice(url: input.trimmed(input.text), taskId: taskId,
                                         resources: model.client.missionDetails[missionId]?.resources ?? [])
    }

    private func linearToggle(_ choice: MissionLinearAttachChoice) -> some View {
        let on = Binding(get: { linearOn ?? choice.defaultOn }, set: { linearOn = $0 })
        let (label, detail): (String, String) = switch choice {
        case .manage:
            ("Manage delivery in this mission",
             "Its contributing tasks move it in Linear. Turn off to keep it as a reference.")
        case let .contribute(identifier):
            ("Counts toward \(identifier)",
             "This task's progress moves the ticket in Linear. Otherwise it is a reference.")
        case .none: ("", "")
        }
        return VStack(alignment: .leading, spacing: 2) {
            Toggle(label, isOn: on).toggleStyle(.checkbox).font(.pilot(.label))
            Text(detail).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 20)
        }
        .padding(.top, 2)
    }

    private func add() {
        let url = input.trimmed(input.text)
        guard !input.busy, URL(string: url)?.scheme != nil else { return }
        let title = input.trimmed(input.secondary)
        let choice = linearChoice
        let role: MissionLinearRole? = switch choice {
        case .manage: (linearOn ?? choice.defaultOn) ? .managed : nil
        case .contribute: (linearOn ?? choice.defaultOn) ? .contribution : nil
        case .none: nil
        }
        let plan = MissionLinearAttachPlan.plan(url: url, taskId: taskId, role: role,
                                                resources: model.client.missionDetails[missionId]?.resources ?? [])
        input.busy = true
        model.missionAction { [client = endpoint] in
            defer { input.busy = false }
            switch plan {
            case let .add(role):
                try await client.addMissionResource(missionId, MissionResourceWrite(
                    url: url, title: title.isEmpty ? nil : title, taskId: taskId, linearRole: role))
            case let .update(resourceId, role):
                try await client.updateMissionResource(missionId, resourceId: resourceId,
                                                       MissionResourceUpdate(linearRole: role))
            case .existing: break
            }
            input = MissionInput()
            linearOn = nil
            dismiss()
        }
    }
}

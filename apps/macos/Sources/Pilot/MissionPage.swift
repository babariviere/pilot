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
    let missionId: String
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
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
                              briefEditor: model.briefEditor(for: mission.id))
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
    let mission: Mission
    let model: AppModel
    let compactTabs: Bool

    var body: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            MissionTabPicker(mission: mission, compact: compactTabs, selection: model.missionTabSelection)
                .environmentObject(model)
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button { model.newSession(in: mission) } label: { Label("New Chat", icon: PilotIcon.compose) }
                Menu("Add Existing Chat") { MissionExistingChatItems(mission: mission) }
            } label: {
                Label("New chat", icon: PilotIcon.compose)
                    .labelStyle(.titleAndIcon)
            } primaryAction: {
                model.newSession(in: mission)
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

    @ViewBuilder private var coordinatorItems: some View {
        let members = model.members(of: mission).filter { !$0.isArchived }
        if let coordinator = mission.coordinatorSessionId {
            Button { model.selectedSessionId = coordinator } label: {
                Label("Open Coordinator", icon: PilotIcon.coordinator)
            }
            Button("Coordinate It Yourself") { model.setCoordinator(nil, missionId: mission.id) }
        } else {
            Button { model.missionSheet = .startCoordinator(missionId: mission.id) } label: {
                Label("Start a Coordinator…", icon: PilotIcon.coordinator)
            }
            .disabled(mission.status != .active)
        }
        let candidates = members.filter { $0.id != mission.coordinatorSessionId }
        if !candidates.isEmpty {
            Menu("Make Coordinator") {
                ForEach(candidates) { session in
                    Button(session.title) { model.setCoordinator(session.id, missionId: mission.id) }
                }
            }
        }
    }
}

/// Native segmented control for the mission sections; a pop-up button when the window is narrow.
struct MissionTabPicker: View {
    let mission: Mission
    var compact = false
    @ObservedObject var selection: MissionTabSelection
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

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
        case .chats: model.members(of: mission).filter { !$0.isArchived }.count
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

/// Tasks by status as a thin split bar beside the progress in words: "12 of 18 done", or with `working`,
/// "12 of 18 done · 3 working now" (the Overview's meta line).
struct MissionTaskProgress: View {
    let counts: MissionTaskCounts
    var working = 0

    var body: some View {
        HStack(spacing: 8) {
            if counts.total > 0 {
                SegmentedProgressBar(segments: counts.segments, height: 4).frame(width: 96)
            }
            Text(counts.progressLine(working: working))
                .font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.mutedForeground)
                .lineLimit(1).fixedSize()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(counts.summary)
    }
}

// MARK: Overview

/// The goal, one meta line, then what needs the user, the tasks being worked on and the links. Phases live in Tasks
/// and history in Activity.
struct MissionOverviewTab: View {
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    /// Rows a section shows before its "Show all" line, as on a project's Overview.
    static let rowLimit = 5

    var body: some View {
        let counts = MissionTaskCounts(detail.tasks)
        let needs = model.needsYou(mission)
        let working = MissionTaskOrdering.inFlight(detail.tasks)
        let taskLinks = MissionTaskLinkIndex(detail)
        VStack(alignment: .leading, spacing: 28) {
            summary(counts, working: working.count)
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
                        Button("Open Coordinator") { model.selectedSessionId = coordinator }
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
        VStack(alignment: .leading, spacing: 10) {
            if mission.goal.isEmpty {
                Button("Add a goal…") { model.missionSheet = .edit(missionId: mission.id) }
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

/// One line under the goal: task progress with its thin bar, who coordinates and the brief revision.
private struct MissionMetaLine: View {
    let mission: Mission
    let detail: MissionDetail
    let counts: MissionTaskCounts
    let working: Int
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(spacing: 5) {
            Button { model.missionTab = .tasks } label: { MissionTaskProgress(counts: counts, working: working) }
                .buttonStyle(.plain)
                .help("Open Tasks")
            Text("·")
            if let coordinator = mission.coordinatorSessionId {
                MissionCoordinatorIndicator()
                Button(client.session(coordinator)?.title ?? "Coordinator") { model.selectedSessionId = coordinator }
                    .buttonStyle(.plain)
                    .lineLimit(1)
                    .help("Open the coordinator chat")
                    .accessibilityLabel("Coordinated by \(client.session(coordinator)?.title ?? "a chat")")
            } else {
                Text("You coordinate")
                if mission.status == .active {
                    Text("·")
                    Button("Start a coordinator…") { model.missionSheet = .startCoordinator(missionId: mission.id) }
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

/// While a new coordinator drafts the goal, brief and tasks: one line with the shared working dot grid, like a chat's
/// automatic events, and a quiet link to its chat.
struct MissionDraftingEvent: View {
    let mission: Mission
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        let coordinator = mission.coordinatorSessionId.flatMap { client.session($0) }
        let working = coordinator?.isWorking ?? false
        HStack(spacing: 7) {
            if working {
                DotGridSpinner(background: coordinator?.isWaitingOnJobs == true)
            } else {
                PilotSymbol(PilotIcon.coordinator).foregroundStyle(Theme.faintForeground).accessibilityHidden(true)
            }
            Text(working ? "The coordinator is drafting the goal, brief and tasks"
                         : "Waiting for the coordinator to draft the goal, brief and tasks")
                .foregroundStyle(Theme.mutedForeground)
                .lineLimit(1)
                .layoutPriority(1)
            if let id = coordinator?.id {
                Button("Open chat") { model.selectedSessionId = id }
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
    let item: MissionNeedsYouItem
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let reason = item.needsYouLabel()
        let detail = InboxRowDetail(session: session, reason: reason)
        NeedsYouRow(title: title, action: action, help: reason, accessibilityDetail: detail.accessibilityText(using: model),
                    open: open) { detail }
            .inboxCorner(signal)
    }

    private var session: SessionSummary? {
        if case let .chat(session) = item { return model.client.session(session.id) ?? session }
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
        }
    }

    private var action: String {
        switch item {
        case let .chat(session): session.outcome == .failed || session.attentionReason != nil ? "Open chat" : "Review"
        case .blockedTask: "View task"
        case .comment: "Reply"
        case .decisionProposal: "Review"
        }
    }

    private func open() {
        switch item {
        case let .chat(session): model.selectedSessionId = session.id
        case let .blockedTask(task): model.showMissionTask(task.id)
        case .comment, .decisionProposal: model.missionTab = .brief
        }
    }
}

/// A read-only task line: status, number, title and the chat working on it.
struct CompactTaskRow: View {
    let task: MissionTask
    var showsOwner = true
    var resources: [MissionResource] = []
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(spacing: 8) {
            PilotSymbol(task.status.icon).foregroundStyle(task.status.color).frame(width: 16)
                .help(task.delegationLabel ?? task.status.label)
                .accessibilityLabel(task.delegationLabel ?? task.status.label)
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
                Button { model.selectedSessionId = sessionId } label: {
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
    let event: MissionEvent
    var time: String? = nil
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(spacing: 5) {
            if let sessionId = event.sessionId {
                Button(client.session(sessionId)?.title ?? "A chat") { model.selectedSessionId = sessionId }
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
struct MissionLinkChip: View {
    let resource: MissionResource
    let missionId: String
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        let pr = resource.pullRequest ?? client.sessions.flatMap(\.linkedPullRequests).first { $0.url == resource.url }
        let label = HStack(spacing: 5) {
            MissionLinkIcon(kind: resource.kind, pullRequestState: pr?.state, size: 10)
            Text(title(pr)).lineLimit(1)
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
        .help([resource.url, pr?.stack?.helpText].compactMap { $0 }.joined(separator: "\n"))
        .accessibilityLabel(resource.accessibilityName(pullRequest: pr))
        .contextMenu {
            Button("Copy Link") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(resource.url, forType: .string)
            }
            Button("Remove Link", role: .destructive, action: remove)
        }
        .accessibilityAction(named: "Remove link", remove)
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
struct MissionAddLinkForm: View {
    let missionId: String
    var taskId: String? = nil
    var title = "Add a link"
    let dismiss: () -> Void
    @EnvironmentObject private var model: AppModel
    @State private var input = MissionInput()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.pilot(.body, weight: .semibold))
            TextField("Linear, GitHub, Slack or any URL", text: $input.text)
                .textFieldStyle(.roundedBorder).onSubmit(add)
            TextField("Title (optional)", text: $input.secondary)
                .textFieldStyle(.roundedBorder).onSubmit(add)
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

    private func add() {
        let url = input.trimmed(input.text)
        guard !input.busy, URL(string: url)?.scheme != nil else { return }
        let title = input.trimmed(input.secondary)
        input.busy = true
        model.missionAction { [client = model.client] in
            defer { input.busy = false }
            try await client.addMissionResource(missionId, MissionResourceWrite(url: url, title: title.isEmpty ? nil : title,
                                                                                taskId: taskId))
            input = MissionInput()
            dismiss()
        }
    }
}

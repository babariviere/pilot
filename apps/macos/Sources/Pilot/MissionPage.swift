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
                EmptyStateView(icon: MissionSymbol.name, title: "This mission no longer exists",
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
private struct MissionToolbar: ToolbarContent {
    let mission: Mission
    let model: AppModel
    let compactTabs: Bool

    var body: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            MissionTabPicker(mission: mission, compact: compactTabs, selection: model.missionTabSelection)
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button { model.newSession(in: mission) } label: { Label("New Chat", systemImage: "plus") }
                Menu("Add Existing Chat") { MissionExistingChatItems(mission: mission) }
            } label: {
                Label("New chat", systemImage: "plus")
                    .labelStyle(.titleAndIcon)
            } primaryAction: {
                model.newSession(in: mission)
            }
            .disabled(mission.status != .active)
            .help(mission.status == .active ? "Open a new chat in this mission" : "Reopen the mission to add chats")
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                MissionEditAction(missionId: mission.id)
                coordinatorItems
                Button { model.showArchive(in: mission.projectId, missionId: mission.id) } label: {
                    Label("Browse Archived Chats", systemImage: "archivebox")
                }
                Divider()
                MissionStatusActions(missionId: mission.id, status: mission.status)
                Divider()
                MissionDeleteAction(missionId: mission.id)
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuIndicator(.hidden)
            .help("Mission actions")
            .accessibilityLabel("Mission actions")
        }
    }

    @ViewBuilder private var coordinatorItems: some View {
        let members = model.members(of: mission).filter { !$0.isArchived }
        if let coordinator = mission.coordinatorSessionId {
            Button { model.selectedSessionId = coordinator } label: {
                Label("Open Coordinator", systemImage: MissionCoordinatorIndicator.symbol)
            }
            Button("Coordinate It Yourself") { model.setCoordinator(nil, missionId: mission.id) }
        } else {
            Button { model.missionSheet = .startCoordinator(missionId: mission.id) } label: {
                Label("Start a Coordinator…", systemImage: MissionCoordinatorIndicator.symbol)
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

/// Tasks by status as a split bar, with a legend that names each part.
struct MissionTaskProgress: View {
    let counts: MissionTaskCounts
    var compact = false

    var body: some View {
        if compact {
            HStack(spacing: 8) {
                SegmentedProgressBar(segments: counts.segments, height: 5)
                Text(counts.total == 0 ? "No tasks" : "\(counts.done) of \(counts.total)")
                    .font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.mutedForeground).fixedSize()
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(counts.summary)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                SegmentedProgressBar(segments: counts.segments, height: 6)
                legend
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(counts.summary)
        }
    }

    private var legend: some View {
        HStack(spacing: 12) {
            Text(counts.total == 0 ? "No tasks yet" : "\(counts.done) of \(counts.total) done")
                .font(.pilot(.label, weight: .medium)).monospacedDigit().foregroundStyle(Theme.foreground)
            ForEach(MissionTaskCounts.barOrder.dropFirst(), id: \.self) { status in
                if counts[status] > 0 {
                    HStack(spacing: 4) {
                        Circle().fill(status == .todo ? Theme.faintForeground : status.color).frame(width: 6, height: 6)
                        Text("\(counts[status]) \(status.label.lowercased())")
                    }
                    .font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.mutedForeground)
                }
            }
        }
    }
}

// MARK: Overview

struct MissionOverviewTab: View {
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        let counts = MissionTaskCounts(detail.tasks)
        let needs = model.needsYou(mission)
        let inFlight = MissionTaskOrdering.groups(detail.tasks)
            .filter { [.inProgress, .inReview, .blocked].contains($0.status) }
            .flatMap(\.tasks)
        let waiting = detail.tasks.filter { $0.status == .todo }.count
        VStack(alignment: .leading, spacing: 28) {
            summary(counts)
            if drafting {
                MissionDraftingBanner(mission: mission)
            } else if detail.tasks.isEmpty {
                EmptyStateView(icon: "checklist", title: "Plan the work",
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
            VStack(alignment: .leading, spacing: 6) {
                PageSectionHeader(title: "Needs you", count: needs.count, countStyle: .attention)
                if needs.isEmpty {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle").foregroundStyle(Theme.success).frame(width: 16)
                        Text("Nothing is waiting on you.").foregroundStyle(Theme.mutedForeground)
                    }
                    .font(.pilot(.body))
                    .padding(.horizontal, 8).padding(.vertical, 4)
                }
                ForEach(Array(needs.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { HairlineDivider(leading: 34) }
                    NeedsYouRow(item: item, mission: mission)
                }
            }
            if !inFlight.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    PageSectionHeader(title: "In flight", count: inFlight.count, linkTitle: "All tasks") {
                        model.missionTab = .tasks
                    }
                    ForEach(Array(inFlight.prefix(8).enumerated()), id: \.element.id) { index, task in
                        if index > 0 { HairlineDivider(leading: 34) }
                        CompactTaskRow(task: task)
                    }
                    if waiting > 0 || inFlight.count > 8 {
                        Button(waitingText(waiting: waiting, hidden: max(0, inFlight.count - 8))) {
                            model.missionTab = .tasks
                        }
                        .buttonStyle(.plain)
                        .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                        .padding(.leading, 34)
                    }
                }
            }
            if !detail.events.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    PageSectionHeader(title: "Recent activity", linkTitle: "All activity") { model.missionTab = .activity }
                    ForEach(detail.events.prefix(3)) { event in
                        MissionEventRow(event: event)
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

    private func waitingText(waiting: Int, hidden: Int) -> String {
        var parts: [String] = []
        if hidden > 0 { parts.append("\(hidden) more in flight") }
        if waiting > 0 { parts.append("\(waiting) to do") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func summary(_ counts: MissionTaskCounts) -> some View {
        VStack(alignment: .leading, spacing: 14) {
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
            MissionMetaLine(mission: mission, detail: detail)
            if counts.total > 0 { MissionTaskProgress(counts: counts) }
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
            let milestones = MissionMilestones.progress(detail.tasks)
            if !milestones.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(milestones) { milestone in
                        MissionMilestoneRow(milestone: milestone)
                    }
                }
                .padding(.top, 2)
            }
        }
    }
}

/// Coordinator, brief revision and decision count under the goal.
private struct MissionMetaLine: View {
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(spacing: 5) {
            if let coordinator = mission.coordinatorSessionId {
                MissionCoordinatorIndicator()
                Text("Coordinated by")
                Button(client.session(coordinator)?.title ?? "a chat") { model.selectedSessionId = coordinator }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(1)
                    .help("Open the coordinator chat")
            } else {
                Text("You coordinate")
                if mission.status == .active {
                    Text("·")
                    Button("Start a coordinator…") { model.missionSheet = .startCoordinator(missionId: mission.id) }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.foreground)
                }
            }
            Text("·")
            Button(detail.brief.map { "Brief revision \($0.revision)" } ?? "No brief yet") { model.missionTab = .brief }
                .buttonStyle(.plain)
            if !detail.decisions.isEmpty {
                Text("·")
                Text("\(detail.decisions.count) decision\(detail.decisions.count == 1 ? "" : "s")")
            }
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
    }
}

private struct MissionMilestoneRow: View {
    let milestone: MissionMilestoneProgress

    var body: some View {
        HStack(spacing: 12) {
            Text(milestone.name ?? "No phase")
                .font(.pilot(.label))
                .foregroundStyle(milestone.name == nil ? Theme.mutedForeground : Theme.foreground)
                .lineLimit(1)
                .frame(width: 150, alignment: .leading)
            SegmentedProgressBar(segments: milestone.counts.segments, height: 5)
            Text("\(milestone.counts.done)/\(milestone.counts.total)")
                .font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.mutedForeground)
                .frame(width: 36, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(milestone.name ?? "No phase"): \(milestone.counts.summary)")
    }
}

/// Shown on Overview while a new coordinator drafts the goal, brief and tasks.
struct MissionDraftingBanner: View {
    let mission: Mission
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        let coordinator = mission.coordinatorSessionId.flatMap { client.session($0) }
        let working = coordinator?.isWorking ?? false
        HStack(spacing: 10) {
            if let coordinator { SessionStatusIcon(status: coordinator.status) }
            VStack(alignment: .leading, spacing: 2) {
                Text(working ? "The coordinator is drafting the goal, brief and tasks"
                             : "Waiting for the coordinator to draft the goal, brief and tasks")
                    .font(.pilot(.body))
                    .foregroundStyle(Theme.foreground)
                Text(working ? "They appear here as the coordinator saves them."
                             : "Open its chat to answer questions or tell it what to plan.")
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.mutedForeground)
            }
            Spacer(minLength: 8)
            if let id = coordinator?.id {
                Button("Open Chat") { model.selectedSessionId = id }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.muted))
        .accessibilityElement(children: .combine)
    }
}

private struct NeedsYouRow: View {
    let item: MissionNeedsYouItem
    let mission: Mission
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        Button(action: open) {
            HoverRow(verticalPadding: 7) { hovered in
                HStack(spacing: 10) {
                    icon.frame(width: 16)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                        Text(subtitle).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    Text(action).font(.pilot(.label, weight: .medium))
                        .foregroundStyle(hovered ? Theme.foreground : Theme.mutedForeground)
                    Image(systemName: "chevron.right").font(.pilot(.micro, weight: .semibold))
                        .foregroundStyle(Theme.faintForeground)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title). \(subtitle)")
        .accessibilityHint(action)
    }

    @ViewBuilder private var icon: some View {
        switch item {
        case let .chat(session):
            if session.isActiveMissionCoordinator { MissionCoordinatorIndicator() }
            else { SessionStatusIcon(status: session.status) }
        case .blockedTask: Image(systemName: MissionTaskStatus.blocked.symbol).foregroundStyle(MissionTaskStatus.blocked.color)
        case .comment: Image(systemName: "text.bubble").foregroundStyle(Theme.info)
        }
    }

    private var title: String {
        switch item {
        case let .chat(session): session.title
        case let .blockedTask(task): "#\(task.number) \(task.title)"
        case let .comment(comment): comment.text
        }
    }

    private var subtitle: String {
        switch item {
        case let .chat(session):
            session.outcome == .failed ? "Failed. Open the chat to see why." :
                session.isActiveMissionCoordinator ? "New result. Review the chat." : "Finished. Review the result."
        case let .blockedTask(task):
            "Blocked" + (task.sessionId.flatMap { client.session($0)?.title }.map { " · \($0)" } ?? "")
        case let .comment(comment):
            "Comment from \(missionAuthorName(comment.authorSessionId, client: client))"
                + (comment.anchor.map { " on “\($0)”" } ?? "")
        }
    }

    private var action: String {
        switch item {
        case let .chat(session): session.outcome == .failed ? "Open chat" : "Review"
        case .blockedTask: "View task"
        case .comment: "Reply"
        }
    }

    private func open() {
        switch item {
        case let .chat(session): model.selectedSessionId = session.id
        case .blockedTask: model.missionTab = .tasks
        case .comment: model.missionTab = .brief
        }
    }
}

/// A read-only task line: status, number, title and the chat working on it.
struct CompactTaskRow: View {
    let task: MissionTask
    var showsOwner = true
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: task.status.symbol).foregroundStyle(task.status.color).frame(width: 16)
                .help(task.status.label)
                .accessibilityLabel(task.status.label)
            Text("#\(task.number)").font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                .frame(minWidth: 20, alignment: .leading)
            Text(task.title).font(.pilot(.body)).lineLimit(1).strikethrough(task.status.isClosed)
                .foregroundStyle(task.status.isClosed ? Theme.mutedForeground : Theme.foreground)
            Spacer(minLength: 8)
            if showsOwner, let sessionId = task.sessionId {
                let title = client.session(sessionId)?.title
                Button { model.selectedSessionId = sessionId } label: {
                    Label(MissionTaskOwnerLabel.text(task: task, chatTitle: title), systemImage: "bubble.left")
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

struct MissionEventRow: View {
    let event: MissionEvent
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: event.kind.symbol).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.text).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                MissionEventByline(event: event)
            }
            Spacer(minLength: 8)
            TimelineView(.periodic(from: .now, by: 60)) { context in
                Text(missionRelativeTime(event.at, now: context.date))
                    .font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
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

/// Mission or task links as wrapping chips, with an "Add link" popover at the end.
struct MissionLinkList: View {
    let missionId: String
    let resources: [MissionResource]
    var taskId: String? = nil
    var compact = false

    var body: some View {
        ResponsiveControlsLayout(horizontalSpacing: 6, verticalSpacing: 6) {
            ForEach(resources) { resource in
                MissionLinkChip(resource: resource, missionId: missionId, compact: compact)
            }
            MissionAddLinkButton(missionId: missionId, taskId: taskId, compact: compact)
        }
    }
}

/// One link: service icon (with PR state), title and a muted detail. Context menu copies or removes it.
struct MissionLinkChip: View {
    let resource: MissionResource
    let missionId: String
    var compact = false
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        let pr = resource.pullRequest ?? client.sessions.flatMap(\.linkedPullRequests).first { $0.url == resource.url }
        let label = HStack(spacing: 5) {
            MissionLinkIcon(kind: resource.kind, pullRequestState: pr?.state, size: compact ? 10 : 11)
            Text(compact ? (pr?.label ?? resource.badgeTitle) : resource.displayTitle)
                .foregroundStyle(compact ? Theme.mutedForeground : Theme.foreground)
                .lineLimit(1)
            if let detail = detail(pr) {
                Text(detail).foregroundStyle(Theme.mutedForeground).lineLimit(1)
            }
        }
        .font(.pilot(compact ? .caption : .label))
        .padding(.horizontal, compact ? 0 : 8)
        .padding(.vertical, compact ? 0 : 4)
        .background(RoundedRectangle(cornerRadius: 7).fill(compact ? Color.clear : Theme.muted))
        .contentShape(RoundedRectangle(cornerRadius: 7))
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
            Button("Remove Link", role: .destructive) {
                model.missionAction { [client] in
                    try await client.deleteMissionResource(missionId, resourceId: resource.id)
                }
            }
        }
        .accessibilityAction(named: "Remove link") {
            model.missionAction { [client] in try await client.deleteMissionResource(missionId, resourceId: resource.id) }
        }
    }

    private func detail(_ pr: SessionPullRequest?) -> String? {
        if let pr { return [compact ? nil : pr.state.label, pr.stack?.label].compactMap { $0 }.joined(separator: " · ") }
        if compact { return nil }
        switch resource.kind {
        case .linearProject: return "Linear project"
        case .linearIssue: return "Linear"
        case .githubIssue: return "Issue"
        case .slackThread: return "Slack"
        case .githubPullRequest, .url: return nil
        }
    }
}

/// "+ Add link" with a small popover for the URL and an optional title.
struct MissionAddLinkButton: View {
    let missionId: String
    var taskId: String? = nil
    var compact = false
    @State private var presented = false

    var body: some View {
        Button { presented = true } label: {
            HStack(spacing: 4) {
                Image(systemName: "plus").font(.pilot(.micro, weight: .semibold))
                Text("Add link")
            }
            .font(.pilot(compact ? .caption : .label))
            .foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, compact ? 0 : 6)
            .padding(.vertical, compact ? 0 : 4)
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

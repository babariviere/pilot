import AppKit
import PilotCore
import SwiftUI

/// Free text for small add/edit forms, held outside the view per AGENTS.md (no @State).
@MainActor
final class MissionInput: ObservableObject {
    @Published var text = ""
    @Published var secondary = ""
    @Published var option: String?
    @Published var busy = false
    @Published var editingId: String?
    @Published var confirming = false

    func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// The main detail area for a selected mission.
struct MissionPage: View {
    let missionId: String
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var deletion = MissionInput()

    var body: some View {
        Group {
            if let mission = client.mission(missionId) {
                VStack(spacing: 0) {
                    MissionHeader(mission: mission, deletion: deletion)
                    MissionTabBar(mission: mission)
                    Rectangle().fill(Theme.border).frame(height: 1)
                    content(mission, detail: client.missionDetails[missionId])
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .navigationTitle(mission.title)
                .navigationSubtitle(client.project(mission.projectId)?.name ?? "")
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "scope").font(.title2).foregroundStyle(Theme.faintForeground)
                    Text("This mission no longer exists").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.background)
        .missionSubscription(missionId, client: client)
        .confirmationDialog("Delete this mission?", isPresented: $deletion.confirming) {
            Button("Delete Mission", role: .destructive) {
                model.missionAction { [client, missionId, model] in
                    try await client.deleteMission(missionId)
                    if model.selectedMissionId == missionId { model.selectedMissionId = nil }
                }
            }
        } message: {
            Text("Its brief, tasks and activity are deleted. Member chats are kept and detached from the mission.")
        }
    }

    @ViewBuilder
    private func content(_ mission: Mission, detail: MissionDetail?) -> some View {
        if let detail {
            switch model.missionTab {
            case .overview: MissionOverviewTab(mission: mission, detail: detail)
            case .brief: MissionBriefTab(mission: mission, detail: detail)
            case .tasks: MissionTasksTab(mission: mission, detail: detail)
            case .chats: MissionChatsTab(mission: mission, detail: detail)
            case .artifacts: MissionArtifactsTab(mission: mission, detail: detail)
            case .activity: MissionActivityTab(mission: mission, detail: detail)
            }
        } else {
            ProgressView("Loading mission…")
        }
    }
}

private struct MissionHeader: View {
    let mission: Mission
    @ObservedObject var deletion: MissionInput
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "scope").font(.system(size: 20)).foregroundStyle(Theme.mutedForeground)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(mission.title).font(.title2.weight(.semibold)).lineLimit(2).textSelection(.enabled)
                HStack(spacing: 6) {
                    MissionStatusChip(status: mission.status)
                    Text(client.project(mission.projectId)?.name ?? "Unknown project")
                    Text("·")
                    if let coordinator = mission.coordinatorSessionId {
                        Button { model.selectedSessionId = coordinator } label: {
                            HStack(spacing: 4) {
                                MissionCoordinatorIndicator()
                                Text("Coordinated by \(client.session(coordinator)?.title ?? "a chat")")
                                    .lineLimit(1)
                            }
                        }
                        .buttonStyle(.plain)
                        .help("Open the coordinator chat")
                    } else {
                        Text("You coordinate")
                    }
                }
                .font(.caption)
                .foregroundStyle(Theme.mutedForeground)
            }
            Spacer(minLength: 12)
            Menu {
                Button { model.missionSheet = .edit(missionId: mission.id) } label: {
                    Label("Edit title and goal…", systemImage: "pencil")
                }
                Divider()
                if mission.status != .done {
                    Button { setStatus(.done) } label: { Label("Mark as done", systemImage: "checkmark.circle") }
                }
                if mission.status != .active {
                    Button { setStatus(.active) } label: { Label("Reopen", systemImage: "arrow.uturn.backward") }
                }
                if mission.status != .archived {
                    Button { setStatus(.archived) } label: { Label("Archive", systemImage: "archivebox") }
                }
                Divider()
                Button(role: .destructive) { deletion.confirming = true } label: {
                    Label("Delete mission…", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Mission actions")
            .accessibilityLabel("Mission actions")
        }
        .padding(.horizontal, 24)
        .padding(.top, 18)
        .padding(.bottom, 10)
    }

    private func setStatus(_ status: MissionStatus) {
        model.missionAction { [client, id = mission.id] in
            try await client.updateMission(id, UpdateMissionRequest(status: status))
        }
    }
}

struct MissionStatusChip: View {
    let status: MissionStatus

    var body: some View {
        Text(status.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Capsule().fill(status == .active ? Theme.info.opacity(0.14) : Theme.muted))
            .foregroundStyle(status == .active ? Theme.info : Theme.mutedForeground)
    }
}

private struct MissionTabBar: View {
    let mission: Mission
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(spacing: 2) {
            ForEach(MissionTab.allCases, id: \.self) { tab in
                Button { model.missionTab = tab } label: {
                    HStack(spacing: 5) {
                        Text(tab.title)
                            .font(.system(size: 12, weight: model.missionTab == tab ? .semibold : .regular))
                            .foregroundStyle(model.missionTab == tab ? Theme.foreground : Theme.mutedForeground)
                        if let count = count(tab), count > 0 {
                            Text("\(count)").font(.system(size: 10)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 6).fill(model.missionTab == tab ? Theme.card : .clear))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(model.missionTab == tab ? Theme.border : .clear))
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 6)
    }

    private func count(_ tab: MissionTab) -> Int? {
        let detail = client.missionDetails[mission.id]
        switch tab {
        case .tasks: return detail?.tasks.count
        case .chats: return model.members(of: mission).filter { !$0.isArchived }.count
        case .artifacts: return detail?.artifacts.count
        default: return nil
        }
    }
}

/// A titled section on mission pages.
struct MissionSection<Content: View, Accessory: View>: View {
    let title: String
    @ViewBuilder var accessory: () -> Accessory
    @ViewBuilder var content: () -> Content

    init(_ title: String, @ViewBuilder accessory: @escaping () -> Accessory = { EmptyView() },
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.accessory = accessory
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.mutedForeground)
                Spacer()
                accessory()
            }
            VStack(alignment: .leading, spacing: 0) { content() }
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
        }
    }
}

struct MissionProgressBar: View {
    let done: Int
    let total: Int

    var body: some View {
        HStack(spacing: 10) {
            GeometryReader { geometry in
                Capsule().fill(Theme.muted)
                    .overlay(alignment: .leading) {
                        Capsule().fill(done == total && total > 0 ? Theme.success : Theme.foreground.opacity(0.7))
                            .frame(width: geometry.size.width * CGFloat(done) / CGFloat(max(1, total)))
                    }
            }
            .frame(height: 6)
            Text(total == 0 ? "No tasks yet" : "\(done) of \(total) tasks done")
                .font(.caption).monospacedDigit().foregroundStyle(Theme.mutedForeground).fixedSize()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(total == 0 ? "No tasks yet" : "\(done) of \(total) tasks done")
    }
}

struct MissionRowDivider: View {
    var body: some View { Rectangle().fill(Theme.border).frame(height: 1) }
}

// MARK: Overview

struct MissionOverviewTab: View {
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var resource = MissionInput()

    var body: some View {
        let progress = detail.progress
        let needs = model.needsYou(mission)
        let openTasks = MissionTaskOrdering.sorted(detail.tasks).filter { !$0.status.isClosed }
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(mission.goal.isEmpty ? "No goal yet" : mission.goal)
                        .font(.body)
                        .foregroundStyle(mission.goal.isEmpty ? Theme.faintForeground : Theme.foreground)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    MissionProgressBar(done: progress.done, total: progress.total)
                    if progress.total > 0, progress.done == progress.total, mission.status == .active {
                        HStack {
                            Text("Every task is done.").font(.callout).foregroundStyle(Theme.mutedForeground)
                            Button("Mark mission as done") {
                                model.missionAction { [client, id = mission.id] in
                                    try await client.updateMission(id, UpdateMissionRequest(status: .done))
                                }
                            }
                            .controlSize(.small)
                        }
                    }
                }
                MissionSection("Needs you") {
                    if needs.isEmpty {
                        Text("Nothing is waiting on you").font(.callout).foregroundStyle(Theme.faintForeground).padding(12)
                    }
                    ForEach(Array(needs.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { MissionRowDivider() }
                        NeedsYouRow(item: item, mission: mission)
                    }
                }
                MissionSection("Tasks", accessory: {
                    Button("All tasks") { model.missionTab = .tasks }.buttonStyle(.link).font(.caption)
                }) {
                    if openTasks.isEmpty {
                        Text(detail.tasks.isEmpty ? "No tasks yet" : "No open tasks")
                            .font(.callout).foregroundStyle(Theme.faintForeground).padding(12)
                    }
                    ForEach(Array(openTasks.prefix(8).enumerated()), id: \.element.id) { index, task in
                        if index > 0 { MissionRowDivider() }
                        CompactTaskRow(task: task)
                    }
                    if openTasks.count > 8 {
                        MissionRowDivider()
                        Button("\(openTasks.count - 8) more…") { model.missionTab = .tasks }
                            .buttonStyle(.link).font(.caption).padding(10)
                    }
                }
                MissionSection("Recent activity", accessory: {
                    Button("All activity") { model.missionTab = .activity }.buttonStyle(.link).font(.caption)
                }) {
                    if detail.events.isEmpty {
                        Text("No activity yet").font(.callout).foregroundStyle(Theme.faintForeground).padding(12)
                    }
                    ForEach(Array(detail.events.prefix(5).enumerated()), id: \.element.id) { index, event in
                        if index > 0 { MissionRowDivider() }
                        MissionEventRow(event: event)
                    }
                }
                MissionSection("Resources") {
                    ForEach(detail.resources.filter { $0.taskId == nil }) { item in
                        ResourceRow(resource: item, missionId: mission.id)
                        MissionRowDivider()
                    }
                    HStack(spacing: 8) {
                        TextField("Link (Linear, GitHub, Slack or any URL)", text: $resource.text)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit(addResource)
                        TextField("Title (optional)", text: $resource.secondary)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 180)
                            .onSubmit(addResource)
                        Button("Add", action: addResource)
                            .disabled(resource.busy || URL(string: resource.trimmed(resource.text))?.scheme == nil)
                    }
                    .padding(10)
                }
            }
            .padding(24)
            .frame(maxWidth: 860, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    private func addResource() {
        let url = resource.trimmed(resource.text)
        guard !resource.busy, URL(string: url)?.scheme != nil else { return }
        let title = resource.trimmed(resource.secondary)
        resource.busy = true
        model.missionAction { [client, resource, id = mission.id] in
            defer { resource.busy = false }
            try await client.addMissionResource(id, MissionResourceWrite(url: url, title: title.isEmpty ? nil : title))
            resource.text = ""
            resource.secondary = ""
        }
    }
}

private struct NeedsYouRow: View {
    let item: MissionNeedsYouItem
    let mission: Mission
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                icon.frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).lineLimit(1)
                    Text(subtitle).font(.caption).foregroundStyle(Theme.mutedForeground).lineLimit(2)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.faintForeground)
            }
            .padding(10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var icon: some View {
        switch item {
        case let .chat(session): SessionStatusIcon(status: session.status)
        case .blockedTask: Image(systemName: MissionTaskStatus.blocked.symbol).foregroundStyle(MissionTaskStatus.blocked.color)
        case .comment: Image(systemName: "text.quote").foregroundStyle(Theme.info)
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
            session.outcome == .failed ? "Failed. Review the chat." : "Finished. Review the result."
        case let .blockedTask(task):
            "Blocked" + (task.sessionId.flatMap { client.session($0)?.title }.map { " · \($0)" } ?? "")
        case let .comment(comment):
            "Comment from \(missionAuthorName(comment.authorSessionId, client: client))"
                + (comment.anchor.map { " on “\($0)”" } ?? "")
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

struct CompactTaskRow: View {
    let task: MissionTask
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: task.status.symbol).foregroundStyle(task.status.color).frame(width: 16)
                .help(task.status.label)
            Text("#\(task.number)").font(.caption.monospacedDigit()).foregroundStyle(Theme.faintForeground)
            Text(task.title).lineLimit(1).strikethrough(task.status.isClosed)
                .foregroundStyle(task.status.isClosed ? Theme.mutedForeground : Theme.foreground)
            Spacer(minLength: 8)
            if let sessionId = task.sessionId {
                let title = client.session(sessionId)?.title
                Button { model.selectedSessionId = sessionId } label: {
                    Label(MissionTaskOwnerLabel.text(task: task, chatTitle: title), systemImage: "bubble.left")
                        .lineLimit(1).font(.caption).foregroundStyle(Theme.mutedForeground)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: 200, alignment: .trailing)
                .help(MissionTaskOwnerLabel.help(chatTitle: title))
            }
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
    }
}

struct MissionEventRow: View {
    let event: MissionEvent
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: event.kind.symbol).foregroundStyle(Theme.mutedForeground).frame(width: 16)
            VStack(alignment: .leading, spacing: 3) {
                Text(event.text).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    if let health = event.health {
                        HStack(spacing: 4) {
                            Circle().fill(health.color).frame(width: 6, height: 6)
                            Text(health.label)
                        }
                    }
                    if let sessionId = event.sessionId {
                        Button(client.session(sessionId)?.title ?? "A chat") { model.selectedSessionId = sessionId }
                            .buttonStyle(.plain).lineLimit(1)
                    } else {
                        Text("You or Pilot")
                    }
                }
                .font(.caption).foregroundStyle(Theme.mutedForeground)
            }
            Spacer(minLength: 8)
            TimelineView(.periodic(from: .now, by: 60)) { context in
                Text(missionRelativeTime(event.at, now: context.date))
                    .font(.caption).monospacedDigit().foregroundStyle(Theme.faintForeground)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }
}

struct ResourceRow: View {
    let resource: MissionResource
    let missionId: String
    var compact = false
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: resource.kind.symbol).foregroundStyle(Theme.mutedForeground).frame(width: 16)
            if let url = URL(string: resource.url) {
                let pr = resource.pullRequest ?? client.sessions.flatMap(\.linkedPullRequests).first { $0.url == resource.url }
                Link(compact ? (pr?.label ?? resource.badgeTitle) : resource.displayTitle, destination: url)
                    .lineLimit(1).help(resource.url)
            } else {
                Text(resource.displayTitle).lineLimit(1)
            }
            Spacer()
            Button {
                model.missionAction { [client = model.client] in
                    try await client.deleteMissionResource(missionId, resourceId: resource.id)
                }
            } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
                .help("Remove link")
                .accessibilityLabel("Remove link")
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
    }
}

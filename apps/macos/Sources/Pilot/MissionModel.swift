import AppKit
import PilotCore
import SwiftUI

enum MissionTab: String, CaseIterable, Hashable {
    case overview, tasks, brief, chats, artifacts, activity

    var title: String {
        switch self {
        case .overview: "Overview"
        case .brief: "Brief"
        case .tasks: "Tasks"
        case .chats: "Chats"
        case .artifacts: "Artifacts"
        case .activity: "Activity"
        }
    }
}

/// The selected mission section; see `AppModel.missionTab`.
@MainActor
final class MissionTabSelection: ObservableObject {
    @Published var tab: MissionTab = .overview
}

/// Mission sheets, presented once by the main window.
enum MissionSheet: Identifiable, Hashable {
    /// "New mission…", optionally preselecting a project.
    case create(projectId: String?)
    /// "Make a mission…" from a chat.
    case make(sessionId: String)
    /// "Add to mission…" for a chat.
    case add(sessionId: String)
    case edit(missionId: String)
    case startCoordinator(missionId: String)
    /// "Start mission…" from a Linear issue or Slack message, prefilled and linked once created.
    case fromSource(SourceMissionDraft)

    var id: String {
        switch self {
        case let .create(projectId): "create-\(projectId ?? "")"
        case let .make(sessionId): "make-\(sessionId)"
        case let .add(sessionId): "add-\(sessionId)"
        case let .edit(missionId): "edit-\(missionId)"
        case let .startCoordinator(missionId): "start-coordinator-\(missionId)"
        case let .fromSource(draft): "source-\(draft.sourceKey)"
        }
    }
}

extension AppModel {
    func briefEditor(for missionId: String) -> BriefEditorState {
        if let editor = missionBriefEditors[missionId] { return editor }
        let editor = BriefEditorState()
        missionBriefEditors[missionId] = editor
        return editor
    }

    var selectedMission: Mission? {
        if let id = selectedMissionId, let ref = resourceRef(id, kind: .mission), ref.host != localHost {
            return hosts.missions.first { $0.ref == ref }?.value
        }
        return client.mission(selectedMissionId)
    }

    func openMission(_ id: String, tab: MissionTab? = nil, context: HostViewContext? = nil) {
        if let ref = resourceRef(id, kind: .mission, context: context), ref.host != localHost {
            if let tab { missionTab = tab }; navigate(.mission, id: ref.storageKey); return
        }
        hosts.selection = nil
        showingArchive = false
        selectedSessionId = nil
        if let tab { missionTab = tab } else if selectedMissionId != id { missionTab = .overview }
        selectedMissionId = id
    }

    func members(of mission: Mission, context: HostViewContext? = nil) -> [SessionSummary] {
        MissionMembers.members(of: mission, in: context.map { $0.hosts.presentationClient($0.host).sessions } ?? client.sessions)
    }

    func needsYou(_ mission: Mission, context: HostViewContext? = nil) -> [MissionNeedsYouItem] {
        let client = context.map { $0.hosts.presentationClient($0.host) } ?? self.client
        return MissionNeedsYou.items(mission: mission, detail: client.missionDetails[mission.id],
                              members: members(of: mission, context: context),
                              isUnread: { session in context.map { self.isUnread(session, on: $0.host) } ?? self.attention.isUnread(session) })
    }

    func needsYouCount(_ mission: Mission, context: HostViewContext? = nil) -> Int {
        MissionNeedsYou.count(mission: mission, members: members(of: mission, context: context),
                              isUnread: { session in context.map { self.isUnread(session, on: $0.host) } ?? self.attention.isUnread(session) })
    }

    /// Runs a mission write, reporting failures in the window's action alert.
    func missionAction(_ operation: @escaping @MainActor () async throws -> Void) {
        Task {
            do { try await operation() }
            catch { sessionActionError = error.localizedDescription }
        }
    }

    /// Clear only the deleted mission's selection, and only after the daemon succeeds.
    func deleteMission(_ id: String, using client: PilotClient? = nil) async throws {
        if let ref = try? HostResourceRef.decodeKey(id) {
            try await hosts.perform(ref, kind: .mission) { client, id in try await client.deleteMission(id) }
            missionBriefEditors.removeValue(forKey: ref.storageKey)
            if selectedMissionId == ref.storageKey { selectedMissionId = nil; hosts.selection = nil }
            return
        }
        try await (client ?? self.client).deleteMission(id)
        missionBriefEditors.removeValue(forKey: id)
        if selectedMissionId == id { selectedMissionId = nil }
    }

    func removeFromMission(_ sessionId: String, context: HostViewContext? = nil) {
        let client = context.map { $0.hosts.presentationClient($0.host) } ?? self.client
        missionAction { [client] in try await client.leaveMission(sessionId) }
    }

    /// Opens the Tasks tab on a task. The tab unfolds its group and scrolls to it.
    func showMissionTask(_ taskId: String) {
        revealedMissionTaskId = taskId
        missionTab = .tasks
    }

    func setCoordinator(_ sessionId: String?, missionId: String, context: HostViewContext? = nil) {
        let client = context.map { $0.hosts.presentationClient($0.host) } ?? self.client
        missionAction { [client] in
            try await client.updateMission(missionId, UpdateMissionRequest(
                coordinatorSessionId: sessionId.map { .set($0) } ?? .clear))
        }
    }

    func startChat(for task: MissionTask, missionId: String) {
        missionAction { [weak self, client] in
            let session = try await client.startMissionTask(missionId, taskId: task.id)
            self?.selectedSessionId = session.id
        }
    }
}

/// Keeps one mission's detail subscribed while a view is on screen.
struct MissionSubscription: ViewModifier {
    @Environment(\.hostViewContext) private var hostContext
    @State private var release: (() -> Void)?
    let missionId: String?
    let client: PilotClient

    func body(content: Content) -> some View {
        content
            .onAppear { retain() }
            .onDisappear { if let release { release(); self.release = nil } else if let missionId { client.releaseMission(missionId) } }
            .onChange(of: missionId) { old, new in
                if let release { release(); self.release = nil } else if let old { client.releaseMission(old) }
                if new != nil { retain() }
            }
    }
    private func retain() {
        guard let missionId else { return }
        if let context = hostContext { release = try? context.hosts.retain(context.ref(.mission, missionId)) }
        else { client.retainMission(missionId) }
    }
}

extension View {
    func missionSubscription(_ missionId: String?, client: PilotClient) -> some View {
        modifier(MissionSubscription(missionId: missionId, client: client))
    }
}

/// Chat-level mission actions, shared by the chat header menu and the sidebar context menu.
struct SessionMissionActions: View {
    @Environment(\.hostViewContext) private var hostContext
    @EndpointClient private var endpoint
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let missionId = session.missionId {
            if endpoint.mission(missionId)?.coordinatorSessionId != session.id && !session.isArchived {
                Button("Make coordinator") { model.setCoordinator(session.id, missionId: missionId, context: hostContext) }
            }
            Button { model.openMission(missionId, context: hostContext) } label: {
                Label("Open mission", icon: PilotIcon.mission)
            }
            Button { model.removeFromMission(session.id, context: hostContext) } label: {
                Label("Remove from mission", icon: PilotIcon.remove)
            }
        } else if session.projectId != nil {
            Button { model.presentMissionSheet(.make(sessionId: session.id), context: hostContext) } label: {
                Label("Make a mission…", icon: PilotIcon.mission)
            }
            Button { model.presentMissionSheet(.add(sessionId: session.id), context: hostContext) } label: {
                Label("Add to mission…", icon: PilotIcon.addTo)
            }
        }
    }
}

extension MissionTaskStatus {
    var icon: PilotIcon {
        switch self {
        case .todo: PilotIcon.todo
        case .inProgress: PilotIcon.inProgress
        case .blocked: PilotIcon.blocked
        case .inReview: PilotIcon.inReview
        case .delegated: PilotIcon.handoff
        case .done: PilotIcon.complete
        case .dropped: PilotIcon.cancelled
        }
    }

    var color: Color {
        switch self {
        case .todo: Theme.mutedForeground
        case .inProgress: Theme.working
        case .blocked: Theme.destructive
        case .inReview: Theme.warning
        case .delegated: Theme.mutedForeground
        case .done: Theme.success
        case .dropped: Theme.faintForeground
        }
    }
}

extension MissionHealth {
    var label: String {
        switch self {
        case .onTrack: "On track"
        case .atRisk: "At risk"
        case .offTrack: "Off track"
        }
    }

    var color: Color {
        switch self {
        case .onTrack: Theme.success
        case .atRisk: Theme.warning
        case .offTrack: Theme.destructive
        }
    }
}

extension MissionStatus {
    var label: String {
        switch self {
        case .active: "Active"
        case .done: "Done"
        case .archived: "Archived"
        }
    }
}

extension MissionEventKind {
    var icon: PilotIcon {
        switch self {
        case .created: PilotIcon.skill
        case .status: PilotIcon.status
        case .handoff: PilotIcon.handoff
        case .update: PilotIcon.update
        case .brief: PilotIcon.document
        case .decision: PilotIcon.decision
        case .comment: PilotIcon.quote
        case .task: PilotIcon.tasks
        case .claim: PilotIcon.claim
        case .artifact: PilotIcon.artifact
        case .resource: PilotIcon.link
        case .member: PilotIcon.addMember
        case .coordinator: PilotIcon.coordinator
        case .github: PilotIcon.branch
        }
    }
}

extension MissionResourceKind {
    var icon: PilotIcon {
        switch self {
        case .linearProject, .linearIssue: PilotIcon.linearIssue
        case .githubIssue: PilotIcon.githubIssue
        case .githubPullRequest: PilotIcon.pullRequest
        case .slackThread: PilotIcon.slackChannel
        case .url: PilotIcon.link
        }
    }

    /// The service, for chips and accessibility labels.
    var serviceLabel: String {
        switch self {
        case .linearProject: "Linear project"
        case .linearIssue: "Linear issue"
        case .githubIssue: "GitHub issue"
        case .githubPullRequest: "GitHub pull request"
        case .slackThread: "Slack thread"
        case .url: "Link"
        }
    }
}

extension MissionResource {
    /// What VoiceOver reads for a link: the service, then its number or ID, such as
    /// "GitHub pull request #133, Open" or "Linear issue ENG-12". Falls back to the title.
    func accessibilityName(pullRequest: SessionPullRequest?) -> String {
        let reference: String? = switch kind {
        case .githubPullRequest, .githubIssue:
            pullRequest.map { "#\($0.number)" }
                ?? externalId?.split(separator: "#").last.map { "#\($0)" }
        case .linearIssue: externalId
        case .linearProject, .slackThread, .url: nil
        }
        let name = [kind.serviceLabel, reference ?? displayTitle].joined(separator: " ")
        guard let pullRequest else { return name }
        return "\(name), \(pullRequest.state.label)"
    }
}

/// The one icon for a mission link, everywhere links appear: the GitHub, Linear or Slack mark, or the link
/// symbol for other URLs. Pull requests and issues carry their state as a small coloured dot.
struct MissionLinkIcon: View {
    let kind: MissionResourceKind
    var pullRequestState: PullRequestState? = nil
    var size: CGFloat = 11

    var body: some View {
        Group {
            if let mark = PilotMark(kind) {
                PilotMarkIcon(mark: mark, context: size > 11 ? .row : .inline)
            } else {
                PilotSymbol(kind.icon)
            }
        }
            .foregroundStyle(Theme.mutedForeground)
            .frame(width: size + 2, height: size + 2)
            .overlay(alignment: .bottomTrailing) {
                if let pullRequestState {
                    Circle().fill(pullRequestState.color)
                        .frame(width: size * 0.5, height: size * 0.5)
                        .overlay(Circle().strokeBorder(Theme.background, lineWidth: 1))
                        .offset(x: 2, y: 2)
                }
            }
            .accessibilityHidden(true)
    }
}

extension MissionTaskCounts {
    /// Bar segments in `barOrder`, coloured like the task status icons and chat rows; to do is the bar's track.
    var segments: [SegmentedProgressBar.Segment] {
        Self.barOrder.map { status in
            SegmentedProgressBar.Segment(id: status.rawValue, value: self[status], color: status.progressColor)
        }
    }

    /// The bar's legend: "9 done · 2 in review · …" with matching dots, zero counts omitted.
    var legendEntries: [ProgressLegend.Entry] {
        legend.map { entry in
            ProgressLegend.Entry(id: entry.status.rawValue, text: "\(entry.count) \(entry.status.label.lowercased())",
                                 color: entry.status.progressColor)
        }
    }

    /// "2 of 6 done, 1 in review, 1 blocked" for VoiceOver and help tags.
    var summary: String {
        guard total > 0 else { return "No tasks yet" }
        let rest = Self.barOrder.dropFirst().compactMap { status in
            self[status] > 0 ? "\(self[status]) \(status.label.lowercased())" : nil
        }
        return (["\(done) of \(total) done"] + rest).joined(separator: ", ")
    }
}

extension MissionTaskStatus {
    /// Colour in progress bars and their legends: the status icon colour, with to do as the faint track.
    var progressColor: Color { self == .todo ? Theme.border : color }
}

/// Authors are chats or, when nil, the user.
@MainActor
func missionAuthorName(_ sessionId: String?, client: PilotClient) -> String {
    guard let sessionId else { return "You" }
    return client.session(sessionId)?.title ?? "A chat"
}

func missionRelativeTime(_ milliseconds: Double, now: Date = Date()) -> String {
    SessionTimeFormatting.relative(milliseconds, now: now)
}

// Shared menu items keep the toolbar and both row menus consistent.
struct MissionEditAction: View {
    @Environment(\.hostViewContext) private var hostContext
    let missionId: String
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Button { model.presentMissionSheet(.edit(missionId: missionId), context: hostContext) } label: {
            Label("Edit Title and Goal…", icon: PilotIcon.edit)
        }
    }
}

struct MissionStatusActions: View {
    @EndpointClient private var endpoint
    let missionId: String
    let status: MissionStatus
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if status != .done {
            Button { setStatus(.done) } label: { Label("Mark as Done", icon: PilotIcon.complete) }
        }
        if status != .active {
            Button { setStatus(.active) } label: { Label("Reopen", icon: PilotIcon.restore) }
        }
        if status != .archived {
            Button { setStatus(.archived) } label: { Label("Archive", icon: PilotIcon.archive) }
        }
    }

    private func setStatus(_ status: MissionStatus) {
        model.missionAction { [client = endpoint, missionId] in
            try await client.updateMission(missionId, UpdateMissionRequest(status: status))
        }
    }
}

struct MissionDeleteAction: View {
    @Environment(\.hostViewContext) private var hostContext
    let missionId: String
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Button(role: .destructive) { model.pendingMissionDeletionId = hostContext?.ref(.mission, missionId).storageKey ?? missionId } label: {
            Label("Delete Mission…", icon: PilotIcon.delete)
        }
    }
}

import AppKit
import PilotCore
import SwiftUI

/// The one mission mark, everywhere a mission appears (sidebar, inspector, pages, menus). It pairs with the
/// coordinator compass in `MissionCoordinatorIndicator`.
enum MissionSymbol {
    static let name = "map"
}

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
    /// "Start mission…" from a tracked ticket, prefilled and linked once created.
    case tracked(TrackedMissionDraft)

    var id: String {
        switch self {
        case let .create(projectId): "create-\(projectId ?? "")"
        case let .make(sessionId): "make-\(sessionId)"
        case let .add(sessionId): "add-\(sessionId)"
        case let .edit(missionId): "edit-\(missionId)"
        case let .startCoordinator(missionId): "start-coordinator-\(missionId)"
        case let .tracked(draft): "tracked-\(draft.itemId)"
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

    var selectedMission: Mission? { client.mission(selectedMissionId) }

    func openMission(_ id: String, tab: MissionTab? = nil) {
        showingArchive = false
        selectedSessionId = nil
        if let tab { missionTab = tab } else if selectedMissionId != id { missionTab = .overview }
        selectedMissionId = id
    }

    func members(of mission: Mission) -> [SessionSummary] {
        MissionMembers.members(of: mission, in: client.sessions)
    }

    func needsYou(_ mission: Mission) -> [MissionNeedsYouItem] {
        MissionNeedsYou.items(mission: mission, detail: client.missionDetails[mission.id],
                              members: members(of: mission), isUnread: { attention.isUnread($0) })
    }

    func needsYouCount(_ mission: Mission) -> Int {
        MissionNeedsYou.count(mission: mission, members: members(of: mission),
                              isUnread: { attention.isUnread($0) })
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
        try await (client ?? self.client).deleteMission(id)
        missionBriefEditors.removeValue(forKey: id)
        if selectedMissionId == id { selectedMissionId = nil }
    }

    func removeFromMission(_ sessionId: String) {
        missionAction { [client] in try await client.leaveMission(sessionId) }
    }

    /// Opens the Tasks tab on a task. The tab unfolds its group and scrolls to it.
    func showMissionTask(_ taskId: String) {
        revealedMissionTaskId = taskId
        missionTab = .tasks
    }

    func setCoordinator(_ sessionId: String?, missionId: String) {
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
    let missionId: String?
    let client: PilotClient

    func body(content: Content) -> some View {
        content
            .onAppear { if let missionId { client.retainMission(missionId) } }
            .onDisappear { if let missionId { client.releaseMission(missionId) } }
            .onChange(of: missionId) { old, new in
                if let old { client.releaseMission(old) }
                if let new { client.retainMission(new) }
            }
    }
}

extension View {
    func missionSubscription(_ missionId: String?, client: PilotClient) -> some View {
        modifier(MissionSubscription(missionId: missionId, client: client))
    }
}

/// Chat-level mission actions, shared by the chat header menu and the sidebar context menu.
struct SessionMissionActions: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let missionId = session.missionId {
            if AppModel.shared.client.mission(missionId)?.coordinatorSessionId != session.id && !session.isArchived {
                Button("Make coordinator") { model.setCoordinator(session.id, missionId: missionId) }
            }
            Button { model.openMission(missionId) } label: {
                Label("Open mission", systemImage: MissionSymbol.name)
            }
            Button { model.removeFromMission(session.id) } label: {
                Label("Remove from mission", systemImage: "minus.circle")
            }
        } else if session.projectId != nil {
            Button { model.missionSheet = .make(sessionId: session.id) } label: {
                Label("Make a mission…", systemImage: MissionSymbol.name)
            }
            Button { model.missionSheet = .add(sessionId: session.id) } label: {
                Label("Add to mission…", systemImage: "plus.circle")
            }
        }
    }
}

extension MissionTaskStatus {
    var symbol: String {
        switch self {
        case .todo: "circle"
        case .inProgress: "circle.lefthalf.filled"
        case .blocked: "exclamationmark.octagon"
        case .inReview: "eye.circle"
        case .done: "checkmark.circle.fill"
        case .dropped: "xmark.circle"
        }
    }

    var color: Color {
        switch self {
        case .todo: Theme.mutedForeground
        case .inProgress: Theme.info
        case .blocked: Theme.destructive
        case .inReview: Theme.warning
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
    var symbol: String {
        switch self {
        case .created: "sparkles"
        case .status: "flag"
        case .handoff: "arrow.right.circle"
        case .update: "text.bubble"
        case .brief: "doc.text"
        case .decision: "checkmark.seal"
        case .comment: "text.quote"
        case .task: "checklist"
        case .claim: "hand.raised"
        case .artifact: ArtifactSymbol.name
        case .resource: "link"
        case .member: "person.badge.plus"
        case .coordinator: MissionCoordinatorIndicator.symbol
        case .github: "arrow.triangle.branch"
        }
    }
}

extension MissionResourceKind {
    var symbol: String {
        switch self {
        case .linearProject, .linearIssue: "list.bullet.rectangle"
        case .githubIssue: "exclamationmark.bubble"
        case .githubPullRequest: "arrow.triangle.pull"
        case .slackThread: "number"
        case .url: "link"
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
            if let mark = BrandMark(kind) {
                Image(nsImage: mark.image)
                    .renderingMode(.template)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: size, height: size)
            } else {
                Image(systemName: kind.symbol)
                    .font(.system(size: size - 1, weight: .medium))
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
    /// Bar segments in `barOrder`, coloured like the task status icons.
    var segments: [SegmentedProgressBar.Segment] {
        Self.barOrder.map { status in
            SegmentedProgressBar.Segment(id: status.rawValue, value: self[status],
                                         color: status == .todo ? Theme.border : status.color)
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
    let missionId: String
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Button { model.missionSheet = .edit(missionId: missionId) } label: {
            Label("Edit Title and Goal…", systemImage: "pencil")
        }
    }
}

struct MissionStatusActions: View {
    let missionId: String
    let status: MissionStatus
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if status != .done {
            Button { setStatus(.done) } label: { Label("Mark as Done", systemImage: "checkmark.circle") }
        }
        if status != .active {
            Button { setStatus(.active) } label: { Label("Reopen", systemImage: "arrow.uturn.backward") }
        }
        if status != .archived {
            Button { setStatus(.archived) } label: { Label("Archive", systemImage: "archivebox") }
        }
    }

    private func setStatus(_ status: MissionStatus) {
        model.missionAction { [client = model.client, missionId] in
            try await client.updateMission(missionId, UpdateMissionRequest(status: status))
        }
    }
}

struct MissionDeleteAction: View {
    let missionId: String
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Button(role: .destructive) { model.pendingMissionDeletionId = missionId } label: {
            Label("Delete Mission…", systemImage: "trash")
        }
    }
}

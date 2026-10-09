import AppKit
import PilotCore
import SwiftUI

enum MissionTab: String, CaseIterable, Hashable {
    case overview, brief, tasks, chats, artifacts, activity

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

/// Mission sheets, presented once by the main window.
enum MissionSheet: Identifiable, Hashable {
    /// "New mission…", optionally preselecting a project.
    case create(projectId: String?)
    /// "Make a mission…" from a chat.
    case make(sessionId: String)
    /// "Add to mission…" for a chat.
    case add(sessionId: String)
    case edit(missionId: String)

    var id: String {
        switch self {
        case let .create(projectId): "create-\(projectId ?? "")"
        case let .make(sessionId): "make-\(sessionId)"
        case let .add(sessionId): "add-\(sessionId)"
        case let .edit(missionId): "edit-\(missionId)"
        }
    }
}

extension AppModel {
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

    /// Runs a mission write, reporting failures in the window's action alert.
    func missionAction(_ operation: @escaping @MainActor () async throws -> Void) {
        Task {
            do { try await operation() }
            catch { sessionActionError = error.localizedDescription }
        }
    }

    func removeFromMission(_ sessionId: String) {
        missionAction { [client] in try await client.leaveMission(sessionId) }
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
            Button { model.openMission(missionId) } label: {
                Label("Open mission", systemImage: "scope")
            }
            Button { model.removeFromMission(session.id) } label: {
                Label("Remove from mission", systemImage: "minus.circle")
            }
        } else if session.projectId != nil {
            Button { model.missionSheet = .make(sessionId: session.id) } label: {
                Label("Make a mission…", systemImage: "scope")
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
        case .artifact: "cube.transparent"
        case .resource: "link"
        case .member: "person.badge.plus"
        case .coordinator: "star"
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


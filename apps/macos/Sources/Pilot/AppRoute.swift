import PilotCore

/// A page the main window shows, used to remember per-page state such as a list's highlighted row. Back and
/// Forward use NavigationHistory, which also restores the sidebar scope.
enum AppRoute: Hashable {
    case home
    case inbox(projectId: String?)
    case archive(projectId: String?, missionId: String?)
    case project(String)
    case slackTriage(String)
    case memory(String)
    case mission(String, MissionTab)
    case session(String)

    /// Stable text for per-page memory, such as the highlighted list row.
    var key: String {
        switch self {
        case .home: "home"
        case let .inbox(projectId): "inbox:\(projectId ?? "")"
        case let .archive(projectId, missionId): "archive:\(projectId ?? ""):\(missionId ?? "")"
        case let .project(id): "project:\(id)"
        case let .slackTriage(id): "slack:\(id)"
        case let .memory(id): "memory:\(id)"
        case let .mission(id, tab): "mission:\(id):\(tab.rawValue)"
        case let .session(id): "session:\(id)"
        }
    }
}

extension AppModel {
    /// The page on screen, from the selection the window already shows.
    var currentRoute: AppRoute {
        if let id = selectedSessionId { return .session(id) }
        if let id = selectedMissionId { return .mission(id, missionTab) }
        if let id = selectedProjectId {
            // Both subpages use the same key as the project selection, local id or host-qualified key.
            if slackTriageProjectId == id { return .slackTriage(id) }
            if memoryProjectId == id { return .memory(id) }
            return .project(id)
        }
        if showingInbox { return .inbox(projectId: inboxProjectId) }
        if showingArchive { return .archive(projectId: archiveProjectId, missionId: archiveMissionId) }
        return .home
    }
}

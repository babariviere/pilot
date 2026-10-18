import Foundation

/// GET /api/control-chat/dashboard?projectId&missionId, also returned by the pilot status tool.
/// Cached daemon state, no worker starts. Text is untrusted. Lists and encoded size are bounded;
/// totals precede clipping. Next always contains global Control instructions, including scoped requests.
public struct ControlDashboardResponse: Codable, Equatable, Sendable {
    public struct Project: Codable, Equatable, Sendable {
        public let id: String
        public let name: String
    }
    public struct PullRequest: Codable, Equatable, Sendable {
        public let sessionId: String
        public let url: String
        public let title: String
        public let number: Int
        public let state: String
    }
    public struct LinearItem: Codable, Equatable, Sendable {
        public let projectId: String
        public let id: String
        public let identifier: String?
        public let title: String
        public let status: String?
        public let url: String?
    }
    public struct Next: Codable, Equatable, Sendable {
        public let watches: [Watch]
        public let total: Int
    }
    public struct Totals: Codable, Equatable, Sendable {
        public let projects: Int
        public let chats: Int
        public let missions: Int
        public let pullRequests: Int
        public let linear: Int
        public let runningAgents: Int
        public let activeMissions: Int
        public let blockers: Int
        public let pendingDecisions: Int
        public let sharedTasks: Int?
        public let replicaMissions: Int?
    }
    public let untrusted: Bool
    public let source: String
    public let projects: [Project]
    public let chats: [ControlDashboardChat]
    public let missions: [ControlDashboardMission]
    public let pullRequests: [PullRequest]
    public let linear: [LinearItem]
    public let runningAgents: [ControlDashboardAgent]
    public let activeMissions: [ControlDashboardMission]
    public let blockers: [ControlDashboardBlocker]
    public let pendingDecisions: [ControlDashboardDecision]
    /// Optional for compatibility with daemons predating shared-context status.
    public let sharedTasks: [ControlDashboardSharedTask]?
    public let replicaMissions: [ControlDashboardReplicaMission]?
    public let next: Next
    public let totals: Totals
    public let truncated: Bool
}

public struct ControlDashboardChat: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let chatUrl: String
    public let title: String
    public let projectId: String?
    public let missionId: String?
    public let state: String
    public let working: Bool?
    public let outcome: SessionOutcome?
    public let model: String?
}

public struct ControlDashboardAgent: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let chatUrl: String
    public let title: String
    public let projectId: String?
    public let missionId: String?
    public let state: String
    public let working: Bool?
    public let outcome: SessionOutcome?
    public let model: String?
    /// Latest user submission, else creation. Not worker uptime.
    public let startedAt: Double
    public let elapsedMs: Double
}

public struct ControlDashboardMission: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let status: MissionStatus
    public let tasksDone: Int
    public let tasksTotal: Int
    public let coordinatorSessionId: String?
}

public struct ControlDashboardBlocker: Codable, Identifiable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case blockedTask = "blocked_task", failedChat = "failed_chat", question
        case failingChecks = "failing_checks"
    }
    public let id: String
    public let kind: Kind
    public let projectId: String?
    public let missionId: String?
    public let sessionId: String?
    public let taskId: String?
    public let taskNumber: Int?
    public let title: String
    public let detail: String?
    public let at: Double
    public let url: String?
    public let headSha: String?
}

public struct ControlDashboardDecision: Codable, Identifiable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case edit, remove }
    public let id: String
    public let missionId: String
    public let projectId: String
    public let decisionId: String
    public let kind: Kind
    public let text: String?
    public let reason: String
    public let authorSessionId: String
    public let createdAt: Double
}

public struct ControlDashboardReplicaMission: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let bindingId: String
    public let projectId: String
    public let missionId: String
    public let missionHome: OperationHost
    public let title: String?
    public let status: MissionStatus?
    public let complete: Bool
    public let sequence: Int
    public let consistency: String
    public let replicaSyncedAt: Double?
    /// Unknown for legacy or missing replicas. Age does not imply execution failure.
    public let replicaAgeMs: Double?
}

public struct ControlDashboardSharedTask: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let bindingId: String
    public let projectId: String
    public let missionId: String
    public let missionHome: OperationHost
    public let source: String
    public let consistency: String
    public let taskId: String?
    public let taskNumber: Int?
    public let title: String?
    public let status: MissionTaskStatus?
    public let proposalId: String?
    public let proposalState: String?
    public let delegationId: String?
    public let executionHost: OperationHost?
    public let executionEpoch: Int?
    public let grantState: String?
    public let running: Bool?
    public let replicaSyncedAt: Double?
    public let replicaAgeMs: Double?
}

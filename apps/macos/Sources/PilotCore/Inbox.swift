import Foundation

// Mirrors packages/protocol/src/inbox.ts (GET /api/inbox). Keep both sides in sync.

/// A needs-you row of the Inbox, with the project it belongs to.
public struct InboxNeedsYouItem: Codable, Identifiable, Equatable, Sendable {
    public let projectId: String
    public let item: DashboardNeedsYouItem

    public var id: String { "\(projectId):\(item.id)" }

    public init(projectId: String, item: DashboardNeedsYouItem) {
        self.projectId = projectId
        self.item = item
    }

    private enum CodingKeys: String, CodingKey { case projectId }

    /// The wire row is a dashboard needs-you row with one more field.
    public init(from decoder: Decoder) throws {
        projectId = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .projectId)
        item = try DashboardNeedsYouItem(from: decoder)
    }

    public func encode(to encoder: Encoder) throws {
        try item.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(projectId, forKey: .projectId)
    }
}

/// Slack messages a project label leaves out of the Inbox: open ones of a "Hide from Inbox" label, or, when closed,
/// the ones a "Close" label dismissed.
public struct InboxHiddenLabel: Codable, Equatable, Sendable {
    public let label: String
    public let count: Int
    public let closed: Bool

    public init(label: String, count: Int, closed: Bool = false) {
        self.label = label
        self.count = count
        self.closed = closed
    }

    private enum CodingKeys: String, CodingKey { case label, count, closed }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = try container.decode(String.self, forKey: .label)
        count = try container.decode(Int.self, forKey: .count)
        closed = try container.decodeIfPresent(Bool.self, forKey: .closed) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(label, forKey: .label)
        try container.encode(count, forKey: .count)
        if closed { try container.encode(true, forKey: .closed) }
    }
}

/// An open pull request GitHub reports ready to merge, with the project it belongs to. pilotd lists it only while
/// its chat neither works nor needs the user, as in the sidebar's Ready to merge group. Pilot never merges it.
public struct InboxReadyToMergeItem: Codable, Identifiable, Equatable, Sendable {
    public let projectId: String
    public let pullRequest: DashboardPullRequest

    public var id: String { "\(projectId):\(pullRequest.id)" }

    public init(projectId: String, pullRequest: DashboardPullRequest) {
        self.projectId = projectId
        self.pullRequest = pullRequest
    }

    private enum CodingKeys: String, CodingKey { case projectId }

    /// The wire row is a dashboard pull request with one more field.
    public init(from decoder: Decoder) throws {
        projectId = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .projectId)
        pullRequest = try DashboardPullRequest(from: decoder)
    }

    public func encode(to encoder: Encoder) throws {
        try pullRequest.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(projectId, forKey: .projectId)
    }
}

/// Open and in-progress Slack messages, without dismissed ones or hidden labels, most severe first.
public struct InboxSlackSection: Codable, Equatable, Sendable {
    public let total: Int
    public let items: [TrackedItem]
    public let hidden: [InboxHiddenLabel]

    public init(total: Int, items: [TrackedItem], hidden: [InboxHiddenLabel] = []) {
        self.total = total
        self.items = items
        self.hidden = hidden
    }
}

/// Everything waiting on the user, across every project or within one. Bounded per section.
public struct Inbox: Codable, Equatable, Sendable {
    /// Chats, missions and scheduled items that need the user, most urgent first.
    public let needsYou: DashboardSection<InboxNeedsYouItem>
    /// Open pull requests ready to merge, newest check first. Never part of the badge. Empty from older daemons.
    public let readyToMerge: DashboardSection<InboxReadyToMergeItem>
    /// My Linear tickets that are not done. nil when no project in scope has a Linear team.
    public let linear: DashboardSection<TrackedItem>?
    /// nil when no project in scope tracks Slack channels.
    public let slack: InboxSlackSection?

    public init(needsYou: DashboardSection<InboxNeedsYouItem> = DashboardSection(total: 0, items: []),
                readyToMerge: DashboardSection<InboxReadyToMergeItem> = DashboardSection(total: 0, items: []),
                linear: DashboardSection<TrackedItem>? = nil, slack: InboxSlackSection? = nil) {
        self.needsYou = needsYou
        self.readyToMerge = readyToMerge
        self.linear = linear
        self.slack = slack
    }

    private enum CodingKeys: String, CodingKey { case needsYou, readyToMerge, linear, slack }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        needsYou = try container.decode(DashboardSection<InboxNeedsYouItem>.self, forKey: .needsYou)
        readyToMerge = try container.decodeIfPresent(DashboardSection<InboxReadyToMergeItem>.self, forKey: .readyToMerge)
            ?? DashboardSection(total: 0, items: [])
        linear = try container.decodeIfPresent(DashboardSection<TrackedItem>.self, forKey: .linear)
        slack = try container.decodeIfPresent(InboxSlackSection.self, forKey: .slack)
    }

    /// Nothing to list in any section.
    public var isEmpty: Bool {
        needsYou.total == 0 && readyToMerge.total == 0 && (linear?.total ?? 0) == 0 && (slack?.total ?? 0) == 0
    }
}

/// Labels for the Inbox, kept apart from views so they can be tested.
public enum InboxText {
    /// The sidebar badge: what needs the user plus open tracked items, in the given count.
    public static func badge(_ count: ProjectDashboardCount) -> Int {
        count.needsYou + count.tracked
    }

    /// "Hidden: 2 Slack messages labelled Product. Closed: 3 labelled Ops." nil when nothing is hidden or closed.
    public static func hiddenFooter(_ hidden: [InboxHiddenLabel]) -> String? {
        func sentence(_ title: String, _ entries: [InboxHiddenLabel], noun: Bool) -> String? {
            let total = entries.reduce(0) { $0 + $1.count }
            guard total > 0 else { return nil }
            let labels = entries.filter { $0.count > 0 }.map(\.label)
            let names = labels.count <= 2
                ? labels.joined(separator: " or ")
                : "\(labels.dropLast().joined(separator: ", ")) or \(labels.last!)"
            let what = noun ? " Slack \(total == 1 ? "message" : "messages")" : ""
            return "\(title): \(total)\(what) labelled \(names)."
        }
        let hiddenPart = sentence("Hidden", hidden.filter { !$0.closed }, noun: true)
        let closedPart = sentence("Closed", hidden.filter(\.closed), noun: hiddenPart == nil)
        let parts = [hiddenPart, closedPart].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// "Showing the first 50 of 72." nil when every row is shown.
    public static func capNote(shown: Int, total: Int) -> String? {
        total > shown ? "Showing the first \(shown) of \(total)." : nil
    }

    /// The empty Inbox's sentence, for every project or the one the filter picks.
    public static func clearMessage(projectName: String?) -> String {
        if let projectName {
            return "Chats that need you, pull requests ready to merge, your open tickets and Slack messages in \(projectName) appear here."
        }
        return "Chats that need you, pull requests ready to merge, your open tickets and Slack messages from every project appear here."
    }

    /// The toolbar filter's title: the picked project, or "All projects".
    public static func filterTitle(_ project: Project?) -> String {
        project?.name ?? "All projects"
    }

    /// Open pull requests reported ready to merge, per chat. Ready to merge is not part of the dashboard counts,
    /// so the Inbox reloads when this changes instead (working and needs-you changes already move the counts).
    public static func readyToMergeKey(_ sessions: [SessionSummary]) -> Set<String> {
        var key = Set<String>()
        for session in sessions where !session.isArchived {
            for pr in [session.pullRequest].compactMap({ $0 }) + (session.pullRequests ?? [])
            where pr.state == .open && pr.readiness?.state == .ready {
                key.insert("\(session.id) \(pr.url)")
            }
        }
        return key
    }

    /// Projects the Slack section's "Open triage" link leads to: each project in scope that tracks Slack
    /// channels, in the order of `projects`. One opens directly; several make the link a menu.
    public static func triageProjects(_ projects: [Project], sources: [TrackingSource], scope: String?) -> [Project] {
        let ids = Set(sources.filter { $0.kind == .slack && $0.configured && (scope == nil || $0.projectId == scope) }
            .map(\.projectId))
        return projects.filter { ids.contains($0.id) }
    }
}

extension DashboardNeedsYouItem {
    /// The row's dithered corner, as in the sidebar: failures (including scheduled items that could not
    /// start) are steady red, unread results and mission questions breathe amber.
    public var signal: SessionSignal {
        switch kind {
        case .failed, .scheduledFailed: .failed
        case .unread, .question, .longJob, .prStuck, .mcp: .needsYou
        }
    }
}

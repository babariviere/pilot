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

/// Open Slack messages a project label marked "Hide from Inbox" leaves out.
public struct InboxHiddenLabel: Codable, Equatable, Sendable {
    public let label: String
    public let count: Int

    public init(label: String, count: Int) {
        self.label = label
        self.count = count
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
    /// My Linear tickets that are not done. nil when no project in scope has a Linear team.
    public let linear: DashboardSection<TrackedItem>?
    /// nil when no project in scope tracks Slack channels.
    public let slack: InboxSlackSection?

    public init(needsYou: DashboardSection<InboxNeedsYouItem> = DashboardSection(total: 0, items: []),
                linear: DashboardSection<TrackedItem>? = nil, slack: InboxSlackSection? = nil) {
        self.needsYou = needsYou
        self.linear = linear
        self.slack = slack
    }

    /// Nothing to list in any section.
    public var isEmpty: Bool {
        needsYou.total == 0 && (linear?.total ?? 0) == 0 && (slack?.total ?? 0) == 0
    }
}

/// Labels for the Inbox, kept apart from views so they can be tested.
public enum InboxText {
    /// The sidebar badge: what needs the user plus open tracked items, in the given count.
    public static func badge(_ count: ProjectDashboardCount) -> Int {
        count.needsYou + count.tracked
    }

    /// "Hidden: 2 Slack messages labelled Product." nil when nothing is hidden.
    public static func hiddenFooter(_ hidden: [InboxHiddenLabel]) -> String? {
        let total = hidden.reduce(0) { $0 + $1.count }
        guard total > 0 else { return nil }
        let labels = hidden.map(\.label)
        let names = labels.count <= 2
            ? labels.joined(separator: " or ")
            : "\(labels.dropLast().joined(separator: ", ")) or \(labels.last!)"
        return "Hidden: \(total) Slack \(total == 1 ? "message" : "messages") labelled \(names)."
    }

    /// "Showing the first 50 of 72." nil when every row is shown.
    public static func capNote(shown: Int, total: Int) -> String? {
        total > shown ? "Showing the first \(shown) of \(total)." : nil
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
        case .unread, .question, .longJob: .needsYou
        }
    }
}

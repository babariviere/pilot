import Foundation

/// One section of the multi-host Inbox: rows from every host in one stable order, and the true count.
public struct UnifiedInboxSection<Item: Sendable>: Sendable {
    /// Host-qualified rows. The same local ID on two hosts stays two rows.
    public let rows: [Hosted<Item>]
    /// What the hosts reported in total, including rows they did not send.
    public let total: Int

    public init(rows: [Hosted<Item>] = [], total: Int = 0) {
        self.rows = rows
        self.total = total
    }

    /// Rows the hosts hold but did not send.
    public var hiddenCount: Int { max(0, total - rows.count) }
    public var isEmpty: Bool { total == 0 && rows.isEmpty }
}

/// The Inbox across every host, built only from what each host returned. Rows keep their owning host, the order
/// follows pilotd's rules (so a failure or question outranks a newer unread result whatever its ID), and the
/// result does not depend on which host answered first. Counts are the hosts' totals, not the rows received.
public struct UnifiedInboxPresentation: Sendable {
    public let needsYou: UnifiedInboxSection<InboxNeedsYouItem>
    public let readyToMerge: UnifiedInboxSection<InboxReadyToMergeItem>
    public let linear: UnifiedInboxSection<TrackedItem>
    public let slack: UnifiedInboxSection<TrackedItem>
    /// Slack messages hidden or closed by labels on any host, summed per label.
    public let hidden: [InboxHiddenLabel]

    public init(_ values: [HostRef: Inbox]) {
        let hosts = values.keys.sorted(by: Self.hostOrder)
        func section<Item: Sendable>(_ total: (Inbox) -> Int, _ rows: (Inbox) -> [Item], local: (Item) -> String,
                                     before: (Item, Item) -> Bool) -> UnifiedInboxSection<Item> {
            var all: [Hosted<Item>] = []
            var sum = 0
            for host in hosts {
                let inbox = values[host]!
                sum += total(inbox)
                all += rows(inbox).map { Hosted(ref: HostResourceRef(host: host, kind: .project, localId: local($0)), value: $0) }
            }
            return UnifiedInboxSection(rows: Self.stableSorted(all) { before($0.value, $1.value) }, total: sum)
        }
        needsYou = section({ $0.needsYou.total }, { $0.needsYou.items }, local: { $0.id }) { a, b in
            Self.compare(Self.rank(a.item.kind), Self.rank(b.item.kind))
                ?? Self.compare(b.item.at, a.item.at)
                ?? Self.compare(a.projectId, b.projectId)
                ?? Self.compare(a.item.id, b.item.id) ?? false
        }
        readyToMerge = section({ $0.readyToMerge.total }, { $0.readyToMerge.items }, local: { $0.id }) { a, b in
            Self.compare(b.pullRequest.checkedAt, a.pullRequest.checkedAt)
                ?? Self.compare(a.pullRequest.url, b.pullRequest.url)
                ?? Self.compare(a.projectId, b.projectId) ?? false
        }
        linear = section({ $0.linear?.total ?? 0 }, { $0.linear?.items ?? [] }, local: { $0.id }) { a, b in
            Self.compare(Self.linearStatusRank(a), Self.linearStatusRank(b))
                ?? Self.compare(Self.linearPriorityRank(a), Self.linearPriorityRank(b))
                ?? Self.compare(b.updatedAt, a.updatedAt) ?? Self.compare(a.id, b.id) ?? false
        }
        slack = section({ $0.slack?.total ?? 0 }, { $0.slack?.items ?? [] }, local: { $0.id }) { a, b in
            Self.compare(Self.slackRank(a), Self.slackRank(b))
                ?? Self.compare(b.updatedAt, a.updatedAt) ?? Self.compare(a.id, b.id) ?? false
        }
        var labels: [String: InboxHiddenLabel] = [:]
        for host in hosts {
            for entry in values[host]?.slack?.hidden ?? [] {
                let key = "\(entry.closed ? 1 : 0):\(entry.label)"
                let count = (labels[key]?.count ?? 0) + entry.count
                labels[key] = InboxHiddenLabel(label: entry.label, count: count, closed: entry.closed)
            }
        }
        hidden = labels.values.sorted { ($0.closed ? 1 : 0, -$0.count, $0.label) < ($1.closed ? 1 : 0, -$1.count, $1.label) }
    }

    /// What to keep when the known hosts change: last-known rows and failure markers of hosts that are still known
    /// (connected or saved offline). A removed host leaves neither, even if its first read failed and it has no rows.
    public static func retained(values: [HostRef: Inbox], errors: Set<HostRef>, known: Set<HostRef>)
        -> (values: [HostRef: Inbox], errors: Set<HostRef>) {
        (values.filter { known.contains($0.key) }, errors.intersection(known))
    }

    /// No section has anything, counting rows the hosts did not send.
    public var isEmpty: Bool { needsYou.isEmpty && readyToMerge.isEmpty && linear.isEmpty && slack.isEmpty }

    /// "Showing 50 of 72. Filter by project to see the rest." nil when every row is shown.
    public static func capNote(shown: Int, total: Int) -> String? {
        total > shown ? "Showing \(shown) of \(total). Filter by project to see the rest." : nil
    }

    /// The line under an unreachable host. Rows it last reported stay listed, so say they may be out of date.
    public static func unavailableNote(host: String, hasLastKnownRows: Bool) -> String {
        hasLastKnownRows
            ? "Can't reach \(host). Its rows here are as of the last check. Reconnect to refresh."
            : "Reconnect to \(host) to check what needs you. Last-known chats remain in the sidebar."
    }

    // MARK: Order, mirroring pilotd (project-dashboard.ts KIND_RANK, tracked-items-disk.ts inbox ORDER BY)

    static func rank(_ kind: DashboardNeedsYouKind) -> Int {
        switch kind {
        case .failed: 0
        case .question: 1
        case .scheduledFailed: 2
        case .toolStall: 3
        case .longJob: 4
        case .mcp: 5
        case .prStuck: 6
        case .unread: 7
        }
    }
    static func linearStatusRank(_ item: TrackedItem) -> Int { item.metadata["statusType"]?.string == "started" ? 0 : 1 }
    static func linearPriorityRank(_ item: TrackedItem) -> Int {
        guard let value = item.metadata["priority"]?.number, (1...4).contains(value) else { return 5 }
        return Int(value)
    }
    static func slackRank(_ item: TrackedItem) -> Int {
        switch item.slack?.overrides.severity ?? item.slack?.severity {
        case .critical: 0
        case .high: 1
        case .medium: 2
        default: 3
        }
    }

    /// true or false when the values differ in that direction, nil when equal, so comparisons chain with `??`.
    private static func compare<T: Comparable>(_ a: T, _ b: T) -> Bool? { a == b ? nil : a < b }

    public static func hostOrder(_ a: HostRef, _ b: HostRef) -> Bool {
        (a.hostId, a.daemonId, a.lineageId) < (b.hostId, b.daemonId, b.lineageId)
    }

    /// Swift's sort is not guaranteed stable, so keep the input position as the last tie-break.
    private static func stableSorted<T>(_ values: [T], by before: (T, T) -> Bool) -> [T] {
        values.enumerated().sorted { a, b in
            before(a.element, b.element) ? true : before(b.element, a.element) ? false : a.offset < b.offset
        }.map(\.element)
    }
}

import Foundation

// Pure grouping of a mission's links for the Overview: Linear, pull requests by state, everything else.

/// One link row or chip after de-duplicating by URL. Display text is computed once, when the groups are built.
public struct MissionLink: Identifiable, Equatable, Sendable {
    public let id: String
    /// The saved link this row stands for. Duplicates collapse onto one representative.
    public let resource: MissionResource
    /// Every saved link with this URL. A row can only be removed from the Overview when there is one.
    public let resourceIds: [String]
    /// The mission-level copy of the link, if any: the one a Linear issue is managed from.
    public var missionResourceId: String? = nil
    /// The lowest-numbered task that holds this link, if any.
    public let taskId: String?
    public let taskNumber: Int?
    /// Current PR state: the saved link's, else the one a chat reported.
    public let pullRequest: SessionPullRequest?
    /// "ENG-123", "Project" or "#412".
    public let identifier: String
    /// Saved or derived title. Empty when nothing better than the identifier exists.
    public let title: String
    /// Text for compact chips.
    public let chipTitle: String
    /// Epoch milliseconds the age of a pull request row counts from: the merge time, else when it was linked.
    public let age: Double

    public var url: String { resource.url }
    public var kind: MissionResourceKind { resource.kind }
    public var isDraft: Bool { pullRequest?.state == .draft }
    /// An open pull request GitHub reports no blockers for. Pilot never merges it.
    public var isReadyToMerge: Bool { pullRequest?.state == .open && pullRequest?.readiness?.state == .ready }
    /// A row's title: the saved or derived title, else the chip text.
    public var rowTitle: String { title.isEmpty ? chipTitle : title }
    /// Where the link points, for a row's second line: "#412", "ENG-123", "Linear project", "Issue #31",
    /// "Slack thread" or the host of a plain URL.
    public var reference: String {
        switch kind {
        case .githubPullRequest: identifier == "PR" ? "Pull request" : identifier
        case .linearIssue: identifier
        case .linearProject: "Linear project"
        case .githubIssue: identifier == "Issue" ? "Issue" : "Issue \(identifier)"
        case .slackThread: "Slack thread"
        case .url: URL(string: url)?.host ?? "Link"
        }
    }
}

public struct MissionLinkGroups: Equatable, Sendable {
    /// Projects first, then issues, each in the order they were added.
    public let linear: [MissionLink]
    /// Open and draft pull requests, newest first.
    public let open: [MissionLink]
    /// Merged pull requests, most recently merged first.
    public let merged: [MissionLink]
    /// Closed without merging, newest first. Hidden behind "Show closed".
    public let closed: [MissionLink]
    /// Slack, GitHub issues, plain URLs and pull requests whose state is unknown.
    public let other: [MissionLink]

    public var isEmpty: Bool { linear.isEmpty && open.isEmpty && merged.isEmpty && closed.isEmpty && other.isEmpty }
    /// Pull requests shown by default: open plus merged.
    public var pullRequestCount: Int { open.count + merged.count }
    public var hasPullRequests: Bool { pullRequestCount + closed.count > 0 }

    /// The Overview's one Links list: open pull requests (ready to merge first), Linear, other links, then merged
    /// pull requests. Closed ones follow only under "Show all" (`closed`).
    public var listed: [MissionLink] {
        open.filter(\.isReadyToMerge) + open.filter { !$0.isReadyToMerge } + linear + other + merged
    }

    public init(_ input: MissionLinksInput) {
        var order: [String] = []
        var byURL: [String: [MissionResource]] = [:]
        for resource in input.resources {
            let key = MissionLinks.normalizedURL(resource.url)
            if byURL[key] == nil { order.append(key) }
            byURL[key, default: []].append(resource)
        }
        var linear: [MissionLink] = []
        var open: [MissionLink] = []
        var merged: [MissionLink] = []
        var closed: [MissionLink] = []
        var other: [MissionLink] = []
        for key in order {
            let link = MissionLinks.link(byURL[key] ?? [], key: key, input: input)
            switch link.kind {
            case .linearProject, .linearIssue: linear.append(link)
            case .githubPullRequest:
                switch link.pullRequest?.state {
                case .draft, .open: open.append(link)
                case .merged: merged.append(link)
                case .closed: closed.append(link)
                case nil: other.append(link)
                }
            case .githubIssue, .slackThread, .url: other.append(link)
            }
        }
        func added(_ lhs: MissionLink, _ rhs: MissionLink) -> Bool {
            (lhs.resource.createdAt, lhs.id) < (rhs.resource.createdAt, rhs.id)
        }
        func newest(_ lhs: MissionLink, _ rhs: MissionLink) -> Bool {
            (lhs.age, lhs.pullRequest?.number ?? 0, lhs.id) > (rhs.age, rhs.pullRequest?.number ?? 0, rhs.id)
        }
        self.linear = linear.sorted { lhs, rhs in
            let (a, b) = (lhs.kind == .linearProject ? 0 : 1, rhs.kind == .linearProject ? 0 : 1)
            return a != b ? a < b : added(lhs, rhs)
        }
        // PR numbers grow with time, and the link time says little about when a PR was opened.
        self.open = open.sorted { ($0.pullRequest?.number ?? 0, $0.id) > ($1.pullRequest?.number ?? 0, $1.id) }
        self.merged = merged.sorted(by: newest)
        self.closed = closed.sorted(by: newest)
        self.other = other.sorted(by: added)
    }
}

/// Everything the groups depend on. Equatable, so a view can skip rebuilding when none of it changed.
public struct MissionLinksInput: Equatable, Sendable {
    /// Mission and task links.
    public var resources: [MissionResource]
    /// Task number by task ID.
    public var taskNumbers: [String: Int]
    /// PR state reported by chats, by normalized URL. Only consulted for links without saved state.
    public var reportedPullRequests: [String: SessionPullRequest]

    public init(resources: [MissionResource], taskNumbers: [String: Int],
                reportedPullRequests: [String: SessionPullRequest] = [:]) {
        self.resources = resources
        self.taskNumbers = taskNumbers
        self.reportedPullRequests = reportedPullRequests
    }

    public init(detail: MissionDetail, reportedPullRequests: [String: SessionPullRequest] = [:]) {
        self.init(resources: detail.resources, taskNumbers: Self.taskNumbers(detail.tasks),
                  reportedPullRequests: reportedPullRequests)
    }

    public static func taskNumbers(_ tasks: [MissionTask]) -> [String: Int] {
        Dictionary(tasks.map { ($0.id, $0.number) }, uniquingKeysWith: { first, _ in first })
    }

    /// URLs of pull request links with no saved state: the only ones that need chats' reports.
    public var unresolvedPullRequestURLs: Set<String> {
        Set(resources.filter { $0.kind == .githubPullRequest && $0.pullRequest == nil }.map(\.url))
    }
}

public enum MissionLinks {
    /// Same page, different spelling: scheme and host case, fragment and trailing slash do not matter.
    public static func normalizedURL(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var parts = URLComponents(string: trimmed), parts.host != nil else { return trimmed }
        parts.scheme = parts.scheme?.lowercased()
        parts.host = parts.host?.lowercased()
        parts.fragment = nil
        while parts.path.count > 1, parts.path.hasSuffix("/") { parts.path.removeLast() }
        return parts.string ?? trimmed
    }

    fileprivate static func link(_ copies: [MissionResource], key: String, input: MissionLinksInput) -> MissionLink {
        // Prefer the copy that knows the most: PR state, then a saved title.
        func knowledge(_ resource: MissionResource) -> (Double, Int) {
            (resource.pullRequest?.checkedAt ?? -1, resource.title == nil ? 0 : 1)
        }
        let representative = copies.max { knowledge($0) < knowledge($1) } ?? copies[0]
        let owner = copies
            .compactMap { copy in copy.taskId.flatMap { id in input.taskNumbers[id].map { (id: id, number: $0) } } }
            .min { ($0.number, $0.id) < ($1.number, $1.id) }
        let saved = copies.compactMap(\.pullRequest).max { $0.checkedAt < $1.checkedAt }
        let pullRequest = representative.kind == .githubPullRequest ? saved ?? input.reportedPullRequests[key] : nil
        let linked = copies.map(\.createdAt).min() ?? representative.createdAt
        let age = pullRequest.map { $0.state == .merged ? ($0.mergedAt ?? $0.checkedAt) : linked } ?? linked
        let text = display(representative, pullRequest: pullRequest)
        return MissionLink(
            id: representative.id, resource: representative, resourceIds: copies.map(\.id),
            missionResourceId: copies.first { $0.taskId == nil }?.id,
            taskId: owner?.id, taskNumber: owner?.number, pullRequest: pullRequest,
            identifier: text.identifier, title: text.title, chipTitle: text.chip, age: age)
    }

    static func display(_ resource: MissionResource, pullRequest: SessionPullRequest?)
        -> (identifier: String, title: String, chip: String) {
        let saved = resource.title?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let number = resource.externalId?.split(separator: "#").last.map { "#\($0)" }
        switch resource.kind {
        case .githubPullRequest:
            let identifier = pullRequest.map { "#\($0.number)" } ?? number ?? "PR"
            let title = pullRequest?.title.nonEmpty ?? saved ?? ""
            return (identifier, title, [identifier, title].filter { !$0.isEmpty }.joined(separator: " "))
        case .linearIssue:
            let identifier = resource.externalId ?? "Linear"
            let title = saved ?? slugTitle(resource.url, after: "issue", skipping: 1) ?? ""
            return (identifier, title, saved ?? identifier)
        case .linearProject:
            let title = saved ?? slugTitle(resource.url, after: "project", skipping: 0) ?? "Linear project"
            return ("Project", title, title)
        case .githubIssue:
            let chip = saved ?? ["Issue", number].compactMap { $0 }.joined(separator: " ")
            return (number ?? "Issue", saved ?? "", chip)
        case .slackThread:
            return ("Slack", saved ?? "", saved ?? "Slack thread")
        case .url:
            let host = URL(string: resource.url)?.host
            return ("Link", saved ?? host ?? resource.url, saved ?? host ?? resource.url)
        }
    }

    /// A readable title from the URL when none was saved: "…/issue/PIL-12/fix-the-thing" gives "Fix the thing".
    private static func slugTitle(_ url: String, after marker: String, skipping: Int) -> String? {
        let parts = (URL(string: url)?.pathComponents ?? []).filter { $0 != "/" }
        guard let index = parts.firstIndex(of: marker), parts.count > index + 1 + skipping else { return nil }
        var words = parts[index + 1 + skipping].split(separator: "-").map(String.init)
        // Linear project slugs end in a short hex ID.
        if skipping == 0, words.count > 1, let last = words.last, last.count >= 8, last.allSatisfy(\.isHexDigit) {
            words.removeLast()
        }
        let text = words.joined(separator: " ")
        return text.isEmpty ? nil : text.prefix(1).uppercased() + text.dropFirst()
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

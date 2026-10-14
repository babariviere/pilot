import Foundation

/// GitHub pull request links as pilotd accepts them for binding: `https://github.com/owner/repository/pull/123`.
public enum PullRequestURL {
    /// The canonical form of a pasted PR link, or nil when it is not a github.com pull request. Accepts a missing
    /// scheme, `http`, a `www.` host, PR tabs such as `/files`, queries and fragments, which pilotd rejects.
    public static func canonical(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 2048 else { return nil }
        guard let parts = URLComponents(string: trimmed.contains("://") ? trimmed : "https://\(trimmed)"),
              let scheme = parts.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = parts.host?.lowercased(), host == "github.com" || host == "www.github.com",
              parts.user == nil, parts.password == nil, parts.port == nil
        else { return nil }
        let path = parts.path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        guard path.count >= 4, path[2] == "pull", let number = number(path[3]) else { return nil }
        let owner = path[0], repository = path[1]
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        guard [owner, repository].allSatisfy({ !$0.isEmpty && $0.unicodeScalars.allSatisfy(allowed.contains) }),
              repository != ".", repository != ".."
        else { return nil }
        // Only PR tabs may follow the number: /files, /commits, /checks and their subpaths.
        guard path.count == 4 || path[4].isEmpty || ["files", "commits", "checks", "changes"].contains(path[4])
        else { return nil }
        return "https://github.com/\(owner)/\(repository)/pull/\(number)"
    }

    /// GitHub owner and repository names are case-insensitive, so are the daemon's URL comparisons.
    public static func same(_ lhs: String, _ rhs: String) -> Bool {
        (canonical(lhs) ?? lhs).lowercased() == (canonical(rhs) ?? rhs).lowercased()
    }

    /// The PR number of a canonical or pasted link.
    public static func number(of url: String) -> Int? {
        canonical(url).flatMap { $0.split(separator: "/").last.flatMap { number(String($0)) } }
    }

    private static func number(_ text: String) -> Int? {
        guard let first = text.first, first != "0", text.allSatisfy(\.isASCII), let value = Int(text),
              value > 0, value <= Int(Int32.max) else { return nil }
        return value
    }
}

extension SessionSummary {
    /// The user can attach PRs to Build chats of a project. Ask chats never push, archived chats do not follow up.
    public var canAttachPullRequests: Bool { !isAsk && projectId != nil && !isArchived }

    /// Explicitly bound to this chat, rather than discovered on one of its branches.
    public func isBoundPullRequest(_ url: String) -> Bool {
        boundPullRequests?.contains { PullRequestURL.same($0, url) } ?? false
    }

    /// The chat tracks this PR, discovered or bound.
    public func tracksPullRequest(_ url: String) -> Bool {
        isBoundPullRequest(url) || linkedPullRequests.contains { PullRequestURL.same($0.url, url) }
    }

    /// Bound PRs whose GitHub details have not arrived yet. Binding returns before pilotd refreshes GitHub.
    public var pendingBoundPullRequests: [String] {
        (boundPullRequests ?? []).filter { url in !linkedPullRequests.contains { PullRequestURL.same($0.url, url) } }
    }

    /// A bound PR whose head is not the chat's current branch shows an "attached" hint, so it is clear why it
    /// appears even though the chat never used its branch.
    public func showsAttachedHint(_ pullRequest: SessionPullRequest, current: String?) -> Bool {
        isBoundPullRequest(pullRequest.url) && (pullRequest.branch == nil || pullRequest.branch != current)
    }
}

/// Pure decisions behind the Changes pane's Attach and Detach controls, kept here so they are unit-tested.
public enum PullRequestAttachment {
    /// An open PR another chat of the same project tracks, offered as a one-click choice.
    public struct Suggestion: Identifiable, Equatable, Sendable {
        public let pullRequest: SessionPullRequest
        public let sessionId: String
        public let sessionTitle: String
        public var id: String { pullRequest.url }
    }

    /// The other chat that owns `url` now, so attaching it here moves it. Explicit bindings and unarchived chats
    /// win, then the most recently updated, because archived chats can still hold a stale cache.
    public static func owner(of url: String, excluding sessionId: String, in sessions: [SessionSummary]) -> SessionSummary? {
        sessions
            .filter { $0.id != sessionId && $0.tracksPullRequest(url) }
            .max { lhs, rhs in
                (lhs.isBoundPullRequest(url) ? 1 : 0, lhs.isArchived ? 0 : 1, lhs.updatedAt)
                    < (rhs.isBoundPullRequest(url) ? 1 : 0, rhs.isArchived ? 0 : 1, rhs.updatedAt)
            }
    }

    /// Open or draft PRs that other unarchived chats of the project track and this chat does not, newest first.
    public static func suggestions(for session: SessionSummary, in sessions: [SessionSummary],
                                   limit: Int = 5) -> [Suggestion] {
        guard let projectId = session.projectId else { return [] }
        var seen = Set<String>()
        var result: [Suggestion] = []
        for other in sessions where other.id != session.id && other.projectId == projectId && !other.isArchived {
            for pr in other.linkedPullRequests where !pr.isTerminal && !session.tracksPullRequest(pr.url) {
                let key = (PullRequestURL.canonical(pr.url) ?? pr.url).lowercased()
                guard seen.insert(key).inserted else { continue }
                result.append(Suggestion(pullRequest: pr, sessionId: other.id, sessionTitle: other.title))
            }
        }
        return Array(result.sorted { $0.pullRequest.number > $1.pullRequest.number }.prefix(limit))
    }

    /// Unfinished tasks a bound PR can be linked to: this chat's claims first, then the rest in mission order.
    public static func taskChoices(for sessionId: String, in detail: MissionDetail) -> [MissionTask] {
        let open = detail.orderedTasks.filter { $0.status != .done && $0.status != .dropped }
        return open.filter { $0.sessionId == sessionId } + open.filter { $0.sessionId != sessionId }
    }

    /// The preselected task: the chat's first unfinished claim. pilotd picks a single claim on its own, but
    /// rejects an ambiguous binding when the chat claims several, so the app always sends the choice.
    public static func defaultTask(for sessionId: String, in detail: MissionDetail) -> String? {
        taskChoices(for: sessionId, in: detail).first { $0.sessionId == sessionId }?.id
    }

    /// Without a claim the user may bind without a task. With one, pilotd links the claim when no task is
    /// given, so the picker offers only tasks.
    public static func allowsNoTask(for sessionId: String, in detail: MissionDetail) -> Bool {
        defaultTask(for: sessionId, in: detail) == nil
    }

    /// Unfinished tasks whose link to `url` detaching removes: tasks this chat claims or links it added.
    public static func linkedTasks(of url: String, sessionId: String, in detail: MissionDetail) -> [MissionTask] {
        let tasks = Dictionary(detail.tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        return detail.resources.compactMap { resource -> MissionTask? in
            guard resource.kind == .githubPullRequest, PullRequestURL.same(resource.url, url),
                  let task = resource.taskId.flatMap({ tasks[$0] }),
                  task.status != .done, task.status != .dropped,
                  task.sessionId == sessionId || resource.addedBySessionId == sessionId,
                  seen.insert(task.id).inserted
            else { return nil }
            return task
        }
        .sorted { $0.number < $1.number }
    }

    /// The confirmation shown before detaching a PR in a mission chat.
    public static func detachPrompt(number: Int, tasks: [MissionTask]) -> String {
        let numbers = tasks.map { "#\($0.number)" }
        switch numbers.count {
        case 0: return "Detach PR #\(number) from this chat?"
        case 1: return "Detach PR #\(number) and unlink it from task \(numbers[0])?"
        default:
            return "Detach PR #\(number) and unlink it from tasks \(numbers.dropLast().joined(separator: ", ")) and \(numbers.last!)?"
        }
    }
}

/// Form state of the Attach Pull Request popover. Plain value state, held in `@State`.
public struct PullRequestAttachDraft: Equatable, Sendable {
    public var text = ""
    /// Mission task ID to link. Nil leaves the choice to pilotd (the chat's claimed task, if any).
    public var taskId: String?
    public var busy = false
    public var error: String?

    public init(text: String = "", taskId: String? = nil) {
        self.text = text
        self.taskId = taskId
    }

    /// The URL sent to pilotd, or nil until the text is a GitHub PR link.
    public var url: String? { PullRequestURL.canonical(text) }

    /// Inline guidance while typing. pilotd still validates the repository and ownership.
    public func hint(for session: SessionSummary) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let url else { return "Paste a GitHub pull request link, like https://github.com/owner/repository/pull/123." }
        return session.tracksPullRequest(url) ? "Already attached to this chat." : nil
    }

    public func canSubmit(for session: SessionSummary) -> Bool {
        !busy && url != nil && hint(for: session) == nil
    }
}

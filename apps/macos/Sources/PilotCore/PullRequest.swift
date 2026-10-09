import Foundation

public enum PullRequestState: String, Codable, CaseIterable, Hashable, Sendable {
    case draft
    case open
    case merged
    case closed

    public var label: String {
        switch self {
        case .draft: "Draft"
        case .open: "Open"
        case .merged: "Merged"
        case .closed: "Closed without merging"
        }
    }

    public var compactLabel: String { self == .closed ? "Closed" : label }
}

/// Mirrors packages/protocol. Read-only GitHub metadata, independent of agent outcome.
public struct SessionPullRequest: Codable, Equatable, Hashable, Sendable {
    public let number: Int
    public let url: String
    public let title: String
    public let state: PullRequestState
    /// Head branch. Omitted by older daemons.
    public let branch: String?
    /// GitHub's merge time, epoch milliseconds, for merged PRs.
    public let mergedAt: Double?
    /// Last successful lookup, epoch milliseconds.
    public let checkedAt: Double

    public init(number: Int, url: String, title: String, state: PullRequestState, checkedAt: Double,
                branch: String? = nil, mergedAt: Double? = nil) {
        self.number = number
        self.url = url
        self.title = title
        self.state = state
        self.branch = branch
        self.mergedAt = mergedAt
        self.checkedAt = checkedAt
    }

    public var isTerminal: Bool { state == .merged || state == .closed }

    public var label: String { "\(state.label) #\(number)" }
    public var compactLabel: String { "\(state.compactLabel) #\(number)" }

    /// Allow GitHub Enterprise hosts too, but never launch arbitrary URL schemes.
    public var browserURL: URL? {
        guard let parts = URLComponents(string: url),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host, !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              parts.user == nil, parts.password == nil
        else { return nil }
        return parts.url
    }

    public var checkedDate: Date? {
        checkedAt.isFinite ? Date(timeIntervalSince1970: checkedAt / 1000) : nil
    }
}

extension SessionSummary {
    /// Every PR linked to the session, the current branch's first. Falls back to pullRequest for older daemons.
    public var linkedPullRequests: [SessionPullRequest] {
        if let pullRequests, !pullRequests.isEmpty { return pullRequests }
        return pullRequest.map { [$0] } ?? []
    }

    /// Every session branch paired with its PR, the current branch first. PRs without a known head branch
    /// (older daemons) attach to the current branch when it has none, otherwise they follow without a name.
    public func branchLinks(current: String? = nil) -> [SessionBranchLink] {
        let current = current ?? branch
        let prs = linkedPullRequests
        var names: [String] = []
        for name in [current] + (branches ?? []).map(Optional.some) + prs.map(\.branch) {
            if let name, !name.isEmpty, !names.contains(name) { names.append(name) }
        }
        var unclaimed = prs
        var links = names.map { name -> SessionBranchLink in
            let index = unclaimed.firstIndex { $0.branch == name }
                ?? (name == current ? unclaimed.firstIndex { $0.branch == nil && $0.url == pullRequest?.url } : nil)
            return SessionBranchLink(name: name, pullRequest: index.map { unclaimed.remove(at: $0) })
        }
        links += unclaimed.map { SessionBranchLink(name: nil, pullRequest: $0) }
        return links
    }
}

/// A session branch and the PR opened from it, if any. A nil name is a PR whose head branch is unknown.
public struct SessionBranchLink: Equatable, Hashable, Sendable, Identifiable {
    public let name: String?
    public let pullRequest: SessionPullRequest?

    public init(name: String?, pullRequest: SessionPullRequest?) {
        self.name = name
        self.pullRequest = pullRequest
    }

    public var id: String { name.map { "branch:\($0)" } ?? "pr:\(pullRequest?.url ?? "")" }
}

extension SessionSummary {

    public var pullRequestIsStale: Bool { pullRequestError != nil }

    public var pullRequestHelpText: String? {
        let prs = linkedPullRequests
        guard !prs.isEmpty else {
            return pullRequestError.map { "Pull request lookup failed. No cached status available.\n\($0)" }
        }
        var lines: [String] = []
        for pr in prs {
            lines.append("\(pullRequestIsStale ? "Last known: " : "")\(pr.label): \(pr.title)")
            if prs.count > 1, let branch = pr.branch { lines.append("Branch: \(branch)") }
            let checked = pr.checkedDate?.formatted(date: .abbreviated, time: .standard) ?? "Unknown"
            lines.append("Last checked: \(checked)")
        }
        if let error = pullRequestError { lines.append("Lookup failed. Cached status may be out of date.\n\(error)") }
        if prs.contains(where: { $0.browserURL == nil }) {
            lines.append("Invalid pull request link. Cannot open in browser.")
        } else {
            lines.append(prs.count > 1 ? "Open pull requests in browser. No merge action." : "Open pull request in browser. No merge action.")
        }
        return lines.joined(separator: "\n")
    }
}

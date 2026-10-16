import Foundation

/// Explicit user merges only. GitHub remains authoritative for permissions and branch protection.
public enum PullRequestMergeMethod: String, Codable, CaseIterable, Hashable, Sendable {
    case squash, merge, rebase

    public var label: String {
        switch self {
        case .squash: "Squash and merge"
        case .merge: "Create a merge commit"
        case .rebase: "Rebase and merge"
        }
    }
}

public struct PullRequestMergePreview: Codable, Equatable, Sendable {
    public let url: String
    public let number: Int
    public let title: String
    public let headSha: String
    public let headBranch: String
    public let baseBranch: String
    public let methods: [PullRequestMergeMethod]
}

/// Mirrors POST /api/sessions/:id/pull-requests/merge. Returns { merged: true }.
public struct MergePullRequestRequest: Codable, Equatable, Sendable {
    public let url: String
    public let headSha: String
    public let baseBranch: String
    public let method: PullRequestMergeMethod

    public init(preview: PullRequestMergePreview, method: PullRequestMergeMethod) {
        url = preview.url
        headSha = preview.headSha
        baseBranch = preview.baseBranch
        self.method = method
    }
}

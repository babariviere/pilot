import PilotCore
import SwiftUI

struct PullRequestMergeTarget: Identifiable {
    let sessionId: String
    let pullRequest: SessionPullRequest
    var reference: HostResourceRef? = nil
    var id: String { "\(sessionId):\(pullRequest.url)" }

    static func candidates(in session: SessionSummary) -> [SessionPullRequest] {
        guard !session.isArchived, session.projectId != nil, !session.isMissionCoordinator else { return [] }
        return session.linkedPullRequests.filter { $0.state == .open && $0.browserURL != nil }
    }

    static func latest(in session: SessionSummary, reference: HostResourceRef? = nil) -> Self? {
        candidates(in: session).max(by: { $0.number < $1.number }).map {
            Self(sessionId: session.id, pullRequest: $0, reference: reference)
        }
    }
}

/// An explicit confirmation, never an agent prompt. Fresh GitHub data fences the final merge to this head.
struct PullRequestMergeSheet: View {
    @EndpointClient private var client
    let target: PullRequestMergeTarget
    @EnvironmentObject private var model: AppModel
    @State private var preview: PullRequestMergePreview?
    @State private var method: PullRequestMergeMethod = .squash
    @State private var loading = true
    @State private var merging = false
    @State private var merged = false
    @State private var error: String?

    var body: some View {
        SheetScaffold(merged ? "PR #\(target.pullRequest.number) merged" : "Merge PR #\(target.pullRequest.number)",
                      primary: merged ? nil : SheetPrimaryAction(title: merging ? "Merging…" : "Merge PR",
                                                                  enabled: preview != nil && !loading,
                                                                  action: merge), width: 460) {
            if merged {
                Text("The pull request was merged on GitHub.")
                    .font(.pilot(.body))
            } else if let preview {
                Text(preview.title)
                    .font(.pilot(.body, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                Text(preview.url)
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(preview.headBranch) → \(preview.baseBranch) · \(String(preview.headSha.prefix(7)))")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
                Picker("Merge method", selection: $method) {
                    ForEach(preview.methods, id: \.self) { method in
                        Text(method.label).tag(method)
                    }
                }
                Text("GitHub checks permissions and branch protection. This merges now, without enabling auto-merge or deleting the branch.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            } else if loading {
                HStack(spacing: 8) {
                    EllipsisSpinner()
                    Text("Checking pull request…").font(.pilot(.body))
                }
            }
            if let error {
                InlineProblem(error, retrying: loading) { Task { await load() } }
            }
        }
        .disabled(merging)
        .interactiveDismissDisabled(merging)
        .task { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        preview = nil
        defer { loading = false }
        do {
            let value = try await client.previewPullRequestMerge(target.sessionId, url: target.pullRequest.url)
            guard !Task.isCancelled else { return }
            method = value.methods.first ?? .squash
            preview = value
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func merge() {
        guard let preview, !merging, !loading else { return }
        merging = true
        error = nil
        Task {
            defer { merging = false }
            do {
                try await client.mergePullRequest(target.sessionId, preview: preview, method: method)
                merged = true
            } catch {
                // A lost response may follow a successful merge. Re-read before any further confirmation.
                self.preview = nil
                self.error = "\(error.localizedDescription) Reload the pull request before trying again."
            }
        }
    }
}

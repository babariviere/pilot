import PilotCore
import SwiftUI

@MainActor
final class SessionRepositoryModel: ObservableObject {
    @Published private(set) var summary: SessionChangeSummary?
    @Published private(set) var error: String?

    func branch(for session: SessionSummary) -> String? {
        if let summary { return summary.branch }
        return session.branch
    }

    func load(_ session: SessionSummary, client: PilotClient) async {
        guard session.state != "starting" else { return }
        do {
            let summary = try await client.changeSummary(session.id)
            try Task.checkCancellation()
            if self.summary != summary { self.summary = summary }
            if error != nil { error = nil }
        } catch {
            guard !Task.isCancelled else { return }
            // Never present a failed lookup as zero changes or a stale count as current.
            if summary != nil { summary = nil }
            if self.error != error.localizedDescription { self.error = error.localizedDescription }
        }
    }
}

/// Keep the PR link distinct from local repository metadata and run status.
struct SessionRepositoryMetadata: View {
    let session: SessionSummary
    @EnvironmentObject private var app: AppModel
    @StateObject private var model = SessionRepositoryModel()

    var body: some View {
        SessionRepositoryMetadataContent(session: session, summary: model.summary,
                                         branch: model.branch(for: session), error: model.error)
        .task(id: session.state) {
            guard session.state != "starting" else { return }
            // SwiftUI cancels this task when the row disappears. State changes refresh immediately;
            // periodic reads also pick up external edits in idle sessions.
            while !Task.isCancelled {
                await model.load(session, client: app.client)
                do { try await Task.sleep(for: .seconds(10)) }
                catch { return }
            }
        }
    }
}

/// Fixed-size metadata must not set the minimum width of the entire session row.
/// Prefer complete stats, dropping the branch and then line counts on narrow sidebars.
struct SessionRepositoryMetadataContent: View {
    let session: SessionSummary
    let summary: SessionChangeSummary?
    let branch: String?
    let error: String?

    var body: some View {
        ViewThatFits(in: .horizontal) {
            metadata(showBranch: true, showLineStats: true)
                .fixedSize(horizontal: true, vertical: false)
            if summary != nil {
                metadata(showBranch: false, showLineStats: true)
                    .fixedSize(horizontal: true, vertical: false)
                metadata(showBranch: false, showLineStats: false)
                    .fixedSize(horizontal: true, vertical: false)
            }
            HStack(spacing: 6) {
                PullRequestBadge(session: session)
                if session.pullRequest == nil && session.pullRequestError == nil {
                    if let summary {
                        Text(summary.fileCountLabel).monospacedDigit()
                    } else if let branch, !branch.isEmpty {
                        Text(branch).truncationMode(.middle)
                    }
                }
            }
            .lineLimit(1)
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(Theme.mutedForeground)
        .help([summary?.helpText, branch.map { "Branch: \($0)" },
               error.map { "Git changes unavailable: \($0)" }].compactMap { $0 }.joined(separator: "\n"))
    }

    private func metadata(showBranch: Bool, showLineStats: Bool) -> some View {
        HStack(spacing: 6) {
            PullRequestBadge(session: session)
            if let summary {
                Text(summary.fileCountLabel)
                    .monospacedDigit()
                    .fixedSize()
                    .help(summary.helpText)
                    .accessibilityLabel("\(summary.fileCountLabel) changed since \(summary.base)")
                if showLineStats, let additions = summary.additions, let deletions = summary.deletions {
                    DiffStat(additions: additions, deletions: deletions, showZero: true, fontSize: 10)
                        .fixedSize()
                        .help(summary.helpText)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(summary.lineStatLabel ?? "")
                }
            }
            if showBranch, let branch, !branch.isEmpty {
                if session.pullRequest != nil || session.pullRequestError != nil || summary != nil {
                    Text("·").accessibilityHidden(true)
                }
                Text(branch)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(-1)
                    .help("Branch: \(branch)" + (error.map { "\nGit changes unavailable: \($0)" } ?? ""))
                    .accessibilityLabel("Branch \(branch)")
            }
        }
    }
}

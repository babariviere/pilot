import PilotCore
import SwiftUI

@MainActor
final class SessionRepositoryModel: ObservableObject {
    @Published private(set) var summary: SessionChangeSummary?
    @Published private(set) var error: String?

    func branch(for session: SessionSummary) -> String? {
        guard !session.isMissionCoordinator else { return nil }
        if let summary { return summary.branch }
        return session.branch
    }

    func load(_ session: SessionSummary, client: PilotClient) async {
        guard !Task.isCancelled, session.supportsChanges, session.state != "starting" else { return }
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
    @Environment(\.repositoryPollingVisible) private var windowVisible
    @StateObject private var model = SessionRepositoryModel()

    private var pollingKey: RepositoryPollingKey {
        RepositoryPollingKey(visible: windowVisible, state: session.state, updatedAt: session.updatedAt)
    }

    var body: some View {
        if session.isAsk {
            Label("Ask · \(session.sourceLabel)", systemImage: "questionmark.bubble")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Theme.mutedForeground).lineLimit(1)
                .help("Read-only · no isolated workspace" + (session.sourceCommit.map { "\nSource commit: \($0)" } ?? ""))
        } else if !session.isMissionCoordinator {
            SessionRepositoryMetadataContent(session: session, summary: model.summary,
                                             branch: model.branch(for: session), error: model.error)
            .preference(key: SessionRepositoryHelpKey.self,
                        value: SessionRepositoryHelp.text(summary: model.summary, branch: model.branch(for: session),
                                                          error: model.error))
            .task(id: pollingKey) {
                guard pollingKey.enabled else { return }
                // Refresh on return/activity, but back off idle workspaces. External editor changes
                // still arrive on the bounded periodic fallback, without polling hidden windows.
                while !Task.isCancelled {
                    await model.load(session, client: app.client)
                    do { try await Task.sleep(for: .seconds(RepositoryPolling.interval(working: session.isWorking, fullDiff: false))) }
                    catch { return }
                }
            }
        }
    }
}

/// The changes, branch and lookup errors behind a row's metadata, for the row's tooltip.
/// Rows show no diff counts, so this is where they surface outside the Changes pane.
struct SessionRepositoryHelpKey: PreferenceKey {
    static let defaultValue: String? = nil
    static func reduce(value: inout String?, nextValue: () -> String?) { value = value ?? nextValue() }
}

/// A row's PR badge and branch. Lists show no file or line counts (those live in the Changes pane and the
/// row tooltip, via SessionRepositoryHelpKey). The branch truncates first, so the metadata never sets the
/// row's minimum width.
struct SessionRepositoryMetadataContent: View {
    let session: SessionSummary
    let summary: SessionChangeSummary?
    let branch: String?
    let error: String?

    var body: some View {
        if !session.isMissionCoordinator {
            HStack(spacing: 6) {
                PullRequestBadge(session: session)
                if let branch, !branch.isEmpty {
                    if !session.linkedPullRequests.isEmpty || session.pullRequestError != nil {
                        Text("·").accessibilityHidden(true)
                    }
                    Text(branch)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(-1)
                        .accessibilityLabel("Branch \(branch)")
                }
            }
            .lineLimit(1)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(Theme.mutedForeground)
        }
    }
}

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
            self.summary = summary
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            // Never present a failed lookup as zero changes or a stale count as current.
            summary = nil
            self.error = error.localizedDescription
        }
    }
}

/// Keep the PR link distinct from local repository metadata and run status.
struct SessionRepositoryMetadata: View {
    let session: SessionSummary
    @EnvironmentObject private var app: AppModel
    @StateObject private var model = SessionRepositoryModel()

    var body: some View {
        HStack(spacing: 6) {
            PullRequestBadge(session: session)
            if let summary = model.summary {
                Text(summary.fileCountLabel)
                    .monospacedDigit()
                    .fixedSize()
                    .help(summary.helpText)
                    .accessibilityLabel(summary.helpText)
            }
            if let branch = model.branch(for: session), !branch.isEmpty {
                Label(branch, systemImage: "arrow.triangle.branch")
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(-1)
                    .help("Branch: \(branch)" + (model.error.map { "\nGit changes unavailable: \($0)" } ?? ""))
                    .accessibilityLabel("Branch \(branch)")
            }
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(Theme.mutedForeground)
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

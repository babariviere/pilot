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

/// Loads a chat's repository summary while its row is on screen and hands the current branch to `content`, which
/// lays out the row's second line (`RowLine`). Ask chats and coordinators have no workspace of their own, so
/// nothing loads and the branch is nil. The changes, branch and lookup errors go to the row's tooltip through
/// `SessionRepositoryHelpKey`.
struct SessionRepositoryMetadata<Content: View>: View {
    let session: SessionSummary
    @ViewBuilder let content: (String?) -> Content
    @EnvironmentObject private var app: AppModel
    @Environment(\.repositoryPollingVisible) private var windowVisible
    @StateObject private var model = SessionRepositoryModel()

    private var pollingKey: RepositoryPollingKey {
        RepositoryPollingKey(visible: windowVisible, state: session.state, updatedAt: session.updatedAt)
    }

    var body: some View {
        if session.isAsk || session.isMissionCoordinator {
            content(nil)
        } else {
            content(model.branch(for: session))
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

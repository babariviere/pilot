import PilotCore
import SwiftUI

@MainActor
final class SessionRepositoryModel: ObservableObject {
    @Published private(set) var branchSnapshot: SessionBranch?
    @Published private(set) var summary: SessionChangeSummary?
    @Published private var branchError: String?
    @Published private var summaryError: String?
    var error: String? { summaryError ?? branchError }

    func branch(for session: SessionSummary) -> String? {
        guard !session.isMissionCoordinator else { return nil }
        if let branchSnapshot { return branchSnapshot.branch }
        if let summary { return summary.branch }
        return session.branch
    }

    func clearSummary() {
        if summary != nil { summary = nil }
        if summaryError != nil { summaryError = nil }
    }

    func loadBranch(_ session: SessionSummary, client: PilotClient) async {
        guard !Task.isCancelled, session.supportsChanges, session.state != "starting" else { return }
        do {
            let snapshot = try await client.repositoryBranch(session.id)
            try Task.checkCancellation()
            if branchSnapshot != snapshot {
                branchSnapshot = snapshot
                if let summary, summary.branch != snapshot.branch { clearSummary() }
            }
            if branchError != nil { branchError = nil }
        } catch {
            guard !Task.isCancelled else { return }
            if branchSnapshot != nil { branchSnapshot = nil }
            clearSummary()
            if branchError != error.localizedDescription { branchError = error.localizedDescription }
        }
    }

    func load(_ session: SessionSummary, client: PilotClient) async {
        guard !Task.isCancelled, session.supportsChanges, session.state != "starting" else { return }
        do {
            let summary = try await client.changeSummary(session.id)
            try Task.checkCancellation()
            if self.summary != summary { self.summary = summary }
            if summaryError != nil { summaryError = nil }
        } catch {
            guard !Task.isCancelled else { return }
            // Never present a failed lookup as zero changes or a stale count as current.
            if summary != nil { summary = nil }
            if summaryError != error.localizedDescription { summaryError = error.localizedDescription }
        }
    }
}

/// Polls only a chat's branch while its row is on screen; diff counts load only for its hovered tooltip.
/// Hands the current branch to `content`, which
/// lays out the row's second line (`RowLine`). Ask chats and coordinators have no workspace of their own, so
/// nothing loads and the branch is nil. The changes, branch and lookup errors go to the row's tooltip through
/// `SessionRepositoryHelpKey`.
struct SessionRepositoryMetadata<Content: View>: View {
    let session: SessionSummary
    var hovered = false
    @ViewBuilder let content: (String?) -> Content
    @EnvironmentObject private var app: AppModel
    @Environment(\.repositoryPollingVisible) private var windowVisible
    @StateObject private var model = SessionRepositoryModel()

    private var pollingKey: RepositoryPollingKey {
        RepositoryPollingKey(visible: windowVisible, state: session.state, updatedAt: session.updatedAt)
    }

    private var summaryKey: RepositoryPollingKey {
        RepositoryPollingKey(visible: windowVisible && hovered, state: session.state, updatedAt: session.updatedAt)
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
                        await model.loadBranch(session, client: app.client)
                        do { try await Task.sleep(for: .seconds(RepositoryPolling.interval(working: session.isWorking, fullDiff: false))) }
                        catch { return }
                    }
                }
                .task(id: summaryKey) {
                    model.clearSummary()
                    guard summaryKey.enabled else { return }
                    // At most the hovered row scans file/line stats, with the same visibility and cancellation gates.
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

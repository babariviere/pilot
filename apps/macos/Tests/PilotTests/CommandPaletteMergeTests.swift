import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func paletteMergeActionsOnlyOfferOpenProjectPRsAndOpenConfirmation() throws {
    let defaults = UserDefaults(suiteName: "palette-merge-\(UUID().uuidString)")!
    let model = AppModel(projectFolderDefaults: defaults)
    let catalog = CommandPaletteCatalog(model: model, openSettings: {}, openKeyboardShortcuts: {})
    let prs = [PullRequestState.open, .draft, .closed, .merged].enumerated().map { index, state in
        SessionPullRequest(number: index + 1, url: "https://github.com/o/r/pull/\(index + 1)", title: "PR",
                           state: state, checkedAt: 1)
    }
    func session(project: String? = "p", archived: Bool = false, coordinator: Bool = false) -> SessionSummary {
        SessionSummary(id: "s", title: "Chat", cwd: "/tmp", projectId: project, createdAt: 1, updatedAt: 1,
                       state: "idle", pullRequests: prs, archivedAt: archived ? 1 : nil,
                       missionCoordinator: coordinator)
    }
    let actions = catalog.chatActions(session(), suggested: true)
    let matches = CommandPalette.results(for: "merge PR", items: actions.map(\.item))
    #expect(matches.flatMap(\.items).map(\.title) == ["Merge PR #1…"])
    let action = try #require(actions.first { $0.item.id.contains("merge-pr") })
    #expect(action.shortcut == "⌘⇧M")
    #expect(catalog.chatActions(session()).first { $0.item.id.contains("merge-pr") }?.shortcut == nil)
    #expect(model.mergingPullRequest == nil)
    action.perform()
    #expect(model.mergingPullRequest?.sessionId == "s")
    #expect(model.mergingPullRequest?.pullRequest == prs[0])
    for unavailable in [session(project: nil), session(archived: true), session(coordinator: true)] {
        #expect(!catalog.chatActions(unavailable).contains { $0.item.id.contains("merge-pr") })
    }
    // Number queries offer the same confirmation action after resolving the PR's owning chat.
    let item = CommandPaletteItem(id: "chat:s", kind: .chat, title: "Chat", pullRequestNumbers: [1])
    let numbered = CommandPalette.results(for: "#1", items: [item]) { _ in actions.map(\.item) }
    #expect(numbered.flatMap(\.items).contains { $0.id == action.item.id })
}

@Test @MainActor func mergeShortcutConfirmsTheLatestOpenPRAndWaitsForPaletteDismissal() {
    let defaults = UserDefaults(suiteName: "merge-shortcut-\(UUID().uuidString)")!
    let model = AppModel(projectFolderDefaults: defaults)
    func pr(_ number: Int, _ state: PullRequestState, url: String? = nil) -> SessionPullRequest {
        SessionPullRequest(number: number, url: url ?? "https://github.com/o/r/pull/\(number)", title: "PR",
                           state: state, checkedAt: 1)
    }
    let latest = pr(8, .open)
    let session = SessionSummary(id: "s", title: "Chat", cwd: "/tmp", projectId: "p", createdAt: 1, updatedAt: 1,
                                 state: "idle", pullRequests: [pr(4, .open), latest, pr(10, .draft), pr(11, .merged),
                                                              pr(12, .open, url: "javascript:bad")])
    model.client.loadFixture(projects: [], sessions: [session])
    #expect(model.latestPullRequestMergeTarget == nil)
    model.selectedSessionId = "s"
    #expect(model.latestPullRequestMergeTarget?.pullRequest == latest)
    model.mergeLatestPullRequest()
    #expect(model.mergingPullRequest?.pullRequest == latest)
    #expect(model.latestPullRequestMergeTarget == nil, "the shortcut is disabled while confirmation is open")

    model.mergingPullRequest = nil
    model.showingCommandPalette = true
    model.mergeLatestPullRequest()
    #expect(!model.showingCommandPalette)
    #expect(model.mergingPullRequest == nil, "do not present over the palette's sheet")
    let deferred = model.commandPaletteAction
    model.commandPaletteAction = nil
    deferred?()
    #expect(model.mergingPullRequest?.pullRequest == latest)
    model.mergingPullRequest = nil
    model.renamingSession = SessionRenameTarget(id: "s", title: "Chat")
    #expect(model.latestPullRequestMergeTarget == nil, "do not present over another sheet")
    #expect(PullRequestMergeTarget.latest(in: SessionSummary(id: "empty", title: "Chat", cwd: "/tmp",
                                                          projectId: "p", createdAt: 1, updatedAt: 1,
                                                          state: "idle", pullRequests: [pr(10, .draft), pr(11, .merged)])) == nil)
}

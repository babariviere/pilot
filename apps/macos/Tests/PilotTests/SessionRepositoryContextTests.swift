import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func sessionSubtitleShowsProjectAndBranchInsteadOfModel() {
    for branch in [nil, "", "feat/artifact-sharing"] as [String?] {
        let session = SessionSummary(id: "subtitle", title: "Chat", cwd: "/repository", branch: branch,
                                     createdAt: 1, updatedAt: 1, state: "idle", model: "provider/model")
        #expect(SessionHeaderContext.subtitle(for: session, place: "pilot") ==
                (branch == "feat/artifact-sharing" ? "pilot · feat/artifact-sharing" : "pilot"))
    }
}

@Test @MainActor func askSubtitleShowsPinnedSourceInsteadOfWorkingBranch() throws {
    for sourceBranch in [nil, "main"] as [String?] {
        let session = SessionSummary(id: "ask", title: "Question", cwd: "/repository", branch: "wrong-branch",
                                     createdAt: 1, updatedAt: 1, state: "idle", mode: .ask,
                                     sourceBranch: sourceBranch, sourceCommit: "abc123")
        #expect(SessionHeaderContext.subtitle(for: session, place: "pilot") ==
                "pilot · \(sourceBranch == nil ? "Current checkout" : "origin/main")")
        let renderer = ImageRenderer(content: SessionContextBadge(session: session))
        renderer.proposedSize = ProposedViewSize(width: 160, height: nil)
        let image = try #require(renderer.cgImage)
        #expect(image.width > 0 && image.width <= 160)
        #expect(session.workspaceHelp.contains("abc123"))
    }
}

@Test @MainActor func inspectorToolbarControlsRespectSessionAvailability() throws {
    func render(_ session: SessionSummary) throws -> CGImage {
        let renderer = ImageRenderer(content: HStack {
            SessionInspectorControls(session: session)
        }.environmentObject(AppModel.shared))
        return try #require(renderer.cgImage)
    }
    let build = SessionSummary(id: "actions", title: "Chat", cwd: "/repository",
                               createdAt: 1, updatedAt: 1, state: "idle")
    let ask = SessionSummary(id: "ask-actions", title: "Ask", cwd: "/repository",
                             createdAt: 1, updatedAt: 1, state: "idle", mode: .ask)
    let askImage = try render(ask)
    let buildImage = try render(build)
    let agentsImage = try render(Fixtures.subagentSession)
    // The system controls sizing; only the available controls change the width.
    #expect(askImage.width > 0 && askImage.height > 0)
    #expect(buildImage.width > askImage.width)
    #expect(agentsImage.width > buildImage.width)
}

@Test @MainActor func changesRepositoryContextWrapsFullBranchAtNarrowWidths() throws {
    for state in ["starting", "idle", "failed"] {
        let short = SessionSummary(id: "short", title: "Chat", cwd: "/repository", branch: "fix/short",
                                   createdAt: 1, updatedAt: 1, state: state, workspace: .clone)
        let long = SessionSummary(id: "long", title: "Chat", cwd: "/repository",
                                  branch: String(repeating: "long-branch-", count: 12),
                                  createdAt: 1, updatedAt: 1, state: state, workspace: .clone)
        for width in [316.0, 496.0] {
            let renderer = ImageRenderer(content: ChangesRepositoryContext(session: long))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            let image = try #require(renderer.cgImage)
            let reference = ImageRenderer(content: ChangesRepositoryContext(session: short))
            reference.proposedSize = renderer.proposedSize
            #expect(Double(image.width) <= width + 1)
            #expect(image.height > (try #require(reference.cgImage)).height, "full branch wraps rather than truncates")
        }
    }
}

@Test @MainActor func changesRepositoryContextRendersWithoutBranchOrPullRequest() throws {
    for workspace in [WorkspaceMode.clone, .direct] {
        let session = SessionSummary(id: "context", title: "Chat", cwd: "/repository",
                                     createdAt: 1, updatedAt: 1, state: "idle", workspace: workspace)
        let renderer = ImageRenderer(content: ChangesRepositoryContext(session: session))
        renderer.proposedSize = ProposedViewSize(width: 316, height: nil)
        let image = try #require(renderer.cgImage)
        #expect(image.width > 0 && image.width <= 317)
        #expect(image.height > 24)
    }
}

@Test @MainActor func changesRepositoryContextUsesLoadedBranchIncludingDetachedWorkspaces() {
    let session = SessionSummary(id: "branch", title: "Chat", cwd: "/repository", branch: "fix/old",
                                 createdAt: 1, updatedAt: 1, state: "idle")
    #expect(ChangesRepositoryContext(session: session).branch == "fix/old")
    #expect(ChangesRepositoryContext(session: session, changes: SessionChanges(
        base: "origin/main", branch: "fix/current", files: [], diff: "")).branch == "fix/current")
    #expect(ChangesRepositoryContext(session: session, changes: SessionChanges(
        base: "origin/main", files: [], diff: "")).branch == nil)
}

@Test @MainActor func detailedPullRequestLinksWrapAndKeepEveryLinkedPR() throws {
    let prs = (1...8).map { number in
        SessionPullRequest(number: number, url: "https://github.com/example/repo/pull/\(number)",
                           title: "Change", state: number == 1 ? .open : .merged, checkedAt: 1)
    }
    let session = SessionSummary(id: "multi", title: "Chat", cwd: "/repository",
                                 createdAt: 1, updatedAt: 1, state: "idle", pullRequest: prs[0], pullRequests: prs)
    let wide = ImageRenderer(content: PullRequestBadge(session: session, presentation: .details))
    let narrow = ImageRenderer(content: PullRequestBadge(session: session, presentation: .details))
    narrow.proposedSize = ProposedViewSize(width: 292, height: nil)
    let image = try #require(narrow.cgImage)
    #expect(image.width <= 292)
    #expect(image.height > (try #require(wide.cgImage)).height)
    #expect(try #require(wide.cgImage).width > 292)
}

@Test @MainActor func detailedPullRequestLinksRenderAllStatesAndLookupWarnings() throws {
    for state in PullRequestState.allCases {
        for url in ["https://github.com/example/repo/pull/79", "file:///invalid-link"] {
            let session = SessionSummary(
                id: "badge", title: "Chat", cwd: "/repository", createdAt: 1, updatedAt: 1, state: "idle",
                pullRequest: SessionPullRequest(number: 79, url: url, title: "Change", state: state, checkedAt: 1),
                pullRequestError: "Lookup failed")
            let renderer = ImageRenderer(content: PullRequestBadge(session: session, presentation: .details))
            renderer.proposedSize = ProposedViewSize(width: 292, height: nil)
            let image = try #require(renderer.cgImage)
            #expect(image.width > 0 && image.width <= 292)
            #expect(image.height > 0)
        }
    }
    let session = SessionSummary(id: "error", title: "Chat", cwd: "/repository",
                                 createdAt: 1, updatedAt: 1, state: "idle", pullRequestError: "Lookup failed")
    #expect(try #require(ImageRenderer(content: PullRequestBadge(session: session, presentation: .details)).cgImage).width > 50)
}

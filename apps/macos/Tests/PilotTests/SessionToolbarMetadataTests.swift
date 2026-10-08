import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func toolbarBranchAndPullRequestStayCompactAtNarrowWidths() throws {
    let session = SessionSummary(
        id: "toolbar", title: "Chat", cwd: "/repository",
        branch: "refactor/a-very-long-branch-name-that-must-not-grow-the-header",
        createdAt: 1, updatedAt: 1, state: "idle",
        pullRequest: SessionPullRequest(number: 12345, url: "https://github.com/example/repo/pull/12345",
                                       title: "Change", state: .merged, checkedAt: 1))
    for width in [140.0, 220.0, 360.0] {
        let renderer = ImageRenderer(content: SessionToolbarMetadata(session: session))
        renderer.proposedSize = ProposedViewSize(width: width, height: nil)
        let image = try #require(renderer.cgImage)
        #expect(Double(image.width) <= width + 1)
        #expect(image.height > 0 && image.height <= 22)
    }
}

@Test @MainActor func toolbarShowsEveryLinkedPullRequestOnOneLine() throws {
    let current = SessionPullRequest(number: 74, url: "https://github.com/example/repo/pull/74", title: "Second",
                                     state: .open, checkedAt: 1, branch: "fix/second")
    let earlier = SessionPullRequest(number: 61, url: "https://github.com/example/repo/pull/61", title: "First",
                                     state: .merged, checkedAt: 1, branch: "fix/first")
    let session = SessionSummary(id: "multi", title: "Chat", cwd: "/repository",
                                 branch: "fix/a-long-branch-name-that-must-truncate-before-badges-wrap",
                                 createdAt: 1, updatedAt: 1, state: "idle",
                                 pullRequest: current, pullRequests: [current, earlier])
    let single = ImageRenderer(content: PullRequestBadge(session: SessionSummary(
        id: "one", title: "Chat", cwd: "/repository", createdAt: 1, updatedAt: 1, state: "idle", pullRequest: current)))
    let both = ImageRenderer(content: PullRequestBadge(session: session))
    let singleWidth = try #require(single.cgImage).width
    #expect(try #require(both.cgImage).width > singleWidth, "both PR badges are shown")
    let renderer = ImageRenderer(content: SessionToolbarMetadata(session: session))
    renderer.proposedSize = ProposedViewSize(width: 260, height: nil)
    let image = try #require(renderer.cgImage)
    #expect(image.height > 0 && image.height <= 22)
}

@Test @MainActor func toolbarBranchWithoutPullRequestAlsoTruncates() throws {
    let session = SessionSummary(id: "branch", title: "Chat", cwd: "/repository",
                                 branch: String(repeating: "long-branch-", count: 20),
                                 createdAt: 1, updatedAt: 1, state: "idle")
    let renderer = ImageRenderer(content: SessionToolbarMetadata(session: session))
    renderer.proposedSize = ProposedViewSize(width: 120, height: nil)
    let image = try #require(renderer.cgImage)
    #expect(image.width <= 121)
    #expect(image.height > 0 && image.height <= 22)
}

@Test @MainActor func askToolbarShowsReadOnlySourceContext() throws {
    let session = SessionSummary(id: "ask", title: "Question", cwd: "/repository", branch: "main",
                                 createdAt: 1, updatedAt: 1, state: "idle", mode: .ask,
                                 sourceBranch: "read-only-source")
    let metadata = SessionToolbarMetadata(session: session)
    #expect(metadata.source == "origin/read-only-source")
    for width in [140.0, 220.0, 360.0] {
        let renderer = ImageRenderer(content: metadata)
        renderer.proposedSize = ProposedViewSize(width: width, height: nil)
        let image = try #require(renderer.cgImage)
        #expect(Double(image.width) <= width + 1)
        #expect(image.height > 0 && image.height <= 22)
    }
}

@Test @MainActor func toolbarShowsWorkspaceContextWithoutBranchOrPullRequest() throws {
    for mode in [ChatMode.build, .ask] {
        let session = SessionSummary(id: "context", title: "Chat", cwd: "/repository",
                                     createdAt: 1, updatedAt: 1, state: "idle", mode: mode)
        let metadata = SessionToolbarMetadata(session: session)
        #expect(metadata.source == (mode == .ask ? "Current checkout" : nil))
        let renderer = ImageRenderer(content: metadata)
        renderer.proposedSize = ProposedViewSize(width: 220, height: nil)
        let image = try #require(renderer.cgImage)
        #expect(image.width > 0 && image.width <= 221)
        #expect(image.height > 0 && image.height <= 22)
    }
}

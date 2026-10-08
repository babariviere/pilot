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

@Test @MainActor func askToolbarOmitsBuildRepositoryMetadata() {
    let session = SessionSummary(id: "ask", title: "Question", cwd: "/repository", branch: "main",
                                 createdAt: 1, updatedAt: 1, state: "idle", mode: .ask)
    let renderer = ImageRenderer(content: SessionToolbarMetadata(session: session))
    let image = renderer.cgImage
    #expect(image == nil || image?.width == 0 || image?.height == 0)
}

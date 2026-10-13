import AppKit
import PilotCore
import Testing
@testable import Pilot

@Test func everyLinkKindMapsToItsServiceMark() {
    let expected: [MissionResourceKind: BrandMark?] = [
        .githubPullRequest: .github, .githubIssue: .github,
        .linearProject: .linear, .linearIssue: .linear,
        .slackThread: .slack, .url: nil,
    ]
    for kind in [MissionResourceKind.githubPullRequest, .githubIssue, .linearProject, .linearIssue, .slackThread, .url] {
        #expect(BrandMark(kind) == expected[kind] ?? nil, "\(kind)")
    }
}

@Test @MainActor func brandMarksAreFilledTemplateImagesThatFillTheirBox() throws {
    for mark in BrandMark.allCases {
        let image = mark.image
        #expect(image.isTemplate)
        #expect(image.size == NSSize(width: 16, height: 16))
        #expect(mark.image === image, "marks are drawn once")
        var rect = NSRect(x: 0, y: 0, width: 64, height: 64)
        let bitmap = NSBitmapImageRep(cgImage: try #require(image.cgImage(forProposedRect: &rect, context: nil, hints: nil)))
        var opaque = 0
        var minX = Int.max, maxX = 0, minY = Int.max, maxY = 0
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide where (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.5 {
                opaque += 1
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        let area = bitmap.pixelsWide * bitmap.pixelsHigh
        // A mark, not a blank or a filled square: between a quarter and nine tenths of the box is ink.
        #expect(opaque > area / 4, "\(mark) is mostly empty")
        #expect(opaque < area * 9 / 10, "\(mark) is a solid block")
        // Scaled to the box: the ink spans nearly the full width and height.
        #expect(maxX - minX > bitmap.pixelsWide * 9 / 10, "\(mark) is too narrow")
        #expect(maxY - minY > bitmap.pixelsHigh * 9 / 10, "\(mark) is too short")
    }
}

@Test func linkAccessibilityNamesStateTheServiceAndReference() throws {
    func resource(_ kind: String, url: String, externalId: String? = nil, title: String? = nil) throws -> MissionResource {
        var fields: [String: Any] = ["id": "r", "url": url, "kind": kind, "createdAt": 1]
        if let externalId { fields["externalId"] = externalId }
        if let title { fields["title"] = title }
        return try JSONDecoder().decode(MissionResource.self, from: JSONSerialization.data(withJSONObject: fields))
    }
    let pr = try resource("github.pr", url: "https://github.com/o/r/pull/133", externalId: "o/r#133")
    #expect(pr.accessibilityName(pullRequest: nil) == "GitHub pull request #133")
    let state = SessionPullRequest(number: 133, url: pr.url, title: "Fix", state: .merged, checkedAt: 1)
    #expect(pr.accessibilityName(pullRequest: state) == "GitHub pull request #133, \(PullRequestState.merged.label)")
    #expect(try resource("github.issue", url: "https://github.com/o/r/issues/9", externalId: "o/r#9")
        .accessibilityName(pullRequest: nil) == "GitHub issue #9")
    #expect(try resource("linear.issue", url: "https://linear.app/a/issue/ENG-12", externalId: "ENG-12")
        .accessibilityName(pullRequest: nil) == "Linear issue ENG-12")
    #expect(try resource("linear.project", url: "https://linear.app/a/project/api", externalId: "api", title: "API v2")
        .accessibilityName(pullRequest: nil) == "Linear project API v2")
    #expect(try resource("slack.thread", url: "https://a.slack.com/archives/C1/p1", title: "#api")
        .accessibilityName(pullRequest: nil) == "Slack thread #api")
    #expect(try resource("url", url: "https://example.com/spec")
        .accessibilityName(pullRequest: nil) == "Link https://example.com/spec")
}

import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private func badgePR(_ state: PullRequestState = .open, readiness: PullRequestReadiness.State? = nil,
                     url: String = "https://github.com/example/repo/pull/260") -> SessionPullRequest {
    SessionPullRequest(number: 260, url: url, title: "Change", state: state, checkedAt: 1,
                       readiness: readiness.map { .init(state: $0, reasons: [], checkedAt: 1) })
}

@Test @MainActor func compactPullRequestLabelsStayShortInEveryState() {
    for state in PullRequestState.allCases {
        for readiness in [nil, .ready, .pending, .blocked] as [PullRequestReadiness.State?] {
            let pr = badgePR(state, readiness: readiness)
            let link = PullRequestLink(pullRequest: pr)
            #expect(link.label == "#260")
            #expect(link.isReady == (state == .open && readiness == .ready))
            #expect(PullRequestLink(pullRequest: pr, stale: true).label == "#260")
        }
    }
}

@Test @MainActor func detailedPullRequestLabelsKeepStateAndIgnoreTerminalReadiness() {
    #expect(PullRequestLink(pullRequest: badgePR(readiness: .ready), presentation: .details).label
        == "Ready to merge PR #260")
    for state in PullRequestState.allCases {
        let pr = badgePR(state, readiness: .ready)
        let link = PullRequestLink(pullRequest: pr, presentation: .details)
        if state != .open {
            #expect(!link.isReady)
            #expect(link.label == "\(state.compactLabel) PR #260")
        }
    }
}

@Test @MainActor func compactPullRequestLinksRenderWithinTheMetadataBudget() throws {
    for state in PullRequestState.allCases {
        for stale in [false, true] {
            for url in ["https://github.com/example/repo/pull/260", "file:///invalid-link"] {
                let renderer = ImageRenderer(content: PullRequestLink(
                    pullRequest: badgePR(state, readiness: .ready, url: url), stale: stale))
                let image = try #require(renderer.cgImage)
                #expect(image.width > 20 && image.width < 80)
                #expect(image.height > 0 && image.height < 25)
            }
        }
    }
}

@Test @MainActor func terminalPullRequestGlyphsAreCachedTemplateVectors() throws {
    for glyph in PullRequestGlyph.allCases {
        let image = glyph.image
        #expect(image.isTemplate)
        #expect(image.size == NSSize(width: 16, height: 16))
        #expect(glyph.image === image)
        let bounds = SVGPath.cgPath(glyph.svgPath).boundingBoxOfPath
        #expect(bounds.minX >= 0 && bounds.minY >= 0)
        #expect(bounds.maxX <= 16 && bounds.maxY <= 16)
        var rect = NSRect(x: 0, y: 0, width: 64, height: 64)
        let bitmap = NSBitmapImageRep(cgImage: try #require(image.cgImage(forProposedRect: &rect, context: nil, hints: nil)))
        var ink = 0
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide where (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.5 {
                ink += 1
            }
        }
        let area = bitmap.pixelsWide * bitmap.pixelsHigh
        #expect(ink > area / 10 && ink < area / 2, "\(glyph) is neither blank nor a filled square")
    }
    #expect(PullRequestGlyph.merged.image.tiffRepresentation != PullRequestGlyph.closed.image.tiffRepresentation)
    #expect(Bundle.module.url(forResource: "Octicons-LICENSE", withExtension: "txt") != nil)
}

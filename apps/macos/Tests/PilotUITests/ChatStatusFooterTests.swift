import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@MainActor
private func reviewMarker(in view: NSView) -> ChatReviewVisibility.ReviewView? {
    if let marker = view as? ChatReviewVisibility.ReviewView { return marker }
    return view.subviews.compactMap { reviewMarker(in: $0) }.first
}

@Test @MainActor func settledChatOutcomesDoNotAddAVisibleFooter() throws {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    var baseline: NSRect?
    let outcomes: [SessionOutcome?] = [nil, .done, .needsInput, .failed, .stopped]
    for outcome in outcomes {
        let session = SessionSummary(id: "footer-test", title: "Test", cwd: "/tmp",
                                     createdAt: 0, updatedAt: 0, state: "idle", outcome: outcome,
                                     outcomeReason: outcome == nil ? nil : String(repeating: "Outcome reason. ", count: 30))
        let feed = SessionFeed(sessionId: session.id, transcript: Transcript())
        let hosting = NSHostingView(rootView: ChatView(session: session, feed: feed)
            .environmentObject(AppModel.shared))
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        hosting.layoutSubtreeIfNeeded()
        let marker = try #require(reviewMarker(in: hosting))
        #expect(abs(marker.bounds.height - 1) < 0.01)
        let frame = marker.convert(marker.bounds, to: hosting)
        if let baseline {
            #expect(frame == baseline)
        } else {
            baseline = frame
        }
    }
}

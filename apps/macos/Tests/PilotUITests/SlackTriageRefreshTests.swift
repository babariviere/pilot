import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func slackTriageRefreshIsClickableAndDisablesDuringLocalAndAutomaticSync() async throws {
    _ = NSApplication.shared
    let ready = TrackingSource(id: "slack-p", projectId: "p", kind: .slack, label: "Slack",
                               configured: true, status: .ok)
    let automatic = TrackingSource(id: "slack-p", projectId: "p", kind: .slack, label: "Slack",
                                   configured: true, status: .syncing)
    let unconfigured = TrackingSource(id: "slack-p", projectId: "p", kind: .slack, label: "Slack",
                                      configured: false, status: .idle)
    // Ready, locally requested sync, daemon-driven sync, offline, missing/unconfigured source, then ready again.
    let states: [(TrackingSource?, Bool, Bool, Bool)] = [
        (ready, true, false, true), (ready, true, true, false), (automatic, true, false, false),
        (ready, false, false, false), (nil, true, false, false), (unconfigured, true, false, false),
        (ready, true, false, true),
    ]
    for (source, connected, syncing, enabled) in states {
        var refreshes = 0
        let host = NSHostingView(rootView: SlackTriageRefreshButton(source: source, connected: connected,
                                                                   syncing: syncing) { refreshes += 1 }
            .frame(width: 120, height: 60))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 120, height: 60),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = host
        window.orderFrontRegardless()
        host.layoutSubtreeIfNeeded()
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while refreshButtons(host).isEmpty, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        let buttons = refreshButtons(host)
        #expect(buttons.count == 1, "Refresh is a direct button, not a menu action")
        let button = try #require(buttons.first)
        #expect(button.isEnabled == enabled)
        button.performClick(nil)
        #expect(refreshes == (enabled ? 1 : 0))
    }
}

@MainActor private func refreshButtons(_ view: NSView) -> [NSButton] {
    (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(refreshButtons)
}

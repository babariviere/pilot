import AppKit
import Foundation
import NativeTestSupport
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@MainActor private func permissionAnchors(_ view: NSView) -> [PermissionUpgradeActionAnchorView] {
    (view as? PermissionUpgradeActionAnchorView).map { [$0] } ?? view.subviews.flatMap(permissionAnchors)
}

@Test @MainActor func permissionUpgradePromptRequiresNativeAllowOrDeny() async throws {
    NSApplication.shared.setActivationPolicy(.regular)
    for allow in [false, true] {
        var decisions: [(String, Bool)] = []
        let request = PermissionUpgradeRequest(id: "approval-1", chatId: "target", chatTitle: "Fix request recovery",
            scope: "Push this verified change and open one pull request.", requestedBy: "control",
            createdAt: 1, expiresAt: 9_999_999_999_999)
        let view = PermissionUpgradePrompt(request: request) { id, decision in decisions.append((id, decision)) }
        let hosting = NSHostingView(rootView: view.frame(width: 500).padding(20))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 340),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.update()
        hosting.layoutSubtreeIfNeeded()
        defer { window.close() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))

        while permissionAnchors(hosting).count < 2, ContinuousClock.now < deadline {
            hosting.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
        }
        let control = try #require(permissionAnchors(hosting).first { $0.allow == allow })
        #expect(decisions.isEmpty, "showing the prompt does not approve anything")
        // Sending mouse-down then mouse-up synchronously left NSButtonCell tracking waiting forever for a
        // mouse-up that was not queued yet. NativeInput queues the release before the press.
        try await NativeInput.click(control)
        while decisions.isEmpty, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        #expect(decisions.count == 1)
        #expect(decisions.first?.0 == request.id)
        #expect(decisions.first?.1 == allow)
    }
}

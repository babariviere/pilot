import AppKit
@testable import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test(.timeLimit(.minutes(1))) @MainActor
func swiftUIExpandedArtifactCloseAndEscapeLeaveTheChatUsable() async throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let hosts = ClientDirectory(operationDirectory: directory)
    let owner = HostRef(hostId: "offline-fixture", daemonId: "artifact-daemon", lineageId: "artifact-lineage")
    let reference = ArtifactReference(id: "artifact", sessionId: "fixture", title: "Offline artifact", revision: 1)
    let html = "<p>Saved offline artifact</p>"
    let revision = ArtifactRevision(id: reference.id, sessionId: reference.sessionId, projectId: nil,
        title: reference.title, kind: .html, revision: 1, createdAt: 0, updatedAt: 0,
        source: html, html: html, libraries: [])
    ArtifactInlineCache.store(revision, for: reference, host: owner)
    let root = ArtifactCard(reference: reference, host: owner)
        .frame(width: 760, height: 500)
        .environment(\.hostViewContext, HostViewContext(host: owner, hosts: hosts))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700),
        styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: root)
    window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
    window.orderFrontRegardless()
    do {
        // Mount the restored SwiftUI card and its sheet, with a disconnected
        // owner so this regression cannot contact a daemon, account or artifact library.
        try await settleArtifactSheet(window, phase: "mount card") {
            artifactSheetButton(in: window, title: "Open \(reference.title) in the viewer") != nil
        }
        for (cycle, useEscape) in [false, true, false].enumerated() {
            let phase = "cycle \(cycle + 1) (\(useEscape ? "Escape" : "Close"))"
            let expand = try #require(artifactSheetButton(in: window, title: "Open \(reference.title) in the viewer"))
            let opened = expand.accessibilityPerformPress()
            try #require(opened, "\(phase): activate the production expand button")
            try await settleArtifactSheet(window, phase: "\(phase): attach viewer") { window.attachedSheet?.contentView != nil }
            let sheet = try #require(window.attachedSheet)
            // Wait for SwiftUI's accessibility/shortcut registration, not just its window.
            try await settleArtifactSheet(window, phase: "\(phase): register Close") {
                artifactSheetButton(in: sheet, title: "Close artifact") != nil
            }
            if useEscape {
                let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: sheet.windowNumber, context: nil,
                    characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53))
                // NSApplication tries key equivalents before delivering keyDown to a
                // window's first responder. Sending directly to the offscreen window
                // skips the viewer's SwiftUI .keyboardShortcut(.cancelAction).
                let handled = sheet.performKeyEquivalent(with: event)
                try #require(handled, "\(phase): the production Escape shortcut must handle the key equivalent")
            } else {
                let close = try #require(artifactSheetButton(in: sheet, title: "Close artifact"))
                let pressed = close.accessibilityPerformPress()
                try #require(pressed, "\(phase): activate the production Close button")
            }
            try await settleArtifactSheet(window, phase: "\(phase): dismiss viewer") { window.attachedSheet == nil }
            #expect(window.isVisible, "dismiss only the viewer, not its presenting chat")
        }
    } catch {
        await closeArtifactFixture(window, hosts: hosts, directory: directory)
        throw error
    }
    await closeArtifactFixture(window, hosts: hosts, directory: directory)
}

@MainActor private func artifactSheetButton(in element: Any, title: String, depth: Int = 0) -> NSAccessibilityProtocol? {
    guard depth < 40, let accessible = element as? NSAccessibilityProtocol else { return nil }
    if accessible.accessibilityRole() == .button,
       [accessible.accessibilityTitle(), accessible.accessibilityLabel()].contains(title) { return accessible }
    for child in accessible.accessibilityChildren() ?? [] {
        if let match = artifactSheetButton(in: child, title: title, depth: depth + 1) { return match }
    }
    return nil
}

@MainActor private func settleArtifactSheet(_ window: NSWindow, phase: String,
                                          sourceLocation: SourceLocation = #_sourceLocation,
                                          until ready: () -> Bool) async throws {
    for pass in 0..<150 {
        window.contentView?.layoutSubtreeIfNeeded()
        window.attachedSheet?.contentView?.layoutSubtreeIfNeeded()
        // The fixture is deliberately offscreen. Layout/update alone need not draw
        // its hosting views or publish SwiftUI's accessibility/shortcut regions.
        window.displayIfNeeded()
        window.attachedSheet?.displayIfNeeded()
        window.update()
        try await Task.sleep(for: .milliseconds(20))
        if pass >= 11, ready() { return }
    }
    try #require(ready(), "\(phase): the expanded artifact must open/close without trapping the chat; \(artifactSheetDiagnostics(window))",
                 sourceLocation: sourceLocation)
}

@MainActor private func artifactSheetDiagnostics(_ window: NSWindow) -> String {
    func state(_ window: NSWindow) -> String {
        // Only structural state/roles, never artifact HTML, accessibility values or titles.
        let roles = (window.accessibilityChildren() ?? []).prefix(12).compactMap { child in
            (child as? NSAccessibilityProtocol)?.accessibilityRole()?.rawValue
        }.joined(separator: ",")
        return "visible=\(window.isVisible), key=\(window.isKeyWindow), content=\(window.contentView != nil), bounds=\(String(describing: window.contentView?.bounds)), AX=[\(roles)]"
    }
    return "chat{\(state(window))}; sheet{\(window.attachedSheet.map(state) ?? "none")}"
}

@MainActor private func closeArtifactFixture(_ window: NSWindow, hosts: ClientDirectory, directory: URL) async {
    if let sheet = window.attachedSheet { window.endSheet(sheet) }
    window.contentView = nil
    window.close()
    await hosts.disconnectAll()
    try? FileManager.default.removeItem(at: directory)
}

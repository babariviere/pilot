import AppKit
import NativeTestSupport
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
        try await settleArtifactSheet(window, step: "mount the inline expand control") {
            guard let content = window.contentView else { return false }
            return artifactSheetControl(in: content, id: "artifact-expand")?.controlEnabled == true
        }
        for useEscape in [false, true, false] {
            let content = try #require(window.contentView)
            let expand = try #require(artifactSheetControl(in: content, id: "artifact-expand"))
            try await NativeInput.click(expand)
            try await settleArtifactSheet(window, step: "attach the expanded artifact sheet") {
                window.attachedSheet?.contentView != nil
            }
            let sheet = try #require(window.attachedSheet)
            let sheetContent = try #require(sheet.contentView)
            try await settleArtifactSheet(window, step: "mount the sheet's Close control") {
                artifactSheetControl(in: sheetContent, id: "artifact-close")?.controlEnabled == true
            }
            if useEscape {
                let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: sheet.windowNumber, context: nil,
                    characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53))
                // Exercise the sheet's registered production shortcut directly, without relying on
                // the headless runner to grant a key window or route an application event.
                try #require(sheet.performKeyEquivalent(with: event), "the sheet must handle its Escape shortcut")
            } else {
                let close = try #require(artifactSheetControl(in: sheetContent, id: "artifact-close"))
                try await NativeInput.click(close)
            }
            try await settleArtifactSheet(window, step: useEscape ? "dismiss with Escape" : "dismiss with Close") {
                window.attachedSheet == nil
            }
            #expect(window.isVisible, "dismiss only the viewer, not its presenting chat")
        }
    } catch {
        await closeArtifactFixture(window, hosts: hosts, directory: directory)
        throw error
    }
    await closeArtifactFixture(window, hosts: hosts, directory: directory)
}

@MainActor private func artifactSheetControl(in view: NSView, id: String) -> ControlGeometryView? {
    NativeInput.views(in: view, of: ControlGeometryView.self).first { $0.identifier?.rawValue == id }
}

@MainActor private func settleArtifactSheet(_ window: NSWindow, step: String,
                                          sourceLocation: SourceLocation = #_sourceLocation,
                                          until ready: () -> Bool) async throws {
    for pass in 0..<150 {
        window.contentView?.layoutSubtreeIfNeeded()
        window.attachedSheet?.contentView?.layoutSubtreeIfNeeded()
        window.update()
        try await Task.sleep(for: .milliseconds(20))
        if pass >= 11, ready() { return }
    }
    try #require(ready(), Comment(rawValue: "Timed out waiting to \(step); attached sheet: \(window.attachedSheet != nil)"),
                 sourceLocation: sourceLocation)
}

@MainActor private func closeArtifactFixture(_ window: NSWindow, hosts: ClientDirectory, directory: URL) async {
    if let sheet = window.attachedSheet { window.endSheet(sheet) }
    window.contentView = nil
    window.close()
    await hosts.disconnectAll()
    try? FileManager.default.removeItem(at: directory)
}

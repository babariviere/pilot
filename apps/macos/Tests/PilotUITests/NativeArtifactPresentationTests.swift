import AppKit
import NativeTestSupport
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test(.timeLimit(.minutes(1))) @MainActor
func nativeExpandedArtifactCloseAndEscapeLeaveTheChatUsable() async throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let hosts = ClientDirectory(operationDirectory: directory)
    let owner = HostRef(hostId: "offline-fixture", daemonId: "artifact-daemon", lineageId: "artifact-lineage")
    let reference = ArtifactReference(id: "artifact", sessionId: "fixture", title: "Offline artifact", revision: 1)
    var presentation = TranscriptPresentation()
    presentation.rows = [.artifact(id: "artifact-row", reference: reference)]
    let model = TranscriptRowsModel(presentation)
    let root = NativeTranscriptSection(model: model,
        resource: NativeTranscriptResource(sessionID: reference.sessionId, host: owner),
        scroll: TranscriptScrollState(), toolExpansions: TranscriptExpansions(),
        messageExpansions: TranscriptExpansions(), header: NativeTranscriptHeader(), footer: NativeTranscriptFooter(),
        chromeRevision: UUID(), loadEarlier: {})
        .environment(\.hostViewContext, HostViewContext(host: owner, hosts: hosts))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700),
        styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: root)
    window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
    window.orderFrontRegardless()
    do {
        // Mount the actual AppKit row and the actual SwiftUI sheet, with a disconnected
        // owner so this regression cannot contact a daemon, account or artifact library.
        try await settleArtifactSheet(window) {
            guard let content = window.contentView else { return false }
            return !NativeInput.views(in: content, of: NativeArtifactRow.self).isEmpty
        }
        for useEscape in [false, true, false] {
            let content = try #require(window.contentView)
            let row = try #require(NativeInput.views(in: content, of: NativeArtifactRow.self).first)
            let opened = row.activate()
            #expect(opened)
            try await settleArtifactSheet(window) { window.attachedSheet?.contentView != nil }
            let sheet = try #require(window.attachedSheet)
            let sheetContent = try #require(sheet.contentView)
            // Wait for SwiftUI's accessibility/shortcut registration, not just its window.
            try await settleArtifactSheet(window) {
                artifactSheetButton(in: sheetContent, title: "Close artifact") != nil
            }
            if useEscape {
                let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: sheet.windowNumber, context: nil,
                    characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53))
                sheet.sendEvent(event)
            } else {
                let close = try #require(artifactSheetButton(in: sheetContent, title: "Close artifact"))
                let pressed = close.accessibilityPerformPress()
                #expect(pressed)
            }
            try await settleArtifactSheet(window) { window.attachedSheet == nil }
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

@MainActor private func settleArtifactSheet(_ window: NSWindow, until ready: () -> Bool) async throws {
    for pass in 0..<150 {
        window.contentView?.layoutSubtreeIfNeeded()
        window.attachedSheet?.contentView?.layoutSubtreeIfNeeded()
        window.update()
        try await Task.sleep(for: .milliseconds(20))
        if pass >= 11, ready() { return }
    }
    try #require(ready(), "the expanded artifact must open/close without trapping the chat")
}

@MainActor private func closeArtifactFixture(_ window: NSWindow, hosts: ClientDirectory, directory: URL) async {
    if let sheet = window.attachedSheet { window.endSheet(sheet) }
    window.contentView = nil
    window.close()
    await hosts.disconnectAll()
    try? FileManager.default.removeItem(at: directory)
}

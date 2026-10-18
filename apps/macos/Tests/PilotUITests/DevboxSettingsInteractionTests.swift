import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

/// Mount the live Settings destination, not the screenshot fragment or a setup model.
@Test(.timeLimit(.minutes(1))) @MainActor
func addDevboxPresentsSetupSheetAfterCancelAndReopen() async throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
    try await hosts.restoreOffline(from: OfflineHostStore(directory: directory.appendingPathComponent("hosts")))
    var packageLoads = 0
    let hosting = NSHostingView(rootView: DevboxSettings(hosts: hosts, loadPackage: {
        packageLoads += 1
        Issue.record("Opening or cancelling setup must not load a runtime or start SSH")
        throw CancellationError()
    }))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 700),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    defer {
        if let sheet = window.attachedSheet { window.endSheet(sheet) }
        window.close()
    }
    hosting.layoutSubtreeIfNeeded()
    try await devboxSettingsWait("Add devbox button did not mount", in: hosting) {
        devboxSettingsControls(in: hosting, of: NSButton.self).count == 1
    }

    for _ in 0..<2 {
        #expect(window.attachedSheet == nil)
        // With no saved hosts, Add devbox is the destination's only button. SwiftUI's
        // hosted labels are not exposed as NSButton titles in this in-process runner.
        let addButtons = devboxSettingsControls(in: hosting, of: NSButton.self)
        try #require(addButtons.count == 1)
        let add = try #require(addButtons.first)
        try devboxSettingsClick(add)
        try await devboxSettingsWait("Add devbox did not present its setup sheet", in: hosting) {
            window.attachedSheet != nil
        }
        let sheet = try #require(window.attachedSheet)
        let content = try #require(sheet.contentView)
        try await devboxSettingsWait("The live setup form did not mount", in: content) {
            devboxSettingsControls(in: content, of: NSTextField.self).contains { $0.isEditable }
                && devboxSettingsControls(in: content, of: NSButton.self).count >= 2
        }
        let fields = devboxSettingsControls(in: content, of: NSTextField.self).filter(\.isEditable)
        try #require(fields.count == 1)
        #expect(fields.first?.stringValue == "")
        let (cancel, setup) = try devboxSettingsFooter(in: content)
        #expect(!setup.isEnabled, "Opening setup must not grant installation permission")
        #expect(packageLoads == 0)
        try devboxSettingsClick(cancel)
        try await devboxSettingsWait("Cancel did not dismiss the setup sheet", in: content) {
            window.attachedSheet == nil
        }
    }
    #expect(packageLoads == 0)
    #expect(hosts.offlineHosts.isEmpty)
    #expect(hosts.available.isEmpty)
}

@Test(.timeLimit(.minutes(1))) @MainActor
func githubKeySheetRequiresNativeConfirmationAndCancelDoesNotRegister() async throws {
    _ = NSApplication.shared
    let value = try JSONDecoder().decode(GitHubSetupStatus.self, from: Data("""
    {"phase":"key_ready","account":"octocat","apiReady":true,"sshReady":false,"publicKey":"ssh-ed25519 fixture","fingerprint":"SHA256:fixture"}
    """.utf8))
    var approvals = 0, cancellations = 0
    let hosting = NSHostingView(rootView: GitHubKeyApprovalSheet(value: value, revoking: false,
        cancel: { cancellations += 1 }, approve: { approvals += 1 }))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 340),
        styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = hosting
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000)); window.orderFrontRegardless()
    defer { window.close() }
    try await devboxSettingsWait("GitHub key confirmation did not mount", in: hosting) {
        devboxSettingsControls(in: hosting, of: NSButton.self).count == 2
    }
    #expect(approvals == 0)
    let (cancel, approve) = try devboxSettingsFooter(in: hosting)
    try devboxSettingsClick(cancel)
    #expect(cancellations == 1 && approvals == 0)
    try devboxSettingsClick(approve)
    #expect(approvals == 1)
}

@Test(.timeLimit(.minutes(1))) @MainActor
func githubExistingCheckoutRequiresExplicitNativeReuseConfirmation() async throws {
    _ = NSApplication.shared
    let value = try JSONDecoder().decode(GitHubImportOperation.self, from: Data("""
    {"id":"fixture","url":"https://github.com/owner/repo","destination":"/remote/src/github.com/owner/repo","phase":"confirm_existing"}
    """.utf8))
    var confirmations = 0, cancellations = 0
    let hosting = NSHostingView(rootView: GitHubReuseSheet(value: value, cancel: { cancellations += 1 }, confirm: { confirmations += 1 }))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 340),
        styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = hosting
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000)); window.orderFrontRegardless()
    defer { window.close() }
    try await devboxSettingsWait("Existing checkout confirmation did not mount", in: hosting) {
        devboxSettingsControls(in: hosting, of: NSButton.self).count == 2
    }
    #expect(confirmations == 0)
    let (cancel, confirm) = try devboxSettingsFooter(in: hosting)
    try devboxSettingsClick(cancel)
    #expect(cancellations == 1 && confirmations == 0)
    try devboxSettingsClick(confirm)
    #expect(confirmations == 1)
}

@Test(.timeLimit(.minutes(1))) @MainActor
func githubImportNativeCloneActionStaysDisabledUntilHostDestinationPreview() async throws {
    _ = NSApplication.shared
    let host = HostRef(hostId: "fixture-box", daemonId: "d", lineageId: "l")
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let hosts = HostClients(operationDirectory: directory)
    let preview = try JSONDecoder().decode(GitHubImportPreview.self, from: Data("""
    {"destination":"~/src/github.com/owner/repo","resolvedDestination":"/remote/src/github.com/owner/repo"}
    """.utf8))
    var starts = 0
    let actions = GitHubImportActions(available: { $0 == host }, repositories: { _ in
        try JSONDecoder().decode(GitHubRepositoryChoices.self, from: Data("{\"repositories\":[],\"truncated\":false}".utf8))
    }, operations: { _ in [] }, preview: { target, _, _ in #expect(target == host); return preview },
        start: { target, request in
            #expect(target == host && request.destination == preview.resolvedDestination)
            starts += 1
            return try JSONDecoder().decode(GitHubImportOperation.self, from: Data("""
            {"id":"\(request.id)","url":"\(request.url)","destination":"\(request.destination)","phase":"done","projectId":"project"}
            """.utf8))
        }, act: { _, _, _ in throw CancellationError() }, project: { _, _ in throw CancellationError() })
    let model = GitHubImportModel(host: host, actions: actions, initialURL: "https://github.com/owner/repo")
    let hosting = NSHostingView(rootView: GitHubImportContent(host: host, hosts: hosts, initialURL: model.url, model: model) { _ in })
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 900),
        styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = hosting
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000)); window.orderFrontRegardless()
    defer { window.close() }
    try await devboxSettingsWait("GitHub import form did not mount", in: hosting) {
        !model.busy && devboxSettingsControls(in: hosting, of: NSTextField.self).filter(\.isEditable).count >= 3
    }
    let (_, initialClone) = try devboxSettingsFooter(in: hosting)
    #expect(!initialClone.isEnabled && starts == 0)
    await model.checkDestination()
    try await devboxSettingsWait("Clone did not enable after the selected host's preview", in: hosting) {
        devboxSettingsControls(in: hosting, of: NSButton.self).contains { $0.isEnabled && $0 === initialClone }
    }
    let (_, clone) = try devboxSettingsFooter(in: hosting)
    try devboxSettingsClick(clone)
    try await devboxSettingsWait("Native clone action did not reach the host-bound model", in: hosting) { starts == 1 }
    #expect(starts == 1)
}

@MainActor private func devboxSettingsWait(_ message: String, in content: NSView,
                                          until ready: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(10)
    while !ready(), Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
    if !ready() { print(devboxSettingsViewTree(content)) }
    try #require(ready(), Comment(rawValue: message))
}

@MainActor private func devboxSettingsControls<V: NSView>(in view: NSView, of type: V.Type) -> [V] {
    (view as? V).map { [$0] } ?? view.subviews.flatMap { devboxSettingsControls(in: $0, of: type) }
}

/// SheetScaffold's bottom row contains Cancel followed by the primary action.
/// Locate that mounted row, not a guessed fixed coordinate or a replacement action.
@MainActor private func devboxSettingsFooter(in content: NSView) throws -> (NSButton, NSButton) {
    let buttons = devboxSettingsControls(in: content, of: NSButton.self)
    let bottom = try #require(buttons.map { $0.convert($0.bounds, to: nil).midY }.min())
    let footer = buttons.filter { abs($0.convert($0.bounds, to: nil).midY - bottom) < 3 }
        .sorted { $0.convert($0.bounds, to: nil).midX < $1.convert($1.bounds, to: nil).midX }
    try #require(footer.count == 2, "Expected Cancel and Set up devbox in the real sheet footer")
    return (footer[0], footer[1])
}

@MainActor private func devboxSettingsViewTree(_ view: NSView, depth: Int = 0) -> String {
    let title = (view as? NSButton)?.title ?? (view as? NSTextField)?.placeholderString ?? ""
    return String(repeating: " ", count: depth) + "\(type(of: view)) \(view.frame) \(title)\n"
        + view.subviews.map { devboxSettingsViewTree($0, depth: depth + 1) }.joined()
}

/// Find the mounted AppKit control, then send native mouse events to its window.
@MainActor private func devboxSettingsClick(_ button: NSButton) throws {
    let window = try #require(button.window)
    try #require(button.isEnabled)
    try #require(!button.bounds.isEmpty)
    let location = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil)
    let event = { (type: NSEvent.EventType) in
        try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
            eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
    }
    // Native buttons can track mouseDown until they dequeue the matching mouseUp.
    NSApp.postEvent(try event(.leftMouseUp), atStart: false)
    window.sendEvent(try event(.leftMouseDown))
    if let up = NSApp.nextEvent(matching: .leftMouseUp, until: Date(), inMode: .default, dequeue: true) {
        window.sendEvent(up)
    }
}

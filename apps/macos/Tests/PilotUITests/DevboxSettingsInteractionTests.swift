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

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
        devboxSettingsButton("Add devbox…", in: hosting) != nil
    }

    for _ in 0..<2 {
        #expect(window.attachedSheet == nil)
        try devboxSettingsClick("Add devbox…", in: window)
        try await devboxSettingsWait("Add devbox did not present its setup sheet", in: hosting) {
            window.attachedSheet != nil
        }
        let sheet = try #require(window.attachedSheet)
        let content = try #require(sheet.contentView)
        try await devboxSettingsWait("The live setup form did not mount", in: content) {
            devboxSettingsControl(in: content, matching: { (field: NSTextField) in
                field.isEditable && field.placeholderString == "Existing SSH alias"
            }) != nil && devboxSettingsButton("Cancel", in: content) != nil
        }
        let setup = try #require(devboxSettingsButton("Set up devbox", in: content))
        #expect(!setup.isEnabled, "Opening setup must not grant installation permission")
        #expect(packageLoads == 0)
        try devboxSettingsClick("Cancel", in: sheet)
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

@MainActor private func devboxSettingsControl<V: NSView>(in view: NSView, matching: (V) -> Bool) -> V? {
    if let control = view as? V, matching(control) { return control }
    for child in view.subviews {
        if let found = devboxSettingsControl(in: child, matching: matching) { return found }
    }
    return nil
}

@MainActor private func devboxSettingsButton(_ title: String, in content: NSView) -> NSButton? {
    devboxSettingsControl(in: content) { (button: NSButton) in
        [button.title, button.accessibilityLabel(), button.accessibilityTitle()].contains(title)
    }
}

@MainActor private func devboxSettingsViewTree(_ view: NSView, depth: Int = 0) -> String {
    let title = (view as? NSButton).map {
        "title=\($0.title), label=\($0.accessibilityLabel() ?? "nil"), axTitle=\($0.accessibilityTitle() ?? "nil"), id=\($0.accessibilityIdentifier() ?? "nil"), key=\($0.keyEquivalent.debugDescription)"
    } ?? (view as? NSTextField)?.placeholderString ?? ""
    return String(repeating: " ", count: depth) + "\(type(of: view)) \(view.frame) \(title)\n"
        + view.subviews.map { devboxSettingsViewTree($0, depth: depth + 1) }.joined()
}

/// Find the mounted AppKit control, then send native mouse events to its window.
@MainActor private func devboxSettingsClick(_ title: String, in window: NSWindow) throws {
    let content = try #require(window.contentView)
    let button = try #require(devboxSettingsButton(title, in: content), "Missing button \(title)")
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

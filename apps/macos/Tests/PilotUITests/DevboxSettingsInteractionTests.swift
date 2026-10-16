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
    try await devboxSettingsWait("Add devbox button did not mount") {
        devboxSettingsElement(in: hosting, role: .button, title: "Add devbox…") != nil
    }

    for _ in 0..<2 {
        #expect(window.attachedSheet == nil)
        try devboxSettingsClick("Add devbox…", in: window)
        try await devboxSettingsWait("Add devbox did not present its setup sheet") {
            window.attachedSheet != nil
        }
        let sheet = try #require(window.attachedSheet)
        let content = try #require(sheet.contentView)
        try await devboxSettingsWait("The live setup form did not mount") {
            devboxSettingsElement(in: content, role: .textField, title: "Existing SSH alias") != nil
                && devboxSettingsElement(in: content, role: .button, title: "Cancel") != nil
        }
        let setup = try #require(devboxSettingsElement(in: content, role: .button, title: "Set up devbox"))
        #expect(!setup.isAccessibilityEnabled(), "Opening setup must not grant installation permission")
        #expect(packageLoads == 0)
        try devboxSettingsClick("Cancel", in: sheet)
        try await devboxSettingsWait("Cancel did not dismiss the setup sheet") {
            window.attachedSheet == nil
        }
    }
    #expect(packageLoads == 0)
    #expect(hosts.offlineHosts.isEmpty)
    #expect(hosts.available.isEmpty)
}

@MainActor private func devboxSettingsWait(_ message: String, until ready: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(10)
    while !ready(), Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
    try #require(ready(), Comment(rawValue: message))
}

@MainActor private func devboxSettingsElement(in element: Any, role: NSAccessibility.Role,
                                             title: String, depth: Int = 0) -> NSAccessibilityProtocol? {
    guard depth < 40, let accessible = element as? NSAccessibilityProtocol else { return nil }
    if accessible.accessibilityRole() == role,
       [accessible.accessibilityTitle(), accessible.accessibilityLabel()].contains(title) { return accessible }
    for child in accessible.accessibilityChildren() ?? [] {
        if let found = devboxSettingsElement(in: child, role: role, title: title, depth: depth + 1) { return found }
    }
    return nil
}

/// Locate the real control through accessibility, then send native mouse events to its window.
@MainActor private func devboxSettingsClick(_ title: String, in window: NSWindow) throws {
    let content = try #require(window.contentView)
    let button = try #require(devboxSettingsElement(in: content, role: .button, title: title), "Missing button \(title)")
    try #require(button.isAccessibilityEnabled())
    let frame = button.accessibilityFrame()
    try #require(!frame.isEmpty)
    let location = window.convertPoint(fromScreen: NSPoint(x: frame.midX, y: frame.midY))
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

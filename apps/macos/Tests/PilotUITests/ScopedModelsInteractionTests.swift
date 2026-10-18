import AppKit
import Foundation
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

/// Mount the exact production Save button, not a fake action or hidden accessibility lookup.
@Test(.timeLimit(.minutes(1))) @MainActor
func scopedModelsNativeSavePersistsAndDispatchesExplicitAllOnlyAfterClick() async throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let host = HostRef(hostId: "local", daemonId: "native-fixture", lineageId: "native-history")
    let store = ScopedModelsStore(directory: directory), sync = ScopedModelsSync(store: store)
    defer { sync.stop() }
    let token = HostConnectionToken(host: host)
    var patterns: [String]? = []
    var hash = "observed-empty-array"
    var writes: [ScopedModelsSelection] = []
    var release: CheckedContinuation<Void, Never>?
    sync.update([host: .init(token: token, read: {
        ScopedModelsObservation(baseline: .init(patterns: patterns, hash: hash))
    }, write: { selection, expected in
        let saved = try await store.load()
        #expect(saved.desired == .all && saved.revision == 1)
        #expect(saved.entry(host)?.attempt?.expectedHash == expected)
        writes.append(selection)
        await withCheckedContinuation { release = $0 }
        patterns = selection.patterns; hash = "readback-null"
    }, isCurrent: { true })])
    await sync.start()
    try await nativeScopeWait { sync.observations[host] != nil && sync.checking.isEmpty }
    let editor = ScopedModelsEditor()
    editor.initialize(.all)
    let hosting = NSHostingView(rootView: ScopedModelsSaveButton(sync: sync, editor: editor, localHost: host).padding(12))
    let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 200, height: 80),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = hosting
    window.orderFrontRegardless(); hosting.layoutSubtreeIfNeeded()
    defer { release?.resume(); window.close() }
    try await nativeScopeWait { nativeScopeButtons(hosting).count == 1 }
    let button = try #require(nativeScopeButtons(hosting).first)
    #expect(button.isEnabled)
    #expect(writes.isEmpty, "Opening Settings must not send a PUT")
    button.performClick(nil)
    try await nativeScopeWait { release != nil }
    #expect(writes.count == 1 && writes.first?.patterns == nil)
    let continuation = try #require(release)
    release = nil; continuation.resume()
    try await nativeScopeWait { sync.state.entry(host)?.status == .synced }
    #expect(sync.state.entry(host)?.appliedRevision == 1)
}

@MainActor private func nativeScopeWait(_ checkpoint: String = "Scoped models fixture did not settle",
                                       _ predicate: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(10)
    while !predicate(), Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
    try #require(predicate(), Comment(rawValue: checkpoint))
}

@MainActor private func nativeScopeButtons(_ view: NSView) -> [NSButton] {
    (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(nativeScopeButtons)
}

@Test(.timeLimit(.minutes(1))) @MainActor
func scopedModelsNativeSelectorPreservesAdvancedPatterns() async throws {
    _ = NSApplication.shared
    let editor = ScopedModelsEditor()
    editor.initialize(.init(patterns: ["unavailable/*:high", "unavailable/*:high"]))
    let candidate = ScopedModelsObservation.Candidate(id: "provider/model", provider: "provider", name: "Model")
    let hosting = NSHostingView(rootView: ScopedModelsCandidateRow(candidate: candidate, editor: editor).padding(12))
    let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 500, height: 120),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = hosting
    window.orderFrontRegardless(); hosting.layoutSubtreeIfNeeded(); window.update()
    defer { window.close() }
    do {
        try await nativeScopeWait("The native model checkbox did not mount") { nativeScopeButtons(hosting).count == 1 }
    } catch {
        print(nativeScopeViewTree(hosting))
        throw error
    }
    let checkbox = try #require(nativeScopeButtons(hosting).first)
    try nativeScopeClickCheckbox(checkbox)
    try await nativeScopeWait("A native checkbox click did not select the model") { editor.patterns.contains(candidate.id) }
    #expect(editor.patterns == ["unavailable/*:high", "unavailable/*:high", "provider/model"])
    try nativeScopeClickCheckbox(checkbox)
    try await nativeScopeWait("A native checkbox click did not deselect the model") { !editor.patterns.contains(candidate.id) }
    #expect(editor.patterns == ["unavailable/*:high", "unavailable/*:high"])
}

/// Exercise the checkbox's real pointer path rather than relying on NSButton's
/// programmatic action forwarding into a hosted SwiftUI toggle.
@MainActor private func nativeScopeClickCheckbox(_ button: NSButton) throws {
    let window = try #require(button.window)
    try #require(button.isEnabled && !button.bounds.isEmpty)
    let point = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil)
    func event(_ type: NSEvent.EventType) throws -> NSEvent {
        try #require(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
    }
    NSApp.postEvent(try event(.leftMouseUp), atStart: false)
    window.sendEvent(try event(.leftMouseDown))
    if let up = NSApp.nextEvent(matching: .leftMouseUp, until: Date(), inMode: .default, dequeue: true) {
        window.sendEvent(up)
    }
}

@MainActor private func nativeScopeViewTree(_ view: NSView, depth: Int = 0) -> String {
    String(repeating: " ", count: depth) + "\(type(of: view)) \(view.frame)\n" +
        view.subviews.map { nativeScopeViewTree($0, depth: depth + 1) }.joined()
}

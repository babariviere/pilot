import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@MainActor
private func sidebarOutline(in view: NSView) -> NSOutlineView? {
    if let outline = view as? NSOutlineView { return outline }
    return view.subviews.compactMap { sidebarOutline(in: $0) }.first
}

@MainActor
private func clickSidebarRow(_ row: Int, in outline: NSOutlineView, x: CGFloat = 70) throws {
    let window = try #require(outline.window)
    // Hit the title area, away from the row's revealed buttons.
    let rowRect = outline.rect(ofRow: row)
    let point = outline.convert(NSPoint(x: x, y: rowRect.midY), to: nil)
    let timestamp = ProcessInfo.processInfo.systemUptime
    let down = try #require(NSEvent.mouseEvent(
        with: .leftMouseDown, location: point, modifierFlags: [], timestamp: timestamp,
        windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1
    ))
    let up = try #require(NSEvent.mouseEvent(
        with: .leftMouseUp, location: point, modifierFlags: [], timestamp: timestamp + 0.01,
        windowNumber: window.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 0
    ))
    // Native buttons may track mouseDown until they dequeue the matching mouseUp.
    NSApp.postEvent(up, atStart: true)
    window.sendEvent(down)
    if let pending = NSApp.nextEvent(matching: .leftMouseUp, until: Date(), inMode: .default, dequeue: true) {
        window.sendEvent(pending)
    }
}

@MainActor
private func arrowInSidebar(_ outline: NSOutlineView, up: Bool) throws {
    let window = try #require(outline.window)
    #expect(window.makeFirstResponder(outline))
    let characters = up ? "\u{f700}" : "\u{f701}"
    let event = try #require(NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
        windowNumber: window.windowNumber, context: nil, characters: characters,
        charactersIgnoringModifiers: characters, isARepeat: false, keyCode: up ? 126 : 125
    ))
    outline.keyDown(with: event)
}

@MainActor
private func settleSidebar(_ hosting: NSView) {
    // Let SwiftUI reconcile the native outline before delivering another event,
    // as the app's event loop would.
    hosting.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    hosting.layoutSubtreeIfNeeded()
}

@Test @MainActor
func sidebarChatsSelectByClickAndArrowKeysSkippingGroupHeaders() throws {
    _ = NSApplication.shared
    let suite = "SidebarSelectionTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let model = AppModel(projectFolderDefaults: defaults)
    let project = Project(id: "project", name: "Repository", path: "/repository", createdAt: 1)
    let first = SessionSummary(id: "first", title: "First session", cwd: project.path, projectId: project.id,
                               createdAt: 1, updatedAt: 3, state: "idle")
    let second = SessionSummary(id: "second", title: "Second session", cwd: project.path, projectId: project.id,
                                createdAt: 1, updatedAt: 2, state: "idle")
    model.client.loadFixture(projects: [project], sessions: [first, second])
    // Folders head the project picker and Home, never the sidebar's chat list.
    let created = model.projectFolders.create(name: "Work")
    let folder = try #require(created)
    model.projectFolders.move(projectId: project.id, to: folder.id)
    // The Recent header, then both chats.
    let rowCount = 3

    let hosting = NSHostingView(rootView: SessionSidebar(model: model, client: model.client)
        .environmentObject(model))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 600),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = hosting
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    for _ in 0..<20 {
        hosting.layoutSubtreeIfNeeded()
        if let outline = sidebarOutline(in: hosting), outline.numberOfRows == rowCount { break }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
    let outline = try #require(sidebarOutline(in: hosting))
    try #require(outline.numberOfRows == rowCount)

    try clickSidebarRow(1, in: outline)
    settleSidebar(hosting)
    #expect(model.selectedSessionId == first.id)
    try arrowInSidebar(outline, up: true)
    settleSidebar(hosting)
    #expect(model.selectedSessionId == first.id) // Skip the group header.
    try arrowInSidebar(outline, up: false)
    settleSidebar(hosting)
    #expect(model.selectedSessionId == second.id)
    try arrowInSidebar(outline, up: true)
    settleSidebar(hosting)
    #expect(model.selectedSessionId == first.id)
    try clickSidebarRow(2, in: outline)
    settleSidebar(hosting)
    #expect(model.selectedSessionId == second.id)
}

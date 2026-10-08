import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@MainActor
private func folderSidebarOutline(in view: NSView) -> NSOutlineView? {
    if let outline = view as? NSOutlineView { return outline }
    return view.subviews.compactMap { folderSidebarOutline(in: $0) }.first
}

@MainActor
private func clickFolderSidebarRow(_ row: Int, in outline: NSOutlineView) throws {
    let window = try #require(outline.window)
    // Hit the title area, not the project's chevron or action buttons.
    let point = outline.convert(NSPoint(x: 70, y: outline.rect(ofRow: row).midY), to: nil)
    let timestamp = ProcessInfo.processInfo.systemUptime
    let down = try #require(NSEvent.mouseEvent(
        with: .leftMouseDown, location: point, modifierFlags: [], timestamp: timestamp,
        windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1
    ))
    let up = try #require(NSEvent.mouseEvent(
        with: .leftMouseUp, location: point, modifierFlags: [], timestamp: timestamp + 0.01,
        windowNumber: window.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 0
    ))
    // AppKit may track the mouse until its matching mouse-up. Dispatch through the
    // window so SwiftUI buttons receive clicks as well as native selection checks.
    NSApp.postEvent(up, atStart: true)
    window.sendEvent(down)
    if let pending = NSApp.nextEvent(matching: .leftMouseUp, until: Date(), inMode: .default, dequeue: true) {
        window.sendEvent(pending)
    }
}

@MainActor
private func arrowInFolderSidebar(_ outline: NSOutlineView, up: Bool) throws {
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
private func settleFolderSidebar(_ hosting: NSView) {
    // Let SwiftUI reconcile the native outline before delivering another event,
    // as the app's event loop would.
    hosting.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    hosting.layoutSubtreeIfNeeded()
}

@Test(arguments: [false, true]) @MainActor
func sidebarProjectNamesToggleWithoutSelectingProjects(grouped: Bool) throws {
    _ = NSApplication.shared
    let suite = "SidebarFolderSelectionTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let model = AppModel(projectFolderDefaults: defaults)
    let project = Project(id: "project", name: "Repository", path: "/repository", createdAt: 1)
    let first = SessionSummary(id: "first", title: "First session", cwd: project.path, projectId: project.id,
                               createdAt: 1, updatedAt: 3, state: "idle")
    let second = SessionSummary(id: "second", title: "Second session", cwd: project.path, projectId: project.id,
                                createdAt: 1, updatedAt: 2, state: "idle")
    model.client.loadFixture(projects: [project], sessions: [first, second])
    if grouped {
        let created = model.projectFolders.create(name: "Work")
        let folder = try #require(created)
        model.projectFolders.move(projectId: project.id, to: folder.id)
    }
    let headerRow = grouped ? 1 : 0
    let expandedRowCount = headerRow + 3

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
        if let outline = folderSidebarOutline(in: hosting), outline.numberOfRows == expandedRowCount { break }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
    let outline = try #require(folderSidebarOutline(in: hosting))
    // A project header and two sessions, with an optional folder header.
    try #require(outline.numberOfRows == expandedRowCount)

    try clickFolderSidebarRow(headerRow, in: outline)
    settleFolderSidebar(hosting)
    #expect(model.collapsedProjects.contains(project.id))
    #expect(outline.numberOfRows == expandedRowCount - 2)
    #expect(model.selectedSessionId == nil)
    try clickFolderSidebarRow(headerRow, in: outline)
    settleFolderSidebar(hosting)
    #expect(!model.collapsedProjects.contains(project.id))
    #expect(outline.numberOfRows == expandedRowCount)
    #expect(model.selectedSessionId == nil)
    try clickFolderSidebarRow(headerRow + 1, in: outline)
    settleFolderSidebar(hosting)
    #expect(model.selectedSessionId == first.id)
    try clickFolderSidebarRow(headerRow, in: outline)
    settleFolderSidebar(hosting)
    #expect(model.selectedSessionId == first.id)
    try clickFolderSidebarRow(headerRow, in: outline)
    settleFolderSidebar(hosting)
    #expect(model.selectedSessionId == first.id)

    // Start keyboard traversal from a session, not the disabled header's focus anchor.
    try clickFolderSidebarRow(headerRow + 1, in: outline)
    settleFolderSidebar(hosting)
    try arrowInFolderSidebar(outline, up: true)
    settleFolderSidebar(hosting)
    #expect(model.selectedSessionId == first.id) // Skip non-session headers.
    try arrowInFolderSidebar(outline, up: false)
    settleFolderSidebar(hosting)
    #expect(model.selectedSessionId == second.id)
    try arrowInFolderSidebar(outline, up: true)
    settleFolderSidebar(hosting)
    #expect(model.selectedSessionId == first.id)
    try clickFolderSidebarRow(headerRow + 2, in: outline)
    settleFolderSidebar(hosting)
    #expect(model.selectedSessionId == second.id)
}

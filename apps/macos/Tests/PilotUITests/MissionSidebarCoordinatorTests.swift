import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test(arguments: [false, true], ["missing", "filtered", "archived"]) @MainActor
func sidebarCoordinatorShortcutsSelectEvenWhenChatIsNotVisible(inMenu: Bool, chatState: String) throws {
    _ = NSApplication.shared
    let model = AppModel()
    // Opening must not depend on finding a member in the visible sidebar list.
    let chat = SessionSummary(id: "hidden-chat", title: "Hidden", cwd: "/repository",
                              createdAt: 1, updatedAt: 1, state: "idle",
                              archivedAt: chatState == "archived" ? 2 : nil)
    model.client.loadFixture(projects: [], sessions: chatState == "missing" ? [] : [chat])
    model.sidebarQuery = "does not match"
    let mission = Mission(id: "mission", projectId: "project", title: "Work", goal: "",
                          coordinatorSessionId: "hidden-chat", createdAt: 1, updatedAt: 1)
    let host = NSHostingView(rootView: MissionSidebarCoordinatorAction(mission: mission, inMenu: inMenu)
        .environmentObject(model).frame(width: 200, height: 80))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 80),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = host
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    host.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    let measuring = NSHostingView(rootView: MissionSidebarCoordinatorAction(mission: mission, inMenu: inMenu)
        .environmentObject(model))
    measuring.layoutSubtreeIfNeeded()
    #expect(measuring.fittingSize.width > 0)
    #expect(measuring.fittingSize.height > 0)
    model.openMission(mission.id)
    let location = host.convert(NSPoint(x: host.bounds.midX, y: host.bounds.midY), to: nil)
    let event = { (type: NSEvent.EventType) in
        try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1,
            clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
    }
    // Native menu-style buttons can track mouseDown until they dequeue mouseUp.
    NSApp.postEvent(try event(.leftMouseUp), atStart: false)
    window.sendEvent(try event(.leftMouseDown))
    if let up = NSApp.nextEvent(matching: .leftMouseUp, until: Date(), inMode: .default, dequeue: true) {
        window.sendEvent(up)
    }
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    #expect(model.selectedSessionId == "hidden-chat")
    #expect(model.selectedMissionId == nil)
    #expect(model.sidebarQuery == "does not match")
}

@Test(arguments: [false, true]) @MainActor
func sidebarCoordinatorShortcutsAreAbsentWithoutCoordinator(inMenu: Bool) {
    _ = NSApplication.shared
    let model = AppModel()
    let mission = Mission(id: "mission", projectId: "project", title: "Work", goal: "",
                          createdAt: 1, updatedAt: 1)
    let host = NSHostingView(rootView: MissionSidebarCoordinatorAction(mission: mission, inMenu: inMenu)
        .environmentObject(model))
    host.layoutSubtreeIfNeeded()
    #expect(host.fittingSize == .zero)
    #expect(model.selectedSessionId == nil)
}

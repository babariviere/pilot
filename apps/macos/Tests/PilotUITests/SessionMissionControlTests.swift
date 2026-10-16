import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test(arguments: [false, true], [false, true]) @MainActor
func missionToolbarIconOpensOverviewForEveryChat(coordinator: Bool, inspectorVisible: Bool) throws {
    _ = NSApplication.shared
    let model = AppModel()
    let chat = SessionSummary(id: "chat", title: "Work", cwd: "/repository",
                              createdAt: 1, updatedAt: 1, state: "idle", missionId: "mission",
                              missionCoordinator: coordinator)
    model.client.loadFixture(projects: [], sessions: [chat])
    let mission = Mission(id: "mission", projectId: "project",
                          title: "A long mission name that must not widen the toolbar button", goal: "",
                          createdAt: 1, updatedAt: 1)
    model.client.handle(.missions([mission]))
    model.selectedSessionId = chat.id
    model.missionTab = .tasks
    model.inspectorTab = .artifacts
    model.inspectorVisible = inspectorVisible

    let measuring = NSHostingView(rootView: SessionMissionControl(session: chat).environmentObject(model))
    measuring.layoutSubtreeIfNeeded()
    #expect(measuring.fittingSize.width > 0)
    #expect(measuring.fittingSize.width < 50)

    let host = NSHostingView(rootView: SessionMissionControl(session: chat)
        .environmentObject(model).frame(width: 100, height: 60))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 100, height: 60),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = host
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    host.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    let location = host.convert(NSPoint(x: host.bounds.midX, y: host.bounds.midY), to: nil)
    let event = { (type: NSEvent.EventType) in
        try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1,
            clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
    }
    // Native buttons may track mouseDown until they dequeue mouseUp.
    NSApp.postEvent(try event(.leftMouseUp), atStart: false)
    window.sendEvent(try event(.leftMouseDown))
    if let up = NSApp.nextEvent(matching: .leftMouseUp, until: Date(), inMode: .default, dequeue: true) {
        window.sendEvent(up)
    }
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))

    #expect(model.selectedSessionId == nil)
    #expect(model.selectedMissionId == mission.id)
    #expect(model.missionTab == .overview)
    #expect(model.inspectorVisible == inspectorVisible)
    #expect(model.inspectorTab == .artifacts)
    #expect(model.terminals.order.isEmpty)
}

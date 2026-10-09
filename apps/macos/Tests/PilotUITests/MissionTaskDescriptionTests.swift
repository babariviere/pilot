import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func taskDescriptionsExpandAndCollapseAtListAndInspectorWidths() {
    _ = NSApplication.shared
    let source = (1...20).map { "Step \($0): read the complete task description." }.joined(separator: "\n")
    for (width, lines) in [(600.0, 2), (240.0, 4)] {
        let expansion = ExpansionState()
        let task = MissionTask(id: "task", number: 1, title: "Task", body: source)
        let host = NSHostingView(rootView: MissionTaskDescription(task: task, collapsedLineLimit: lines,
                                                                 expansion: expansion)
            .fixedSize(horizontal: false, vertical: true).frame(width: width))
        host.frame = NSRect(x: 0, y: 0, width: width, height: 800)
        host.layoutSubtreeIfNeeded()
        let collapsedHeight = host.fittingSize.height
        #expect(!expansion.expanded)
        #expect(collapsedHeight < 150)

        expansion.expanded = true
        host.layoutSubtreeIfNeeded()
        #expect(host.fittingSize.height > collapsedHeight + 200)
        #expect(host.fittingSize.width <= width)

        expansion.expanded = false
        host.layoutSubtreeIfNeeded()
        #expect(host.fittingSize.height == collapsedHeight)
    }
}

@Test @MainActor func absentTaskDescriptionsHaveNoContentOrToggle() {
    _ = NSApplication.shared
    for description: String? in [nil, ""] {
        let task = MissionTask(id: "task", number: 1, title: "Task", body: description)
        let host = NSHostingView(rootView: MissionTaskDescription(task: task))
        host.layoutSubtreeIfNeeded()
        #expect(host.fittingSize.height == 0)
    }
}

@Test @MainActor func taskDescriptionButtonExpandsAndCollapsesOnClick() throws {
    _ = NSApplication.shared
    let expansion = ExpansionState()
    let task = MissionTask(id: "task", number: 7, title: "Task",
                           body: String(repeating: "Read the full description.\n", count: 12))
    let description = MissionTaskDescription(task: task, expansion: expansion)
    let measuring = NSHostingView(rootView: description
        .fixedSize(horizontal: false, vertical: true).frame(width: 240))
    measuring.frame = NSRect(x: 0, y: 0, width: 240, height: 500)
    let host = NSHostingView(rootView: description
        .frame(width: 240, alignment: .leading).padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 280, height: 600),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = host
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()

    for expected in [true, false] {
        host.layoutSubtreeIfNeeded()
        measuring.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        let topDistance = 20 + measuring.fittingSize.height - 8
        let point = NSPoint(x: 55, y: host.isFlipped ? topDistance : host.bounds.height - topDistance)
        let location = host.convert(point, to: nil)
        let event = { (type: NSEvent.EventType) in
            try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1,
                clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
        }
        // A button may track the mouse after mouseDown by pulling events from the queue until mouseUp.
        // Queue the mouseUp first so tracking always ends, instead of waiting forever for a real one
        // (seen on headless CI runners). Deliver it directly if nothing consumed it.
        NSApp.postEvent(try event(.leftMouseUp), atStart: false)
        window.sendEvent(try event(.leftMouseDown))
        if let up = NSApp.nextEvent(matching: .leftMouseUp, until: Date(), inMode: .default, dequeue: true) {
            window.sendEvent(up)
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        #expect(expansion.expanded == expected)
    }
}

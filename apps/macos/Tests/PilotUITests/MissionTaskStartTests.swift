import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func taskStartChatIsDisabledUntilInactiveMissionIsReopened() throws {
    _ = NSApplication.shared
    for status in [MissionStatus.active, .done, .archived, .active] {
        var starts = 0
        let host = NSHostingView(rootView: MissionTaskStartButton(status: status) { starts += 1 }
            .frame(width: 200, height: 100))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100),
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
        // The native button may track mouseDown until it dequeues mouseUp.
        NSApp.postEvent(try event(.leftMouseUp), atStart: false)
        window.sendEvent(try event(.leftMouseDown))
        if let up = NSApp.nextEvent(matching: .leftMouseUp, until: Date(), inMode: .default, dequeue: true) {
            window.sendEvent(up)
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        #expect(starts == (status == .active ? 1 : 0))
    }
}

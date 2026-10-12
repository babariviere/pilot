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
        try liveClick(host, x: 100, top: 50)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        #expect(starts == (status == .active ? 1 : 0))
    }
}

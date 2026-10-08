import AppKit
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func embeddedPreviewsOpenFromAnywhereInTheirBounds() throws {
    _ = NSApplication.shared
    var opens = 0
    let hosting = NSHostingView(rootView:
        Color.white.allowsHitTesting(false).overlay {
            EmbeddedPreviewButton(title: "Open preview", help: "Click to expand", open: { opens += 1 })
        }
    )
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 180),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = hosting
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    hosting.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))

    for point in [NSPoint(x: 160, y: 90), NSPoint(x: 8, y: 8), NSPoint(x: 312, y: 172)] {
        let location = hosting.convert(point, to: nil)
        _ = try #require(hosting.hitTest(point))
        let down = try #require(NSEvent.mouseEvent(
            with: .leftMouseDown, location: location, modifierFlags: [], timestamp: 0,
            windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1
        ))
        let up = try #require(NSEvent.mouseEvent(
            with: .leftMouseUp, location: location, modifierFlags: [], timestamp: 0.01,
            windowNumber: window.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 0
        ))
        window.sendEvent(down)
        window.sendEvent(up)
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    #expect(opens == 3)
}

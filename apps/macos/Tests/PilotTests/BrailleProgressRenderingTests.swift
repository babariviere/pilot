import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func workingBrailleChangesFramesWhileVisible() async throws {
    _ = NSApplication.shared
    if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return }
    let hosting = NSHostingView(rootView: SessionStatusIcon(status: .working)
        .padding(12).background(Color.white))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 40, height: 40),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = hosting
    window.orderFrontRegardless()
    var frames = Set<Data>()
    for _ in 0..<15 {
        try await Task.sleep(for: .milliseconds(80))
        hosting.layoutSubtreeIfNeeded()
        let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        frames.insert(try #require(bitmap.representation(using: .png, properties: [:])))
    }
    #expect(frames.count >= 5)
}

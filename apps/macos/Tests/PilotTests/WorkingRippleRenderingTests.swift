import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

// Animation verification must also work on a locked/headless test host. Feed the
// production visibility gate explicitly; do not ask the desktop to become active.
@MainActor private final class SpinnerWindow: NSWindow {
    var visibleForTest = true
    override var occlusionState: NSWindow.OcclusionState { visibleForTest ? .visible : [] }
}

@Test @MainActor func workingSpinnerChangesFramesWhileVisible() async throws {
    _ = NSApplication.shared
    let hosting = NSHostingView(rootView: SessionStatusIcon(status: .working)
        .padding(12).background(Color.white))
    let window = SpinnerWindow(contentRect: NSRect(x: 0, y: 0, width: 40, height: 40),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = hosting
    window.orderFrontRegardless()
    hosting.layoutSubtreeIfNeeded()
    func spinner(in view: NSView) -> EllipsisSpinnerView? {
        (view as? EllipsisSpinnerView) ?? view.subviews.lazy.compactMap { spinner(in: $0) }.first
    }
    let spinner = try #require(spinner(in: hosting))
    // Exercise the live path even if the test host has Reduce Motion enabled.
    spinner.animates = true
    let dots = try #require(spinner.layer?.sublayers?.first?.sublayers)
    #expect(dots.count == 3)
    #expect(spinner.playing)
    var frames = Set<[Double]>()
    for _ in 0..<15 {
        try await Task.sleep(for: .milliseconds(80))
        // cacheDisplay renders model-layer values, which intentionally stay still.
        // The render server animates these presentation-layer opacities/transforms.
        let frame = try dots.flatMap { dot -> [Double] in
            let moving = try #require(dot.presentation())
            let ink = try #require(dot.sublayers?.first?.presentation())
            return [Double(ink.opacity), Double(moving.transform.m42)]
        }
        frames.insert(frame)
    }
    #expect(frames.count >= 5)
    window.visibleForTest = false
    NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: window)
    #expect(!spinner.playing)
    for dot in dots {
        #expect(dot.animationKeys() == nil)
        #expect(dot.sublayers?.first?.animationKeys() == nil)
    }
}

import AppKit
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func rowActionMenuTrackingWaitsForEveryMenuToClose() {
    let parent = NSMenu(title: "More actions")
    let missions = NSMenu(title: "Link to Mission")
    let size = NSMenu(title: "Size")
    let unrelated = NSMenu(title: "Other")
    var tracking = RowActionMenuTracking()
    #expect(!tracking.isTracking)
    tracking.begin(parent)
    tracking.begin(parent) // Duplicate notifications cannot leave a stuck retain count.
    tracking.begin(missions)
    tracking.end(unrelated)
    tracking.end(missions)
    #expect(tracking.isTracking)
    tracking.begin(size) // Switching to a sibling submenu keeps the same source alive.
    tracking.end(size)
    #expect(tracking.isTracking)
    tracking.end(parent)
    #expect(!tracking.isTracking)
    tracking.begin(parent)
    tracking.begin(missions)
    tracking.end(parent)
    #expect(tracking.isTracking)
    tracking.end(missions)
    #expect(!tracking.isTracking)
}

@MainActor private final class RowActionFixture: ObservableObject {
    @Published var hovered = true
    var clicks = 0
}

private struct RowActionFixtureView: View {
    @ObservedObject var state: RowActionFixture

    var body: some View {
        Button("Choose mission") { state.clicks += 1 }
            .buttonStyle(.plain)
            .frame(width: 160, height: 40)
            .contentShape(Rectangle())
            .revealed(state.hovered)
    }
}

/// Exercise the production modifier through AppKit events, not just the tracking helper. Native menu
/// notifications let us reproduce leaving a row for a submenu without depending on desktop pointer position.
@Test(.serialized, arguments: ["Link to Mission", "Size"])
@MainActor func rowActionsStayClickableAcrossSubmenusAndHideAfterDismissal(submenuTitle: String) async throws {
    _ = NSApplication.shared
    let state = RowActionFixture()
    let host = NSHostingView(rootView: RowActionFixtureView(state: state))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 160, height: 40),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    defer { window.close() }
    host.layoutSubtreeIfNeeded()
    try await Task.sleep(for: .milliseconds(50))

    let parent = NSMenu(title: "More actions")
    let submenu = NSMenu(title: submenuTitle)
    let sibling = NSMenu(title: submenuTitle == "Size" ? "Link to Mission" : "Size")
    let center = NotificationCenter.default
    func begin(_ menu: NSMenu) {
        center.post(name: NSMenu.didBeginTrackingNotification, object: menu)
    }
    func end(_ menu: NSMenu) {
        center.post(name: NSMenu.didEndTrackingNotification, object: menu)
    }
    func click() async throws {
        // Do not let native focus mask a missing menu retain.
        window.makeFirstResponder(nil)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        let location = host.convert(NSPoint(x: 80, y: 20), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1,
                clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        try await Task.sleep(for: .milliseconds(20))
    }

    begin(parent)
    state.hovered = false // Pointer leaves the row on its way into the menu.
    try await click()
    #expect(state.clicks == 1)
    begin(submenu)
    end(submenu) // Moving back out of a submenu must not close its parent.
    begin(sibling)
    end(sibling)
    try await click()
    #expect(state.clicks == 2)
    end(parent) // Cancel and selection both end native tracking.
    try await click()
    #expect(state.clicks == 2)

    // Another row's menu must not reveal this now-hidden row.
    begin(parent)
    try await click()
    #expect(state.clicks == 2)
    end(parent)
    state.hovered = true
    try await click()
    #expect(state.clicks == 3)
}

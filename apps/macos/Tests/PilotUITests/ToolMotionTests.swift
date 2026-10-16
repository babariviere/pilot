import AppKit
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func openingADisclosureRevealsOnlyRightAfterTheUserOpensIt() {
    let expansion = ExpansionState()
    #expect(!expansion.justOpened(), "content shown on its own (opening a chat, scrolling back) appears at once")
    expansion.toggleExpanded()
    #expect(expansion.expanded)
    #expect(expansion.justOpened())
    let later = (expansion.openedAt ?? .now).addingTimeInterval(1)
    #expect(!expansion.justOpened(at: later), "a row rebuilt later does not reveal again")
    let opened = expansion.openedAt
    expansion.toggleExpanded()
    #expect(!expansion.expanded)
    #expect(expansion.openedAt == opened, "closing is immediate and does not count as opening")
}

@Test func onlyRunningStepsOfTheWorkingTurnShimmer() {
    #expect(ToolStatus.running.isLive(active: true))
    #expect(ToolStatus.pending.isLive(active: true))
    #expect(!ToolStatus.running.isLive(active: false), "an interrupted turn's steps stay still")
    #expect(!ToolStatus.done.isLive(active: true))
    #expect(!ToolStatus.error.isLive(active: true))
}

@Test @MainActor func shimmerSweepsOnlyWhileOnScreenAndNeverResizes() {
    let view = ShimmerView(frame: NSRect(x: 0, y: 0, width: 200, height: 16))
    view.layout()
    let gradient = view.layer?.sublayers?.first as? CAGradientLayer
    #expect(gradient?.frame.width == 600, "the band sits in a gradient three titles wide")
    #expect(gradient?.animationKeys() == nil, "no window, no sweep")
    #expect(view.frame.size == NSSize(width: 200, height: 16))
    #expect(abs(Theme.Motion.shimmerVeil - 0.33) < 0.000_001)
}

@Test @MainActor func revealCoverPlaysOnceWhenPlacedInAWindow() {
    let cover = RevealCoverView(frame: NSRect(x: 0, y: 0, width: 300, height: 120))
    cover.layout()
    #expect(!cover.played, "waits until it is in a window")
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200), styleMask: [.titled],
                          backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView?.addSubview(cover)
    cover.layout()
    #expect(cover.played)
    let layer = cover.layer?.sublayers?.first
    #expect(layer?.animation(forKey: "reveal") != nil)
    #expect(layer?.opacity == 0, "the cover ends clear, so the content stays visible")
    window.close()
}

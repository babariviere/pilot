import Foundation
import Testing
@testable import Pilot

@Test func terminalRetentionBoundsInactiveSurfacesAndProtectsTheVisibleSurface() {
    var retention = TerminalSurfaceRetention()
    retention.visibleSessionId = "0"
    for id in 0..<8 { retention.touch(String(id)) }
    #expect(retention.evictions() == ["1", "2"])
    for id in retention.evictions() { retention.remove(id) }
    #expect(retention.recency.count == 6)
    #expect(retention.recency.contains("0"))
    retention.visibleSessionId = nil
    #expect(retention.evictions() == ["0"])
    retention.remove("0")
    #expect(retention.recency.count == 5)
}

@Test func outgoingTerminalTreeCannotUnprotectTheNewSelection() {
    var retention = TerminalSurfaceRetention(inactiveLimit: 1)
    let oldPane = UUID()
    let newPane = UUID()
    retention.select("a", isVisible: true, paneID: oldPane)
    retention.touch("a")
    retention.touch("b")
    retention.select("b", isVisible: true, paneID: newPane)
    #expect(!retention.ownsSurfaceCallbacks(paneID: oldPane))
    #expect(retention.ownsSurfaceCallbacks(paneID: newPane))
    let hidOldPane = retention.hide(sessionId: "a", paneID: oldPane)
    #expect(!hidOldPane)
    retention.touch("c")
    #expect(retention.visibleSessionId == "b")
    #expect(retention.evictions() == ["a"])
    let hidNewPane = retention.hide(sessionId: "b", paneID: newPane)
    #expect(hidNewPane)
    #expect(!retention.ownsSurfaceCallbacks(paneID: newPane))
    #expect(retention.visibleSessionId == nil)
    #expect(retention.evictions() == ["a", "b"])
}

@Test func olderTerminalDepartureClearsOnlyItsMatchingVisibleSession() {
    var retention = TerminalSurfaceRetention(inactiveLimit: 1)
    retention.visibleSessionId = "old"
    retention.touch("old")
    retention.visibleSessionId = "new"
    retention.touch("new")
    retention.touch("other")
    let clearedOld = retention.clearVisible(ifMatching: "old")
    #expect(!clearedOld)
    #expect(retention.visibleSessionId == "new")
    #expect(retention.evictions() == ["old"])
    let clearedNew = retention.clearVisible(ifMatching: "new")
    #expect(clearedNew)
    #expect(retention.visibleSessionId == nil)
}

@Test func outgoingTerminalTreeForSameSessionCannotHideItsReplacement() {
    var retention = TerminalSurfaceRetention()
    let oldPane = UUID()
    let newPane = UUID()
    retention.select("same", isVisible: true, paneID: oldPane)
    retention.select("same", isVisible: true, paneID: newPane)
    #expect(!retention.ownsSurfaceCallbacks(paneID: oldPane))
    #expect(retention.ownsSurfaceCallbacks(paneID: newPane))
    let hidOldPane = retention.hide(sessionId: "same", paneID: oldPane)
    #expect(!hidOldPane)
    #expect(retention.visibleSessionId == "same")
}

@Test func hiddenTerminalPaneDepartureInvalidatesItsLeafCallbacks() {
    var retention = TerminalSurfaceRetention()
    let pane = UUID()
    retention.select("hidden", isVisible: false, paneID: pane)
    #expect(retention.ownsSurfaceCallbacks(paneID: pane))
    let hidPane = retention.hide(sessionId: "hidden", paneID: pane)
    #expect(hidPane)
    #expect(!retention.ownsSurfaceCallbacks(paneID: pane))
    #expect(retention.visibleSessionId == nil)
}

@Test func terminalRetentionUsesRecencyAndAllowsReattachmentAfterEviction() {
    var retention = TerminalSurfaceRetention(inactiveLimit: 2)
    retention.touch("a")
    retention.touch("b")
    retention.touch("a")
    retention.touch("c")
    #expect(retention.evictions() == ["b"])
    retention.remove("b")
    retention.visibleSessionId = "b"
    retention.touch("b")
    #expect(retention.evictions().isEmpty)
    #expect(retention.recency == ["a", "c", "b"])
}

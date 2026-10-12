import AppKit
import Combine
import SwiftUI
import Testing
@testable import Pilot

@MainActor
private func testWindow() -> NSWindow {
    _ = NSApplication.shared
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
        styleMask: .borderless,
        backing: .buffered,
        defer: false
    )
    window.isReleasedWhenClosed = false
    return window
}

private struct ScrollTestChat: View {
    let state: TranscriptScrollState

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack {
                    ForEach(0..<100) { index in
                        Text("Message \(index)").frame(height: 50)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.top, 24)
                .padding(.bottom, 8)
                .background(TranscriptScrollObserver(state: state, bottomPadding: 8))
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { Text("Composer").frame(height: 100) }
    }
}

@MainActor
private func findObserver(_ view: NSView) -> ScrollObserverView? {
    if let observer = view as? ScrollObserverView { return observer }
    return view.subviews.compactMap(findObserver).first
}

@Test @MainActor func swiftUIScrollingAccountsForTheComposerInset() throws {
    let window = testWindow()
    defer { window.close() }
    let state = TranscriptScrollState()
    let hosting = NSHostingView(rootView: ScrollTestChat(state: state))
    window.contentView = hosting
    hosting.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    hosting.layoutSubtreeIfNeeded()
    let observer = try #require(findObserver(hosting))
    let scroll = try #require(observer.enclosingScrollView)
    let center = NotificationCenter.default

    center.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
    #expect(!state.follow.shouldScrollToBottom)
    center.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
    #expect(state.follow.shouldScrollToBottom)

    // This movement is smaller than the composer inset. Ignoring the inset
    // incorrectly treats the reader as still at the bottom and jumps back down.
    let bottom = scroll.contentView.bounds.origin
    scroll.contentView.scroll(to: NSPoint(x: bottom.x, y: bottom.y - 60))
    center.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
    #expect(!state.follow.shouldScrollToBottom)

    scroll.contentView.scroll(to: bottom)
    center.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
    #expect(state.follow.shouldScrollToBottom)
}

/// The chat observes this state for its lifetime. Publishing per live-scroll frame re-evaluated
/// the whole transcript, composer and todos on every frame of a scroll gesture.
@Test @MainActor func liveScrollingDoesNotInvalidateTheTranscript() throws {
    let window = testWindow()
    defer { window.close() }
    let state = TranscriptScrollState()
    var changes = 0
    let observation = state.objectWillChange.sink { changes += 1 }
    defer { observation.cancel() }
    let hosting = NSHostingView(rootView: ScrollTestChat(state: state))
    window.contentView = hosting
    hosting.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    hosting.layoutSubtreeIfNeeded()
    let observer = try #require(findObserver(hosting))
    let scroll = try #require(observer.enclosingScrollView)
    let center = NotificationCenter.default

    center.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
    let bottom = scroll.contentView.bounds.origin
    for offset in stride(from: 40.0, through: 400, by: 40) {
        scroll.contentView.scroll(to: NSPoint(x: bottom.x, y: bottom.y - offset))
        center.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
    }
    center.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
    state.messageToggled()

    #expect(!state.follow.shouldScrollToBottom)
    #expect(changes == 0)
}

private final class FlippedScrollDocument: NSView {
    override var isFlipped: Bool { true }
}

@Test @MainActor func transcriptOpeningWaitsForNativeGeometryAndFollowsLaterHeightChanges() async throws {
    for flipped in [true, false] {
        let window = testWindow()
        defer { window.close() }
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        let document = flipped ? FlippedScrollDocument() : NSView()
        document.frame = NSRect(x: 0, y: 0, width: 600, height: 1600)
        scroll.documentView = document
        scroll.contentInsets.bottom = 100
        let state = TranscriptScrollState()
        let observer = ScrollObserverView(frame: document.bounds)
        observer.state = state
        observer.bottomPadding = 8
        document.addSubview(observer)
        window.contentView = scroll
        scroll.layoutSubtreeIfNeeded()

        func remaining() -> CGFloat {
            let visible = scroll.contentView.bounds
            let distance = flipped ? document.bounds.maxY - visible.maxY : visible.minY - document.bounds.minY
            return max(0, distance + scroll.contentInsets.bottom - observer.bottomPadding)
        }
        try await Task.sleep(for: .milliseconds(50))
        #expect(remaining() <= 2)
        // Cached history, Markdown preparation, and streamed output change native geometry
        // after onAppear/onChange have already issued their SwiftUI scroll requests.
        document.setFrameSize(NSSize(width: 600, height: 2400))
        try await Task.sleep(for: .milliseconds(50))
        #expect(remaining() <= 2)
        scroll.setFrameSize(NSSize(width: 450, height: 300))
        scroll.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        #expect(remaining() <= 2)

        state.follow.pauseFollowing()
        let position = flipped ? CGFloat(500) : CGFloat(1000)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: position))
        let before = scroll.contentView.bounds.origin
        document.setFrameSize(NSSize(width: 450, height: 2800))
        try await Task.sleep(for: .milliseconds(50))
        #expect(scroll.contentView.bounds.origin == before)
        #expect(!state.follow.shouldScrollToBottom)
    }
}

@Test @MainActor func transcriptPendingLayoutScrollDoesNotOutliveItsView() async throws {
    let window = testWindow()
    defer { window.close() }
    let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
    let document = FlippedScrollDocument(frame: NSRect(x: 0, y: 0, width: 600, height: 1600))
    scroll.documentView = document
    let observer = ScrollObserverView(frame: document.bounds)
    let state = TranscriptScrollState()
    observer.state = state
    document.addSubview(observer)
    window.contentView = scroll
    document.setFrameSize(NSSize(width: 600, height: 2000))
    observer.stopObserving()
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 100))
    try await Task.sleep(for: .milliseconds(50))
    #expect(scroll.contentView.bounds.minY == 100)
}

@Test @MainActor func nativeUserScrollingPausesFollowButLayoutChangesDoNot() {
    let window = testWindow()
    defer { window.close() }
    let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
    let document = FlippedScrollDocument(frame: NSRect(x: 0, y: 0, width: 600, height: 1600))
    scroll.documentView = document
    let state = TranscriptScrollState()
    let observer = ScrollObserverView(frame: document.bounds)
    observer.state = state
    document.addSubview(observer)
    window.contentView = scroll
    scroll.layoutSubtreeIfNeeded()

    scroll.contentView.scroll(to: NSPoint(x: 0, y: 1200))
    #expect(state.follow.shouldScrollToBottom)
    let center = NotificationCenter.default
    center.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
    #expect(!state.follow.shouldScrollToBottom)
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 1080))
    center.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
    center.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
    #expect(!state.follow.shouldScrollToBottom)

    document.setFrameSize(NSSize(width: 600, height: 2000))
    #expect(!state.follow.shouldScrollToBottom)
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 1600))
    // Programmatic layout/scrolling must not re-enable follow on its own.
    #expect(!state.follow.shouldScrollToBottom)
    // Legacy wheels can deliver this notification without a begin/end pair.
    center.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
    #expect(state.follow.shouldScrollToBottom)

    observer.stopObserving()
    center.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
    #expect(state.follow.shouldScrollToBottom)
}

/// Markdown preparation can move a marker without changing either its immediate host's
/// frame or the document size. These native movements must all preserve the reading position.
@Test @MainActor func transcriptAnchoringObservesNestedNativeGeometryChanges() async throws {
    for flipped in [true, false] {
        for movement in 0..<3 {
            let window = testWindow()
            defer { window.close() }
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
            let document = flipped ? FlippedScrollDocument() : NSView()
            document.frame = NSRect(x: 0, y: 0, width: 600, height: 1600)
            scroll.documentView = document
            let ancestor = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 1200))
            let host = NSView(frame: NSRect(x: 0, y: 600, width: 600, height: 90))
            let marker = TranscriptRowAnchorView(frame: NSRect(x: 0, y: 0, width: 600, height: 90))
            marker.rowID = "nested-\(flipped)-\(movement)"
            host.addSubview(marker)
            ancestor.addSubview(host)
            document.addSubview(ancestor)
            let state = TranscriptScrollState()
            state.follow.pauseFollowing()
            let observer = ScrollObserverView(frame: document.bounds)
            observer.state = state
            document.addSubview(observer)
            window.contentView = scroll
            scroll.layoutSubtreeIfNeeded()
            scroll.contentView.scroll(to: NSPoint(x: 0, y: 500))
            observer.captureAnchor()
            // Drain initial layout/bounds notifications before the mutation, so an unrelated
            // pending settle cannot accidentally make the regression pass.
            try await Task.sleep(for: .milliseconds(30))
            #expect(marker.isAnchored)
            let before = marker.convert(marker.bounds, to: nil).minY
            let documentSize = document.frame.size
            switch movement {
            case 0: marker.setFrameOrigin(NSPoint(x: 0, y: 7))
            case 1: host.setBoundsOrigin(NSPoint(x: 0, y: 7))
            default: ancestor.setFrameOrigin(NSPoint(x: 0, y: 7))
            }
            try await Task.sleep(for: .milliseconds(30))
            let after = marker.convert(marker.bounds, to: nil).minY
            #expect(abs(after - before) <= 0.5, "movement \(movement), flipped \(flipped)")
            #expect(document.frame.size == documentSize)
            #expect(!state.follow.shouldScrollToBottom)
            observer.stopObserving()
        }
    }
}

@MainActor
private final class AnchorMovementCounter: NSObject {
    var count = 0
    @objc func moved(_ notification: Notification) { count += 1 }
}

@Test @MainActor func transcriptAnchorGeometryObservationIsQuietAndStopsWithItsLifetime() async throws {
    let window = testWindow()
    defer { window.close() }
    let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
    let document = FlippedScrollDocument(frame: NSRect(x: 0, y: 0, width: 600, height: 1600))
    scroll.documentView = document
    let host = NSView(frame: NSRect(x: 0, y: 600, width: 600, height: 90))
    let marker = TranscriptRowAnchorView(frame: NSRect(x: 0, y: 0, width: 600, height: 90))
    marker.rowID = "lifetime"
    host.addSubview(marker)
    document.addSubview(host)
    let state = TranscriptScrollState()
    state.follow.pauseFollowing()
    let observer = ScrollObserverView(frame: document.bounds)
    observer.state = state
    document.addSubview(observer)
    window.contentView = scroll
    scroll.layoutSubtreeIfNeeded()
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 500))
    observer.captureAnchor()
    try await Task.sleep(for: .milliseconds(30))
    let counter = AnchorMovementCounter()
    let center = NotificationCenter.default
    center.addObserver(counter, selector: #selector(AnchorMovementCounter.moved), name: TranscriptRowAnchorView.didMove, object: marker)
    defer { center.removeObserver(counter) }

    marker.setFrameOrigin(NSPoint(x: 0, y: 7))
    #expect(counter.count == 1)
    for _ in 0..<5 { observer.captureAnchor() }
    center.post(name: NSView.frameDidChangeNotification, object: host)
    center.post(name: NSView.boundsDidChangeNotification, object: host)
    #expect(counter.count == 1, "Unchanged geometry and recapture must not create notifications")

    marker.isAnchored = false
    marker.setFrameOrigin(NSPoint(x: 0, y: 14))
    #expect(counter.count == 1)
    observer.captureAnchor()
    marker.setFrameOrigin(NSPoint(x: 0, y: 21))
    #expect(counter.count == 2)
    observer.stopObserving()
    marker.setFrameOrigin(NSPoint(x: 0, y: 28))
    #expect(counter.count == 2)
    #expect(!marker.isAnchored)
}

/// Mimics AppKit during a live scroll, which posts the live-scroll notification synchronously
/// from every clip view scroll, including the one anchor compensation performs.
@MainActor
private final class LiveScrollRelay: NSObject {
    let scroll: NSScrollView
    init(_ scroll: NSScrollView) { self.scroll = scroll }
    @objc func boundsChanged(_ notification: Notification) {
        NotificationCenter.default.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
    }
}

@Test @MainActor func liveScrollCompensationDoesNotReenterItself() async throws {
    let window = testWindow()
    defer { window.close() }
    let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
    let document = FlippedScrollDocument(frame: NSRect(x: 0, y: 0, width: 600, height: 4000))
    scroll.documentView = document
    let marker = TranscriptRowAnchorView(frame: NSRect(x: 0, y: 600, width: 600, height: 90))
    marker.rowID = "reentry"
    document.addSubview(marker)
    let state = TranscriptScrollState()
    let observer = ScrollObserverView(frame: document.bounds)
    observer.state = state
    document.addSubview(observer)
    window.contentView = scroll
    scroll.layoutSubtreeIfNeeded()
    let center = NotificationCenter.default
    center.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 500))
    observer.captureAnchor()
    try await Task.sleep(for: .milliseconds(30))
    #expect(marker.isAnchored)

    let relay = LiveScrollRelay(scroll)
    center.addObserver(relay, selector: #selector(LiveScrollRelay.boundsChanged), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
    defer { center.removeObserver(relay) }
    // A lazy row realized above the anchor while the user scrolls by 20 points.
    marker.isAnchored = false
    marker.setFrameOrigin(NSPoint(x: 0, y: 607))
    marker.isAnchored = true
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 520))
    #expect(abs(scroll.contentView.bounds.minY - 527) <= 0.5)
    center.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
    observer.stopObserving()
}

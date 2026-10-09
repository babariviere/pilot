import AppKit
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

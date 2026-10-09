import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func existingBubbleUpdatesAndRemovesItsTimestampFooter() {
    _ = NSApplication.shared
    let selection = MessageTimestampSelection()
    let key = MessageTimestampKey(rowID: "u", milliseconds: 1_781_015_528_123)
    let host = NSHostingView(rootView: UserMessage(text: "Hello", messageID: key.rowID, timestamp: key.milliseconds)
        .environment(\.messageTimestampSelection, selection)
        .fixedSize(horizontal: false, vertical: true).frame(width: 500))
    host.frame = NSRect(x: 0, y: 0, width: 500, height: 400)
    func height() -> CGFloat {
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        host.layoutSubtreeIfNeeded()
        return host.fittingSize.height
    }
    let original = height()
    selection.toggle(key)
    #expect(height() > original + 5)
    selection.toggle(key)
    #expect(height() == original)
}

@Test @MainActor func timestampsStartHiddenAndOnlySelectedMessageAddsAFooter() {
    _ = NSApplication.shared
    let selection = MessageTimestampSelection()
    let key = MessageTimestampKey(rowID: "u", milliseconds: 1_781_015_528_123)
    func height(_ row: ChatRow) -> CGFloat {
        let host = NSHostingView(rootView: RowView(row: row)
            .environment(\.messageTimestampSelection, selection)
            .fixedSize(horizontal: false, vertical: true).frame(width: 500))
        host.frame = NSRect(x: 0, y: 0, width: 500, height: 400)
        host.layoutSubtreeIfNeeded()
        return host.fittingSize.height
    }
    let user = ChatRow.user(id: "u", text: "Hello", timestamp: key.milliseconds)
    let assistant = ChatRow.text(id: "a", text: "Reply", timestamp: key.milliseconds + 1_000)
    let userHeight = height(user)
    let assistantHeight = height(assistant)
    #expect(selection.selected == nil)
    selection.toggle(key)
    #expect(height(user) > userHeight + 5)
    #expect(height(assistant) == assistantHeight)
    selection.toggle(MessageTimestampKey(rowID: "a", milliseconds: key.milliseconds + 1_000))
    #expect(height(user) == userHeight)
    #expect(height(assistant) > assistantHeight + 5)
    selection.dismiss()
    #expect(height(user) == userHeight)
    #expect(height(assistant) == assistantHeight)
}

@Test @MainActor func messagesWithoutTimeDoNotInventAFooter() {
    _ = NSApplication.shared
    let selection = MessageTimestampSelection()
    selection.toggle(MessageTimestampKey(rowID: "u", milliseconds: 0))
    let host = NSHostingView(rootView: UserMessage(text: "Legacy", messageID: "u")
        .environment(\.messageTimestampSelection, selection)
        .fixedSize(horizontal: false, vertical: true).frame(width: 500))
    host.frame = NSRect(x: 0, y: 0, width: 500, height: 400)
    host.layoutSubtreeIfNeeded()
    let plain = NSHostingView(rootView: UserMessage(text: "Legacy")
        .fixedSize(horizontal: false, vertical: true).frame(width: 500))
    plain.frame = host.frame
    plain.layoutSubtreeIfNeeded()
    #expect(host.fittingSize.height == plain.fittingSize.height)
}

@Test @MainActor func nativeTimestampClicksToggleSwitchAndDismissWithoutInterceptingText() throws {
    _ = NSApplication.shared
    let selection = MessageTimestampSelection()
    let scroll = TranscriptScrollState()
    let user = MessageTimestampKey(rowID: "u", milliseconds: 1_781_015_528_123)
    let assistant = MessageTimestampKey(rowID: "a", milliseconds: user.milliseconds + 1_000)
    let host = NSHostingView(rootView: VStack(alignment: .leading, spacing: 18) {
        RowView(row: .user(id: user.rowID, text: "Hello", timestamp: user.milliseconds))
        RowView(row: .text(id: assistant.rowID, text: "Reply", timestamp: assistant.milliseconds))
        Spacer()
    }.padding(24)
        .environment(\.messageTimestampSelection, selection)
        .background(MessageTimestampClickObserver(selection: selection, onToggle: scroll.messageToggled)))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 350),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = host
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    func layout() {
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        host.layoutSubtreeIfNeeded()
    }
    layout()
    func observer(in view: NSView) -> MessageTimestampClickObserver.ObserverView? {
        if let observer = view as? MessageTimestampClickObserver.ObserverView { return observer }
        return view.subviews.lazy.compactMap { observer(in: $0) }.first
    }
    let clickObserver = try #require(observer(in: host))
    // The observer must be click-through, including on selectable text and buttons.
    #expect(clickObserver.hitTest(NSPoint(x: 10, y: 10)) == nil)
    func point(for key: MessageTimestampKey) throws -> NSPoint {
        for y in stride(from: 10.0, to: 300, by: 5) {
            for x in stride(from: 30.0, to: 480, by: 10) {
                let point = host.convert(NSPoint(x: x, y: y), to: nil)
                if selection.target(at: point, in: window) == key { return point }
            }
        }
        throw NSError(domain: "Missing timestamp target: \(key.rowID), host \(host.bounds)", code: 1)
    }
    func send(_ type: NSEvent.EventType, _ point: NSPoint, clicks: Int = 1) throws {
        let event = try #require(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1,
            clickCount: clicks, pressure: type == .leftMouseDown ? 1 : 0))
        // Exercise the same callback used by the local monitor, without relying on a live
        // application's nextEvent loop. Normal event dispatch is not consumed by this callback.
        clickObserver.observe(event)
    }
    func click(_ point: NSPoint, clicks: Int = 1) throws {
        try send(.leftMouseDown, point, clicks: clicks)
        try send(.leftMouseUp, point, clicks: clicks)
        layout()
    }
    try click(point(for: user))
    #expect(selection.selected == user)
    #expect(!scroll.follow.shouldScrollToBottom)
    try click(point(for: user))
    #expect(selection.selected == nil)
    try click(point(for: user))
    try click(point(for: assistant))
    #expect(selection.selected == assistant)
    try click(host.convert(NSPoint(x: 10, y: 10), to: nil))
    #expect(selection.selected == nil)
    let textPoint = try point(for: assistant)
    try send(.leftMouseDown, textPoint)
    try send(.leftMouseDragged, textPoint)
    try send(.leftMouseUp, textPoint)
    #expect(selection.selected == nil)
    try click(textPoint, clicks: 2)
    #expect(selection.selected == nil)
    clickObserver.stop()
}

@Test @MainActor func timestampSelectionDoesNotLeakAcrossStreamingMessageTimes() {
    let selection = MessageTimestampSelection()
    let old = MessageTimestampKey(rowID: "streaming-0", milliseconds: 1_000)
    let new = MessageTimestampKey(rowID: "streaming-0", milliseconds: 2_000)
    selection.toggle(old)
    #expect(selection.selected != new)
    selection.toggle(new)
    #expect(selection.selected == new)
    selection.toggle(new)
    #expect(selection.selected == nil)
}

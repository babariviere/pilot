import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func messagePencilOnlyRespondsWhenRevealed() async throws {
    _ = NSApplication.shared
    for (hovered, pending, working) in [(false, false, true), (true, false, true),
                                        (true, true, true), (true, false, false)] {
        let rewind = TranscriptRewind()
        rewind.isWorking = { working }
        var performed: [TranscriptRewind.Request] = []
        let work = AsyncStream<Void>.makeStream()
        defer { work.continuation.finish() }
        rewind.perform = { request in
            performed.append(request)
            if pending { for await _ in work.stream {} }
        }
        if pending { rewind.run(.init(action: .restore, entryID: 10)) }
        let host = NSHostingView(rootView:
            MessageEditButton(entryID: 42, rewind: rewind, isHovered: hovered)
                .frame(width: 60, height: 60)
        )
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 60, height: 60),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        window.orderFrontRegardless()
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        let location = host.convert(NSPoint(x: 30, y: 30), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1,
                clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        try await Task.sleep(for: .milliseconds(20))
        #expect(rewind.confirmation == (hovered && !pending && working
            ? TranscriptRewind.Request(action: .edit, entryID: 42) : nil))
        let expected: [TranscriptRewind.Request] = pending ? [.init(action: .restore, entryID: 10)]
            : hovered && !working ? [.init(action: .edit, entryID: 42)] : []
        #expect(performed == expected)
    }
}

@Test @MainActor func messagePencilKeepsItsFootprintWhenHiddenOrDisabled() {
    _ = NSApplication.shared
    var sizes: [NSSize] = []
    for hovered in [false, true] {
        for pending in [false, true] {
            let rewind = TranscriptRewind()
            rewind.perform = { _ in }
            if pending { rewind.run(.init(action: .edit, entryID: 42)) }
            let host = NSHostingView(rootView:
                MessageEditButton(entryID: 42, rewind: rewind, isHovered: hovered)
            )
            host.layoutSubtreeIfNeeded()
            sizes.append(host.fittingSize)
        }
    }
    #expect(sizes.allSatisfy { $0 == NSSize(width: 20, height: 20) })
}

@Test @MainActor func editableLongMessagesKeepTheExistingBoundedColumn() {
    _ = NSApplication.shared
    let rewind = TranscriptRewind()
    let source = String(repeating: "Frame details\n", count: 5000)
    for width in [300.0, 760.0] {
        func size(entryID: Int?) -> NSSize {
            let host = NSHostingView(rootView:
                UserMessage(text: source, entryID: entryID)
                    .environment(\.transcriptRewind, rewind)
                    .fixedSize(horizontal: false, vertical: true).frame(width: width)
            )
            host.frame = NSRect(x: 0, y: 0, width: width, height: 500)
            host.layoutSubtreeIfNeeded()
            return host.fittingSize
        }
        #expect(size(entryID: 42) == size(entryID: nil))
        #expect(size(entryID: 42).height < 220)
    }
}

@Test @MainActor func messagePencilStaysInTheRightMarginOutsideTheBubble() throws {
    _ = NSApplication.shared
    let rewind = TranscriptRewind()
    let selection = MessageTimestampSelection()
    for width in [300.0, 760.0] {
        let key = MessageTimestampKey(rowID: "42-0", milliseconds: 1_700_000_000_000)
        let host = NSHostingView(rootView:
            UserMessage(text: "An editable message", messageID: key.rowID,
                        timestamp: key.milliseconds, entryID: 42)
                .environment(\.transcriptRewind, rewind)
                .environment(\.messageTimestampSelection, selection)
                .frame(width: width)
        )
        // Older NSHostingView versions can resize their window to the root's ideal size.
        // Keep this fixture's viewport fixed, like the transcript's bounded content column.
        host.sizingOptions = []
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 100),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        window.orderFrontRegardless()
        host.layoutSubtreeIfNeeded()
        try #require(abs(host.bounds.width - width) < 0.5)
        func bubbleContains(x: CGFloat) -> Bool {
            (0..<100).contains { y in
                let point = host.convert(NSPoint(x: x, y: CGFloat(y)), to: nil)
                return selection.target(at: point, in: window) == key
            }
        }
        // The bubble stays flush with the column edge. The overlaid 8-point gap and
        // 20-point pencil slot sit outside it and never belong to the timestamp target.
        // Evaluate before macro expansion so every Testing version captures concrete Booleans.
        let edgeIsInBubble = bubbleContains(x: width - 2)
        let gapIsInBubble = bubbleContains(x: width + 4)
        let pencilIsInBubble = bubbleContains(x: width + 18)
        #expect(edgeIsInBubble)
        #expect(gapIsInBubble == false)
        #expect(pencilIsInBubble == false)
    }
}

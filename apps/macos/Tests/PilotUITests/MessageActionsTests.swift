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
            MessageActionBar(text: "hello", milliseconds: nil, trailing: true, entryID: 42, revealed: hovered)
                .environment(\.transcriptRewind, rewind)
        )
        host.layoutSubtreeIfNeeded()
        let size = host.fittingSize
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        window.orderFrontRegardless()
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        // The pencil is the trailing control of a user message's footer.
        let location = host.convert(NSPoint(x: size.width - 10, y: size.height / 2), to: nil)
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

@Test @MainActor func messageFooterKeepsItsFootprintWhenHiddenOrDisabled() {
    _ = NSApplication.shared
    let stamp = 1_781_015_528_123.0
    for trailing in [false, true] {
        var sizes: [NSSize] = []
        for revealed in [false, true] {
            for pending in [false, true] {
                let rewind = TranscriptRewind()
                rewind.perform = { _ in }
                if pending { rewind.run(.init(action: .edit, entryID: 42)) }
                let host = NSHostingView(rootView:
                    MessageActionBar(text: "hello", milliseconds: stamp, trailing: trailing,
                                     entryID: trailing ? 42 : nil, revealed: revealed)
                        .environment(\.transcriptRewind, rewind)
                )
                host.layoutSubtreeIfNeeded()
                sizes.append(host.fittingSize)
            }
        }
        #expect(Set(sizes.map { [$0.width, $0.height] }).count == 1)
        #expect(sizes.first?.height == 20)
    }
}

@Test @MainActor func hoveringAMessageDoesNotReflowTheTranscript() {
    _ = NSApplication.shared
    let rewind = TranscriptRewind()
    func height(revealed: Bool, trailing: Bool) -> CGFloat {
        let host = NSHostingView(rootView:
            VStack(alignment: trailing ? .trailing : .leading, spacing: 4) {
                Text("A message").frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
                MessageActionBar(text: "A message", milliseconds: 1_700_000_000_000, trailing: trailing,
                                 entryID: trailing ? 42 : nil, revealed: revealed)
            }
            .environment(\.transcriptRewind, rewind)
            .frame(width: 400)
        )
        host.layoutSubtreeIfNeeded()
        return host.fittingSize.height
    }
    for trailing in [false, true] {
        #expect(height(revealed: false, trailing: trailing) == height(revealed: true, trailing: trailing))
    }
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
        #expect(size(entryID: 42).height < 250)
    }
}

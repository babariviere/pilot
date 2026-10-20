import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func transcriptHeightCacheReplacesWidthAndRevisionAndIsBounded() {
    var cache = TranscriptHeightCache(limit: 2)
    let first = NativeTranscriptItem.row("first")
    cache.store(42, for: first, width: 700, revision: 1)
    #expect(cache.height(for: first, width: 700, revision: 1) == 42)
    #expect(cache.height(for: first, width: 300, revision: 1) == nil)
    #expect(cache.height(for: first, width: 700, revision: 2) == nil)
    cache.store(80, for: first, width: 300, revision: 2)
    #expect(cache.entries.count == 1)
    cache.store(20, for: .row("second"), width: 300, revision: 1)
    _ = cache.height(for: first, width: 300, revision: 2)
    cache.store(30, for: .row("third"), width: 300, revision: 1)
    #expect(cache.entries.count == 2)
    #expect(cache.entries[.row("second")] == nil)
}

@MainActor private func prepared(_ message: NativeMarkdownMessage, source: String) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while message.preparedSource != source, ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(5))
    }
    #expect(message.preparedSource == source)
}

@Test @MainActor func nativeStreamingMarkdownKeepsTextViewAndMessageSelectionOwner() async throws {
    _ = NSApplication.shared
    let message = NativeMarkdownMessage()
    let selection = MessageTextSelection()
    let first = "## Heading\n\nA **bold** paragraph with a [link](https://example.com)."
    message.update(source: first, timestamp: nil, streaming: true, selection: selection,
                   environment: EnvironmentValues(), changed: {})
    try await prepared(message, source: first)
    let before = message.nativeTextViews
    #expect(before.count == 2)
    let next = first + " More streamed text."
    message.update(source: next, timestamp: nil, streaming: true, selection: selection,
                   environment: EnvironmentValues(), changed: {})
    try await prepared(message, source: next)
    let after = message.nativeTextViews
    #expect(before.count == after.count)
    #expect(before.first === after.first)
    #expect(before.last === after.last)
    #expect(after.allSatisfy { $0.selectionOwner === selection })
    #expect(after.last?.string.hasSuffix("More streamed text.") == true)
    selection.selectAll()
    #expect(selection.selectedText == next)
    let wide = message.measure(width: 700)
    let narrow = message.measure(width: 200)
    #expect(narrow > wide)
    message.stop()
}

@Test @MainActor func nativeMarkdownCancelledBindingDoesNotPublishOldPreparation() async throws {
    _ = NSApplication.shared
    let message = NativeMarkdownMessage()
    var callbacks = 0
    message.update(source: String(repeating: "old **source**\n\n", count: 500), timestamp: nil,
                   streaming: false, selection: MessageTextSelection(), environment: EnvironmentValues(),
                   changed: { callbacks += 1 })
    message.stop()
    await Task.yield()
    #expect(callbacks == 0)
    #expect(message.nativeTextViews.isEmpty)
}

@Test @MainActor func nativeMarkdownSameSourceRegistersEveryRegionWithNewSelectionOwner() async throws {
    _ = NSApplication.shared
    let message = NativeMarkdownMessage()
    let source = "## Heading\n\nParagraph content"
    let old = MessageTextSelection()
    let next = MessageTextSelection()
    message.update(source: source, timestamp: nil, streaming: false, selection: old,
                   environment: EnvironmentValues(), changed: {})
    try await prepared(message, source: source)
    let before = message.nativeTextViews
    let oldFirst = try #require(before.first)
    let oldLast = try #require(before.last)
    old.select(from: .init(key: oldFirst.selectionKey, offset: 1), to: .init(key: oldLast.selectionKey, offset: 4))
    #expect(before.contains { $0.selectedRange().length > 0 })
    message.update(source: source, timestamp: nil, streaming: false, selection: next,
                   environment: EnvironmentValues(), changed: {})
    let views = message.nativeTextViews
    #expect(before.first === views.first)
    #expect(views.allSatisfy { $0.selectionOwner === next })
    #expect(views.allSatisfy { $0.selectedRange().length == 0 })
    let first = try #require(views.first)
    let last = try #require(views.last)
    next.select(from: .init(key: first.selectionKey, offset: 1), to: .init(key: last.selectionKey, offset: 4))
    #expect(next.selectedText == "eading\n\nPara")
    message.stop()
}

@Test @MainActor func nativeExplicitExpansionAnchorsStraddlingRowAtTopNotBottom() {
    let rect = NSRect(x: 0, y: 100, width: 700, height: 300)
    let growth = NativeTranscriptController.Anchor(item: .row("message"), rect: rect, viewportTop: 150, containing: false)
    let expansion = NativeTranscriptController.Anchor(item: .row("message"), rect: rect, viewportTop: 150, containing: true)
    #expect(growth.bottom && growth.offset == 250)
    #expect(!expansion.bottom && expansion.offset == -50)
}

@Test @MainActor func nativeMarkdownHostedTableKeepsLeadingEdgeAcrossWidthChanges() async throws {
    _ = NSApplication.shared
    let source = "| A | B |\n| --- | --- |\n| one | two |"
    let blocks = try await MarkdownRenderer.shared.prepare(source)
    let prepared = try #require(blocks.first)
    let block = NativeMarkdownBlockView()
    let selection = MessageTextSelection()
    block.update(prepared, index: 0, selection: selection, environment: EnvironmentValues(),
                 streaming: false, fadesInitial: false, changed: {})
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 300),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView?.addSubview(block)
    defer { block.stop(); window.close() }
    func table(in view: NSView) -> MarkdownTableView? {
        if let table = view as? MarkdownTableView { return table }
        return view.subviews.lazy.compactMap { table(in: $0) }.first
    }
    for width: CGFloat in [760, 320, 760] {
        block.frame = NSRect(x: 0, y: 0, width: width, height: block.measure(width: width))
        block.layoutSubtreeIfNeeded()
        // Hosting can mount its representable on the next rendering turn even without a key window.
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while table(in: block) == nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
            block.layoutSubtreeIfNeeded()
        }
        try await Task.sleep(for: .milliseconds(10))
        block.frame.size.height = block.measure(width: width)
        block.layoutSubtreeIfNeeded()
        let rendered = try #require(table(in: block))
        let frame = rendered.convert(rendered.bounds, to: block)
        #expect(frame.width < width - 40, "A compact table must not stretch to fill its host.")
        #expect(abs(frame.minX) < 1, "The table must stay leading-aligned at width \(width).")
    }
}

@Test @MainActor func nativeTranscriptResourceIncludesFullHostAndSession() {
    let a = HostRef(hostId: "alias", daemonId: "daemon-a", lineageId: "lineage")
    let b = HostRef(hostId: "alias", daemonId: "daemon-b", lineageId: "lineage")
    #expect(NativeTranscriptResource(sessionID: "chat", host: a) != NativeTranscriptResource(sessionID: "chat", host: b))
    #expect(NativeTranscriptResource(sessionID: "chat", host: a) != NativeTranscriptResource(sessionID: "other", host: a))
}

@Test @MainActor func nativeTranscriptChangesOnlyLiveRowsUntilMembershipChanges() async throws {
    _ = NSApplication.shared
    let processor = TranscriptProcessor()
    let entries: [JSONValue] = (1...1000).map { id in
        .object(["id": .number(Double(id)), "kind": .string("pi.user"),
                 "model": .array([.object(["role": .string("user"), "content": .string("Message \(id)")])])])
    }
    let first = try await processor.apply([.object(["type": .string("snapshot"), "entries": .array(entries)])])
    let controller = NativeTranscriptController()
    let scroll = TranscriptScrollState()
    let tools = TranscriptExpansions()
    let messages = TranscriptExpansions()
    let chrome = UUID()
    func configuration(_ presentation: TranscriptPresentation, session: String = "one", chromeRevision: UUID? = nil) -> NativeTranscript {
        NativeTranscript(presentation: presentation, historyLimit: 40,
            resource: NativeTranscriptResource(sessionID: session, host: nil), scroll: scroll,
            toolExpansions: tools, messageExpansions: messages, environment: EnvironmentValues(),
            header: AnyView(EmptyView()), footer: AnyView(EmptyView()), loadEarlier: {},
            chromeRevision: chromeRevision ?? chrome)
    }
    controller.update(configuration(first))
    #expect(controller.items.count == 43) // 40 historical rows, header, paging control, footer.
    _ = try await processor.apply([.object(["type": .string("message_start"), "message": .object([
        "role": .string("assistant"), "content": .array([.object(["type": .string("text"), "text": .string("")])]),
    ])])])
    func delta(_ value: String) -> JSONValue {
        .object(["type": .string("message_update"), "changes": .array([.object([
            "type": .string("text_delta"), "contentIndex": .number(0), "delta": .string(value),
        ])])])
    }
    let live = try await processor.apply([delta("First")])
    controller.update(configuration(live))
    let membership = controller.membershipUpdates
    let items = controller.items
    let streamed = try await processor.apply([delta(" second")])
    controller.update(configuration(streamed))
    #expect(controller.membershipUpdates == membership)
    #expect(controller.items == items)
    #expect(controller.items.count == 44)
    // The outgoing stand-in can disappear in the same publication that commits a reply. A mounted footer
    // must rebind even though the presentation revision changed too.
    _ = controller.table.view(atColumn: 0, row: controller.items.count - 1, makeIfNecessary: true)
    let bindings = controller.cellBindings
    var committed = streamed
    committed.revision += 1
    controller.update(configuration(committed, chromeRevision: UUID()))
    #expect(controller.cellBindings > bindings)
    // Vertical-only changes (including composer growth) pin without invalidating row measurements.
    controller.scrollView.frame = NSRect(x: 0, y: 0, width: 600, height: 500)
    controller.scrollView.layoutSubtreeIfNeeded()
    controller.resizeViewport()
    controller.pinBottom()
    let measurements = controller.measurements
    controller.scrollView.frame.size.height = 350
    controller.scrollView.layoutSubtreeIfNeeded()
    controller.resizeViewport()
    #expect(abs(controller.table.bounds.maxY - controller.scrollView.contentView.bounds.maxY) < 1)
    #expect(controller.measurements == measurements)
    controller.update(configuration(first, session: "other"))
    #expect(controller.membershipUpdates == membership + 1)
    #expect(controller.items.count == 43)
    controller.stop()
    #expect(scroll.pinBottom == nil)
    #expect(scroll.focusTranscript == nil)
}

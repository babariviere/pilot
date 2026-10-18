import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@MainActor private func loadingWindow() -> NSWindow {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    return window
}

private func loadingEntry(_ id: Int, assistant: Bool = false) -> JSONValue {
    .object([
        "id": .number(Double(id)), "kind": .string(assistant ? "pi.assistant" : "pi.user"),
        "model": .array([.object([
            "role": .string(assistant ? "assistant" : "user"), "content": .string("Message \(id)"),
        ])]),
    ])
}

private struct LoadingTranscript: View {
    @ObservedObject var feed: SessionFeed
    let scroll: TranscriptScrollState
    var loadingEarlier = false
    var earlierError: String?
    let tools = TranscriptExpansions()
    let messages = TranscriptExpansions()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                TranscriptRowsSection(model: feed.rows, toolExpansions: tools, messageExpansions: messages,
                                      hasSnapshot: feed.hasSnapshot, loadingEarlier: loadingEarlier,
                                      earlierError: earlierError)
                Color.clear.frame(height: 1).id("bottom")
            }
            .padding(24)
            .background(TranscriptScrollObserver(state: scroll))
        }
    }
}

@MainActor private func settleLoading(_ host: NSView, until ready: () -> Bool = { true }) async throws {
    // Drive native layout too. A headless window does not get the app's normal display passes.
    for pass in 0..<120 {
        host.layoutSubtreeIfNeeded()
        host.window?.update()
        try await Task.sleep(for: .milliseconds(20))
        if pass >= 11, ready() { return }
    }
}

@MainActor private func loadingAnchors(_ host: NSView) -> [TranscriptRowAnchorView] {
    TranscriptRowAnchorView.rows.allObjects.filter { $0.window === host.window }
}

@Test(arguments: [2, 1_000]) @MainActor
func initialChatMessagesPaintWithBoundedMeasuredHistory(count: Int) async throws {
    let feed = SessionFeed(sessionId: "synthetic-loading", transcript: Transcript())
    let window = loadingWindow()
    defer { feed.stop(); window.close() }
    let host = NSHostingView(rootView: LoadingTranscript(feed: feed, scroll: TranscriptScrollState()))
    window.contentView = host
    host.layoutSubtreeIfNeeded()

    // First open starts empty. The idle snapshot includes a final assistant reply, not a live generation.
    feed.applyFixtureEvents([.object([
        "type": .string("snapshot"),
        "entries": .array((1...count).map { loadingEntry($0, assistant: $0 == count) }),
    ])])
    try await settleLoading(host, until: { feed.presentation.rows.count == count })
    #expect(feed.hasSnapshot && !feed.status.working && feed.status.hasRows)
    #expect(feed.rows.visibleHistory.count == min(count, TranscriptRowsModel.historyPageSize))
    #expect(loadingAnchors(host).count == min(count, TranscriptRowsModel.historyPageSize))
    let last = try #require(loadingAnchors(host).first { $0.rowID == "\(count)-0-0" })
    #expect(last.bounds.height > 0)
    #expect(last.convert(last.bounds, to: host).intersects(host.bounds), "the answer is inside the viewport")
    let displayed = feed.rows.visibleRows
    feed.applyFixtureEvents([.object([
        "type": .string("entry_appended"), "entry": loadingEntry(count + 1, assistant: true),
    ])])
    try await settleLoading(host, until: { feed.presentation.rows.count == count + 1 })
    #expect(feed.rows.visibleRows.prefix(displayed.count).elementsEqual(displayed),
            "new replies do not evict messages the reader already displayed")
}

@Test @MainActor func earlierHistoryRevealsPreparedRowsBeforeRequestingStorage() {
    var presentation = TranscriptPresentation()
    presentation.rows = (1...1_000).map { .text(id: "\($0)", text: "Message \($0)") }
    presentation.earlierCursor = 6
    let model = TranscriptRowsModel(presentation)
    let first = model.visibleRows
    #expect(model.hasHiddenHistory)
    #expect(model.revealEarlier(), "no storage request while a prepared page is hidden")
    #expect(model.visibleRows.count == 2 * TranscriptRowsModel.historyPageSize)
    #expect(model.visibleRows.suffix(first.count).elementsEqual(first))
    // Keyboard navigation uses exactly the rendered rows, never hidden scroll targets.
    #expect(model.visibleRows.first?.id == "921")
    for _ in 0..<25 where model.hasHiddenHistory { #expect(model.revealEarlier()) }
    #expect(!model.hasHiddenHistory)
    #expect(!model.revealEarlier(), "only now is the server's earlier cursor needed")
    #expect(model.visibleRows.count == 1_000)
    model.resetHistoryWindow()
    #expect(model.visibleHistory.count == TranscriptRowsModel.historyPageSize)
}

@Test @MainActor func splitSnapshotPrefixesDoNotEagerlyOpenTheWholeHistory() async throws {
    let feed = SessionFeed(sessionId: "synthetic-split", transcript: Transcript())
    defer { feed.stop() }
    let host = NSView()
    feed.applyFixtureEvents([.object([
        "type": .string("snapshot"), "prefixPending": .bool(true),
        "entries": .array([loadingEntry(999), loadingEntry(1_000, assistant: true)]),
    ])])
    try await settleLoading(host, until: { feed.presentation.historyRowCount == 2 })
    #expect(feed.rows.visibleHistory.count == 2)
    feed.applyFixtureEvents([.object([
        "type": .string("snapshot_prefix"), "entries": .array((1...998).map { loadingEntry($0) }),
    ])])
    try await settleLoading(host, until: { feed.presentation.historyRowCount == 1_000 })
    #expect(feed.rows.visibleHistory.count == TranscriptRowsModel.historyPageSize)
    #expect(feed.rows.hasHiddenHistory)
    #expect(feed.rows.visibleRows.last?.id == "1000-0-0")
}

@Test @MainActor func measuredHistoryDoesNotVanishWhenMessageHeightsShrink() async throws {
    let window = loadingWindow()
    defer { window.close() }
    let expansions = TranscriptExpansions()
    let rows: [ChatRow] = (1...TranscriptRowsModel.historyPageSize).map { index in
        let id = "\(index)-0"
        expansions.state(for: id).expanded = true
        return .user(id: id, text: String(repeating: "Recorded details for message \(index).\n", count: 120))
    }
    let scroll = TranscriptScrollState()
    let host = NSHostingView(rootView: ScrollView {
        VStack(spacing: 16) {
            Text("Show earlier messages")
            TranscriptHistoryRows(revision: UUID(), rows: rows[...], messageExpansions: expansions).equatable()
            Color.clear.frame(height: 1)
        }
        .padding(24)
        .background(TranscriptScrollObserver(state: scroll))
    })
    window.contentView = host
    try await settleLoading(host)
    #expect(loadingAnchors(host).count == rows.count)
    // A large reduction in realized row height used to leave the lazy stack's estimated bottom
    // outside every message. Assert actual native row geometry, not just nonempty reducer output.
    for row in rows { expansions.state(for: row.id).expanded = false }
    try await settleLoading(host)
    let last = try #require(loadingAnchors(host).first { $0.rowID == rows.last?.id })
    #expect(last.bounds.height > 0)
    #expect(last.convert(last.bounds, to: host).intersects(host.bounds))
    #expect(loadingAnchors(host).count == rows.count)
}

@Test(arguments: [false, true]) @MainActor
func pendingOrFailedEarlierLoadsKeepMessagesVisible(failed: Bool) async throws {
    var transcript = Transcript()
    transcript.apply(.object([
        "type": .string("snapshot"), "entries": .array([
            loadingEntry(6),
            .object(["id": .number(9), "kind": .string("pi.compaction"), "head": .number(6)]),
            loadingEntry(10, assistant: true),
        ]),
    ]))
    let feed = SessionFeed(sessionId: "synthetic-load-status", transcript: transcript)
    let window = loadingWindow()
    defer { feed.stop(); window.close() }
    let host = NSHostingView(rootView: LoadingTranscript(feed: feed, scroll: TranscriptScrollState(),
        loadingEarlier: !failed, earlierError: failed ? "Synthetic history read failed" : nil))
    window.contentView = host
    try await settleLoading(host)
    #expect(loadingAnchors(host).count == 3)
    let reply = try #require(loadingAnchors(host).first { $0.rowID == "10-0-0" })
    #expect(reply.bounds.height > 0)
    #expect(reply.convert(reply.bounds, to: host).intersects(host.bounds))
}

@Test @MainActor func loadingEarlierStoragePagesKeepsExistingMessagesPainted() async throws {
    let snapshot: JSONValue = .object([
        "type": .string("snapshot"), "entries": .array([
            loadingEntry(6),
            .object(["id": .number(9), "kind": .string("pi.compaction"), "head": .number(6)]),
        ] + (10...20).map { loadingEntry($0, assistant: $0 == 20) }),
    ])
    let feed = SessionFeed(sessionId: "synthetic-earlier", transcript: Transcript())
    let window = loadingWindow()
    defer { feed.stop(); window.close() }
    let scroll = TranscriptScrollState()
    let host = NSHostingView(rootView: LoadingTranscript(feed: feed, scroll: scroll))
    window.contentView = host
    // Seed the live reducer too, not just the static preview presentation. Otherwise the first
    // history-page event is reduced against an empty transcript and publishes empty rows.
    feed.applyFixtureEvents([snapshot])
    try await settleLoading(host, until: { feed.presentation.earlierCursor == 6 })
    let previous = feed.rows.visibleRows
    let anchor = try #require(loadingAnchors(host).first { $0.rowID == "6-0" })
    scroll.follow.pauseFollowing()
    func findObserver(_ view: NSView) -> ScrollObserverView? {
        if let observer = view as? ScrollObserverView { return observer }
        return view.subviews.compactMap(findObserver).first
    }
    let observer = try #require(findObserver(host))
    let nativeScroll = try #require(observer.enclosingScrollView)
    nativeScroll.contentView.scroll(to: .zero)
    observer.captureAnchor()
    let before = anchor.convert(anchor.bounds, to: host).minY
    #expect(feed.presentation.earlierCursor == 6)
    #expect(!feed.rows.revealEarlier())
    // While an HTTP request is pending (or fails), no replacement/empty transcript is published.
    #expect(feed.rows.visibleRows == previous)
    feed.applyFixtureEvents([Transcript.earlierEntries(before: 6, page: .object([
        "entries": .array((1...5).map { loadingEntry($0) }), "more": .bool(false),
    ]))])
    try await settleLoading(host, until: {
        feed.presentation.earlierCursor == nil && feed.rows.visibleRows.first?.id == "1-0"
    })
    #expect(feed.presentation.earlierCursor == nil)
    #expect(feed.rows.visibleRows.suffix(previous.count).elementsEqual(previous))
    #expect(feed.rows.visibleRows.first?.id == "1-0")
    #expect(loadingAnchors(host).count == feed.rows.visibleHistory.count)
    #expect(abs(anchor.convert(anchor.bounds, to: host).minY - before) <= 1,
            "prepending a page preserves the reader's current message")
    #expect(anchor.convert(anchor.bounds, to: host).intersects(host.bounds))
    // A late duplicate page must not blank or duplicate any displayed rows.
    let loaded = feed.rows.visibleRows
    feed.applyFixtureEvents([Transcript.earlierEntries(before: 6, page: .object([
        "entries": .array([]), "more": .bool(false),
    ]))])
    try await settleLoading(host)
    #expect(feed.rows.visibleRows == loaded)
}

import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func readCacheCoalescesAndExpiresWithoutCachingFailures() async throws {
    var now = Date(timeIntervalSince1970: 100)
    let cache = AsyncReadCache<String, Int>(ttl: 5, now: { now })
    var release: CheckedContinuation<Int, Never>?
    var loads = 0
    let first = Task { @MainActor in
        try await cache.value(for: "s") {
            loads += 1
            return await withCheckedContinuation { release = $0 }
        }
    }
    while release == nil { await Task.yield() }
    let second = Task { @MainActor in try await cache.value(for: "s") { loads += 1; return 99 } }
    await Task.yield()
    release?.resume(returning: 7)
    #expect(try await first.value == 7)
    #expect(try await second.value == 7)
    #expect(loads == 1)
    #expect(try await cache.value(for: "s") { 99 } == 7)
    now = now.addingTimeInterval(6)
    #expect(try await cache.value(for: "s") { loads += 1; return 8 } == 8)
    #expect(loads == 2)
    cache.invalidate("s")
    do {
        _ = try await cache.value(for: "s") { throw CancellationError() }
        Issue.record("Expected load failure")
    } catch is CancellationError {}
    #expect(try await cache.value(for: "s") { 9 } == 9)
}

@Test @MainActor func invalidatedInFlightReadCannotOverwriteNewerCacheValue() async throws {
    let cache = AsyncReadCache<String, Int>(ttl: 10)
    var release: CheckedContinuation<Int, Never>?
    let old = Task { @MainActor in
        try await cache.value(for: "s") { await withCheckedContinuation { release = $0 } }
    }
    while release == nil { await Task.yield() }
    cache.invalidate("s")
    #expect(try await cache.value(for: "s") { 2 } == 2)
    release?.resume(returning: 1)
    #expect(try await old.value == 1)
    #expect(try await cache.value(for: "s") { 3 } == 2)
}

@Test @MainActor func cancellingOneCacheReaderLeavesOtherReadersAlive() async throws {
    let cache = AsyncReadCache<String, Int>(ttl: 10)
    var release: CheckedContinuation<Int, Never>?
    let first = Task { @MainActor in
        try await cache.value(for: "s") { await withCheckedContinuation { release = $0 } }
    }
    while release == nil { await Task.yield() }
    let second = Task { @MainActor in try await cache.value(for: "s") { 99 } }
    while cache.readerCount(for: "s") != 2 { await Task.yield() }
    first.cancel()
    do {
        _ = try await first.value
        Issue.record("Expected cancelled reader")
    } catch is CancellationError {}
    #expect(cache.readerCount(for: "s") == 1)
    release?.resume(returning: 42)
    #expect(try await second.value == 42)
}

@Test @MainActor func cancellingLastCacheReaderCancelsUnderlyingAdmission() async throws {
    let cache = AsyncReadCache<String, Int>(ttl: 10)
    var started = false
    var cancelled = false
    let reader = Task { @MainActor in
        try await cache.value(for: "s") {
            started = true
            do { try await Task.sleep(for: .seconds(3600)) }
            catch { cancelled = true; throw error }
            return 0
        }
    }
    while !started { await Task.yield() }
    reader.cancel()
    do { _ = try await reader.value; Issue.record("Expected cancellation") }
    catch is CancellationError {}
    while !cancelled { await Task.yield() }
    #expect(cache.readerCount(for: "s") == 0)
    #expect(try await cache.value(for: "s") { 33 } == 33)
}

@Test @MainActor func cancelledRepositoryWaiterExitsBeforeActiveRequestFinishes() async throws {
    let limiter = RepositoryRequestLimiter(limit: 1)
    var release: CheckedContinuation<Void, Never>?
    let active = Task { @MainActor in
        try await limiter.perform { await withCheckedContinuation { release = $0 } }
    }
    while release == nil { await Task.yield() }
    var ran = false
    let queued = Task { @MainActor in try await limiter.perform { ran = true } }
    await Task.yield()
    queued.cancel()
    do {
        try await queued.value
        Issue.record("Expected cancelled waiter")
    } catch is CancellationError {}
    #expect(!ran)
    release?.resume()
    try await active.value
    #expect(try await limiter.perform { 42 } == 42)
}

@Test @MainActor func sessionPresentationCacheIsLRUAndByteBounded() {
    let client = PilotClient()
    let cache = SessionFeedCache(countLimit: 2)
    let a = cache.feed(sessionId: "a", client: client)
    _ = cache.feed(sessionId: "b", client: client)
    #expect(cache.feed(sessionId: "a", client: client) === a)
    _ = cache.feed(sessionId: "c", client: client)
    #expect(cache.count == 2)
    #expect(cache.contains("a") && cache.contains("c") && !cache.contains("b"))
    var presentation = TranscriptPresentation()
    presentation.rows = [.text(id: "large", text: String(repeating: "x", count: 10_000))]
    let large = SessionFeed(sessionId: "large", client: client, initialPresentation: presentation)
    let small = SessionFeedCache(byteLimit: 1024)
    small.retain(large, sessionId: "large")
    #expect(small.count == 0)
}

@Test @MainActor func cachedRowsPaintWithoutAuthorizingStaleQueueOrReview() {
    var presentation = TranscriptPresentation()
    presentation.rows = [.text(id: "1", text: "cached")]
    presentation.working = true
    presentation.streaming = true
    presentation.retry = "old retry"
    presentation.error = "old error"
    let feed = SessionFeed(sessionId: "s", client: PilotClient(), initialPresentation: presentation)
    feed.start()
    #expect(feed.presentation.rows == presentation.rows)
    #expect(!feed.loading && !feed.hasSnapshot)
    #expect(!feed.presentation.working && !feed.presentation.streaming)
    #expect(feed.presentation.retry == nil && feed.presentation.error == nil)
    #expect(feed.presentation.queuedMessages.isEmpty)
    feed.stop()
    #expect(!feed.isSubscribed)
}

@Test func preparedMarkdownPreservesInlineTextAndCodeVerbatim() async throws {
    let renderer = MarkdownRenderer(byteLimit: 1024, countLimit: 2)
    let source = "# Heading\n\n**bold** text\n\n- one\n- two\n\n```js\nconst answer = 42;\n```"
    let blocks = try await renderer.prepare(source)
    #expect(blocks.map(\.block) == Markdown.parse(source))
    #expect(String(blocks[1].inline!.characters) == "bold text")
    #expect(blocks[2].items.map { String($0.characters) } == ["one", "two"])
    #expect(String(blocks[3].code!.characters) == "const answer = 42;")
    let again = try await renderer.prepare(source)
    #expect(again.map(\.block) == blocks.map(\.block))
    let plain = try await renderer.prepareCode("hello", language: nil)
    #expect(String(plain.characters) == "hello")
}

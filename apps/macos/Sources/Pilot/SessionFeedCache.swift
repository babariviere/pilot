import Foundation
import PilotCore

/// Retain only a bounded set of prepared conversations, never background subscriptions.
@MainActor
final class SessionFeedCache {
    private struct Entry {
        let feed: SessionFeed
        var lastUse: Int
    }
    private var entries: [String: Entry] = [:]
    private var clock = 0
    let countLimit: Int
    let byteLimit: Int

    init(countLimit: Int = 8, byteLimit: Int = 16 * 1024 * 1024) {
        self.countLimit = max(1, countLimit)
        self.byteLimit = max(0, byteLimit)
    }

    func feed(sessionId: String, client: PilotClient) -> SessionFeed {
        if let existing = entries[sessionId]?.feed {
            touch(sessionId)
            return existing
        }
        let feed = SessionFeed(sessionId: sessionId, client: client)
        retain(feed, sessionId: sessionId)
        return feed
    }

    func retain(_ feed: SessionFeed, sessionId: String) {
        clock += 1
        entries[sessionId] = Entry(feed: feed, lastUse: clock)
        feed.onPresentationChanged = { [weak self] in self?.trim() }
        trim()
    }

    private func touch(_ id: String) {
        clock += 1
        entries[id]?.lastUse = clock
    }

    func trim() {
        var bytes = entries.values.reduce(0) { $0 + $1.feed.cachedByteCount }
        while entries.count > countLimit || bytes > byteLimit {
            guard let victim = entries.filter({ !$0.value.feed.isSubscribed })
                .min(by: { $0.value.lastUse < $1.value.lastUse }) else { break }
            bytes -= victim.value.feed.cachedByteCount
            entries.removeValue(forKey: victim.key)
        }
    }

    var count: Int { entries.count }
    func contains(_ id: String) -> Bool { entries[id] != nil }
}

/// Ownership without forwarding draft changes to the transcript's observation boundary.
@MainActor
final class ChatComposerOwner: ObservableObject {
    let state: ComposerState
    init(_ state: ComposerState) { self.state = state }
}

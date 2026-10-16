import Foundation
import PilotCore
import SwiftUI

struct PreparedMarkdownBlock: Sendable {
    /// Unique per preparation. A block kept from an earlier preparation keeps its ID, so views can skip it.
    let id: Int
    let block: MarkdownBlock
    let inline: AttributedString?
    let items: [AttributedString]
    let code: AttributedString?
}

/// Parsing, inline Markdown and lexical highlighting never run from a view body.
/// Source-keyed caches are bounded, and font choices remain a live view environment concern.
/// A streaming message is prepared incrementally: blocks before its last block boundary are final and kept,
/// so each update parses and styles only the text after that boundary.
actor MarkdownRenderer {
    static let shared = MarkdownRenderer()
    private struct CodeKey: Hashable {
        let language: String?
        let text: String
    }
    private struct Entry<Value> {
        let value: Value
        let cost: Int
        var order: Int
    }
    /// One streaming message: its incremental parser, its prepared final blocks and its last prepared tail.
    private struct Stream {
        var parser = MarkdownStream()
        var stable: [PreparedMarkdownBlock] = []
        var tail: [PreparedMarkdownBlock] = []
        var order = 0
    }
    private var markdown: [String: Entry<[PreparedMarkdownBlock]>] = [:]
    private var code: [CodeKey: Entry<AttributedString>] = [:]
    /// Few messages stream at once; a fixed small count bounds the retained parsers.
    private var streams: [Stream] = []
    private let streamLimit = 2
    private var order = 0
    private var nextBlockID = 0
    private let byteLimit: Int
    private let countLimit: Int

    init(byteLimit: Int = 8 * 1024 * 1024, countLimit: Int = 64) {
        self.byteLimit = max(0, byteLimit)
        self.countLimit = max(1, countLimit)
    }

    /// `streaming` marks a message that grows by appending: it keeps incremental state for the next update instead
    /// of caching every prefix. A finished message still reuses a stream it extends, without changing it.
    func prepare(_ text: String, streaming: Bool = false) throws -> [PreparedMarkdownBlock] {
        try Task.checkCancellation()
        order += 1
        if var entry = markdown[text] {
            entry.order = order
            markdown[text] = entry
            return entry.value
        }
        let extended = streams.indices.filter { text.utf8.starts(with: streams[$0].parser.source.utf8) }
            .max { streams[$0].parser.source.utf8.count < streams[$1].parser.source.utf8.count }
        if streaming {
            return try StreamingTrace.measure(.markdownPrepare) { try prepareStream(text, at: extended, keep: true) }
        }
        let result = try StreamingTrace.measure(.markdownPrepare) {
            // The committed text of a message that just streamed: reuse its final blocks.
            if let extended, streams[extended].parser.stableLength > 0 {
                return try prepareStream(text, at: extended, keep: false)
            }
            return try Markdown.parse(text).map(prepareBlock)
        }
        let cost = text.utf8.count * 8 + result.count * 256
        if cost <= byteLimit { markdown[text] = Entry(value: result, cost: cost, order: order) }
        trim(&markdown)
        return result
    }

    /// Prepares only blocks that became final since the stream's last update, plus the tail. Tail blocks equal to the
    /// previous tail's keep their preparation. The stream changes only once everything succeeded, so a cancelled
    /// update leaves it consistent for the next one.
    private func prepareStream(_ text: String, at index: Int?, keep: Bool) throws -> [PreparedMarkdownBlock] {
        var stream = index.map { streams[$0] } ?? Stream()
        let previousTail = stream.tail
        let previousStableCount = stream.parser.stableBlocks.count
        stream.parser.update(text)
        // Blocks that were in the old tail and are now final often have not changed.
        var reusable = previousTail[...]
        func prepared(_ block: MarkdownBlock) throws -> PreparedMarkdownBlock {
            if let first = reusable.first, first.block == block {
                reusable = reusable.dropFirst()
                return first
            }
            reusable = []
            return try prepareBlock(block)
        }
        if stream.parser.stableBlocks.count < previousStableCount { stream.stable = [] }
        for block in stream.parser.stableBlocks.dropFirst(stream.stable.count) {
            stream.stable.append(try prepared(block))
        }
        stream.tail = try stream.parser.tailBlocks.map(prepared)
        guard keep else { return stream.stable + stream.tail }
        stream.order = order
        if let index {
            streams[index] = stream
        } else {
            if streams.count >= streamLimit, let oldest = streams.indices.min(by: { streams[$0].order < streams[$1].order }) {
                streams.remove(at: oldest)
            }
            streams.append(stream)
        }
        return stream.stable + stream.tail
    }

    private func prepareBlock(_ block: MarkdownBlock) throws -> PreparedMarkdownBlock {
        try Task.checkCancellation()
        let attributed: AttributedString?
        var items: [AttributedString] = []
        var highlighted: AttributedString?
        switch block {
        case let .heading(_, text), let .paragraph(text), let .quote(text): attributed = inline(text)
        case let .list(_, _, values):
            attributed = nil
            items = try values.map { try Task.checkCancellation(); return inline($0) }
        case let .code(language, text):
            attributed = nil
            highlighted = try prepareCode(text, language: language)
        default: attributed = nil
        }
        nextBlockID += 1
        return PreparedMarkdownBlock(id: nextBlockID, block: block, inline: attributed, items: items, code: highlighted)
    }

    func prepareCode(_ text: String, language: String?) throws -> AttributedString {
        try Task.checkCancellation()
        let key = CodeKey(language: language, text: text)
        order += 1
        if var entry = code[key] {
            entry.order = order
            code[key] = entry
            return entry.value
        }
        var result = AttributedString()
        for token in CodeSyntax.tokens(text, language: language) {
            try Task.checkCancellation()
            var part = AttributedString(token.text)
            part.foregroundColor = Theme.syntaxColor(token.kind)
            result.append(part)
        }
        let cost = text.utf8.count * 8 + 256
        if cost <= byteLimit { code[key] = Entry(value: result, cost: cost, order: order) }
        trim(&code)
        return result
    }

    private func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        let parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        return ServiceLinks.detecting(in: parsed)
    }

    func preparePlainText(_ text: String) -> AttributedString {
        ServiceLinks.detecting(in: AttributedString(text))
    }

    private func trim<Key, Value>(_ entries: inout [Key: Entry<Value>]) {
        var bytes = entries.values.reduce(0) { $0 + $1.cost }
        while entries.count > countLimit || bytes > byteLimit {
            guard let oldest = entries.min(by: { $0.value.order < $1.value.order }) else { break }
            bytes -= oldest.value.cost
            entries[oldest.key] = nil
        }
    }
}

@MainActor
final class MarkdownRenderState: ObservableObject {
    let selection = MessageTextSelection()
    @Published var blocks: [PreparedMarkdownBlock] = []
    @Published var highlighted: AttributedString?
    var source: String?

    init() {}

    /// Lazy transcript rows are rebuilt whenever they scroll back into view. Seeding from the
    /// main-actor cache gives them their final height on the first frame instead of 0 points.
    init(markdown text: String) {
        selection.source = text
        if let blocks = PreparedMarkdownCache.shared.blocks(for: text) {
            self.blocks = blocks
            source = text
        }
    }
}

/// Synchronous, bounded mirror of prepared Markdown for views being recreated on the main actor.
@MainActor
final class PreparedMarkdownCache {
    static let shared = PreparedMarkdownCache()
    private struct Entry {
        let blocks: [PreparedMarkdownBlock]
        let cost: Int
        var order: Int
    }
    private var entries: [String: Entry] = [:]
    private var bytes = 0
    private var order = 0
    private let byteLimit: Int
    private let countLimit: Int

    init(byteLimit: Int = 32 * 1024 * 1024, countLimit: Int = 512) {
        self.byteLimit = max(0, byteLimit)
        self.countLimit = max(1, countLimit)
    }

    var count: Int { entries.count }

    func blocks(for text: String) -> [PreparedMarkdownBlock]? {
        guard var entry = entries[text] else { return nil }
        order += 1
        entry.order = order
        entries[text] = entry
        return entry.blocks
    }

    /// A streaming view replaces its previous prefix, so token updates do not evict history.
    func store(_ blocks: [PreparedMarkdownBlock], for text: String, replacing previous: String? = nil) {
        if let previous, previous != text, let old = entries.removeValue(forKey: previous) { bytes -= old.cost }
        let cost = text.utf8.count * 8 + blocks.count * 256
        guard cost <= byteLimit else { return }
        order += 1
        if let previous = entries[text] { bytes -= previous.cost }
        entries[text] = Entry(blocks: blocks, cost: cost, order: order)
        bytes += cost
        while entries.count > countLimit || bytes > byteLimit {
            guard let oldest = entries.min(by: { $0.value.order < $1.value.order }) else { break }
            bytes -= oldest.value.cost
            entries[oldest.key] = nil
        }
    }
}

private struct TranscriptContentPreparedKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var transcriptContentPrepared: (() -> Void)? {
        get { self[TranscriptContentPreparedKey.self] }
        set { self[TranscriptContentPreparedKey.self] = newValue }
    }
}

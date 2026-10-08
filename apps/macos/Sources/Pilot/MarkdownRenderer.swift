import Foundation
import PilotCore
import SwiftUI

struct PreparedMarkdownBlock: Sendable {
    let block: MarkdownBlock
    let inline: AttributedString?
    let items: [AttributedString]
    let code: AttributedString?
}

/// Parsing, inline Markdown and lexical highlighting never run from a view body.
/// Source-keyed caches are bounded, and font choices remain a live view environment concern.
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
    private var markdown: [String: Entry<[PreparedMarkdownBlock]>] = [:]
    private var code: [CodeKey: Entry<AttributedString>] = [:]
    private var order = 0
    private let byteLimit: Int
    private let countLimit: Int

    init(byteLimit: Int = 8 * 1024 * 1024, countLimit: Int = 64) {
        self.byteLimit = max(0, byteLimit)
        self.countLimit = max(1, countLimit)
    }

    func prepare(_ text: String) throws -> [PreparedMarkdownBlock] {
        try Task.checkCancellation()
        order += 1
        if var entry = markdown[text] {
            entry.order = order
            markdown[text] = entry
            return entry.value
        }
        let result = try Markdown.parse(text).map { block -> PreparedMarkdownBlock in
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
            return PreparedMarkdownBlock(block: block, inline: attributed, items: items, code: highlighted)
        }
        let cost = text.utf8.count * 8 + result.count * 256
        if cost <= byteLimit { markdown[text] = Entry(value: result, cost: cost, order: order) }
        trim(&markdown)
        return result
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
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
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
    @Published var blocks: [PreparedMarkdownBlock] = []
    @Published var highlighted: AttributedString?
    var source: String?
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

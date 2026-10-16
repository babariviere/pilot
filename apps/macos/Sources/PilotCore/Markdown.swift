import Foundation

public enum MarkdownDiagramKind: String, Equatable, Sendable {
    case svg, mermaid
}

/// Block-level Markdown, enough for agent answers: headings, paragraphs, lists, fenced code and diagrams,
/// quotes, rules and tables. Inline syntax is left to `AttributedString(markdown:)`.
public enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case list(ordered: Bool, start: Int, items: [String])
    case code(language: String?, text: String)
    case diagram(kind: MarkdownDiagramKind, text: String)
    case quote(String)
    case table([String])
    case rule
}

public enum Markdown {
    public static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var list: (ordered: Bool, start: Int, items: [String])?
        var quote: [String] = []
        var table: [String] = []
        var code: (language: String?, fenceLength: Int)?
        var codeLines: [String] = []

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
            if let current = list { blocks.append(.list(ordered: current.ordered, start: current.start, items: current.items)) }
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))) }
            if !table.isEmpty { blocks.append(.table(table)) }
            paragraph = []
            list = nil
            quote = []
            table = []
        }

        for rawLine in source.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if let current = code {
                let ticks = line.prefix { $0 == "`" }.count
                if ticks >= current.fenceLength, line.dropFirst(ticks).isEmpty {
                    let text = codeLines.joined(separator: "\n")
                    let token = current.language?.split(whereSeparator: { $0.isWhitespace }).first?.lowercased()
                    if let token, let kind = MarkdownDiagramKind(rawValue: token) {
                        blocks.append(.diagram(kind: kind, text: text))
                    } else {
                        blocks.append(.code(language: current.language, text: text))
                    }
                    code = nil
                    codeLines.removeAll(keepingCapacity: true)
                } else {
                    // Keep lines separate from the fence metadata to avoid a COW array
                    // copy on every append when unwrapping the optional fence.
                    codeLines.append(rawLine)
                }
                continue
            }
            let ticks = line.prefix { $0 == "`" }.count
            if ticks >= 3, !line.dropFirst(ticks).contains("`") {
                flush()
                let language = line.dropFirst(ticks).trimmingCharacters(in: .whitespacesAndNewlines)
                code = (language.isEmpty ? nil : language, ticks)
                continue
            }
            if line.isEmpty {
                flush()
                continue
            }
            if let heading = headingLevel(line) {
                flush()
                blocks.append(.heading(level: heading, text: line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)))
                continue
            }
            if line == "---" || line == "***" || line == "___" {
                flush()
                blocks.append(.rule)
                continue
            }
            if line.hasPrefix("|") {
                if table.isEmpty { flush() }
                // Skip the header separator row (|---|:---:|).
                if !line.allSatisfy({ "|-: ".contains($0) }) { table.append(line) }
                continue
            }
            if line.hasPrefix(">") {
                if quote.isEmpty { flush() }
                quote.append(String(line.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }
            if let item = listItem(line) {
                if list == nil || list?.ordered != item.ordered {
                    flush()
                    list = (item.ordered, item.number, [])
                }
                list?.items.append(item.text)
                continue
            }
            if var current = list, rawLine.first == " " || rawLine.first == "\t", !current.items.isEmpty {
                // Indented continuation of the last item.
                current.items[current.items.count - 1] += "\n" + line
                list = current
                continue
            }
            if list != nil || !quote.isEmpty || !table.isEmpty { flush() }
            paragraph.append(line)
        }
        if let current = code {
            // Unterminated fence, typically while streaming.
            flush()
            blocks.append(.code(language: current.language, text: codeLines.joined(separator: "\n")))
        } else {
            flush()
        }
        return blocks
    }

    static func isHeading(_ line: String) -> Bool { headingLevel(line) != nil }

    private static func headingLevel(_ line: String) -> Int? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1 ... 6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return hashes
    }

    private static func listItem(_ line: String) -> (ordered: Bool, number: Int, text: String)? {
        for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) {
            return (false, 1, String(line.dropFirst(2)))
        }
        let digits = line.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count <= 4 {
            let rest = line.dropFirst(digits.count)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") {
                return (true, Int(digits) ?? 1, String(rest.dropFirst(2)))
            }
        }
        return nil
    }
}

/// Parses a message that only grows by appending, such as a streamed reply, in time proportional to the new text.
/// A blank line, a closing fence, a heading or a rule outside a code fence ends every open block, so the blocks
/// before the last such line are final and later text cannot change them. Each update scans only the new lines
/// and parses again only the text after that boundary. `blocks` always equals `Markdown.parse(source)`.
public struct MarkdownStream: Sendable {
    public private(set) var source = ""
    /// Final blocks: everything before `stableLength`.
    public private(set) var stableBlocks: [MarkdownBlock] = []
    /// UTF-8 length of the final prefix, which ends just after a boundary line.
    public private(set) var stableLength = 0
    /// Blocks after the final prefix, parsed again on every update.
    public private(set) var tailBlocks: [MarkdownBlock] = []
    /// UTF-8 bytes handed to `Markdown.parse` so far, for cost regressions.
    public private(set) var parsedByteCount = 0
    /// Start of the first line not yet scanned (it has no newline yet), and the fence open before it.
    private var scanned = 0
    private var fence: Int?

    public init() {}

    public var blocks: [MarkdownBlock] { stableBlocks + tailBlocks }

    /// Takes the message's current text. Text that does not extend the previous source starts over.
    public mutating func update(_ text: String) {
        let utf8 = text.utf8
        if utf8.count < source.utf8.count || !utf8.starts(with: source.utf8) { self = MarkdownStream() }
        source = text
        var boundary = stableLength
        var lineStart = scanned
        var index = utf8.index(utf8.startIndex, offsetBy: scanned)
        var offset = scanned
        while let newline = utf8[index...].firstIndex(of: UInt8(ascii: "\n")) {
            let distance = utf8.distance(from: index, to: newline)
            let lineEnd = offset + distance
            let line = String(decoding: utf8[utf8.index(utf8.startIndex, offsetBy: lineStart) ..< newline], as: UTF8.self)
            if endsBlocks(line) { boundary = lineEnd + 1 }
            index = utf8.index(after: newline)
            offset = lineEnd + 1
            lineStart = offset
        }
        scanned = lineStart
        if boundary > stableLength {
            let start = utf8.index(utf8.startIndex, offsetBy: stableLength)
            let end = utf8.index(utf8.startIndex, offsetBy: boundary)
            stableBlocks += Markdown.parse(String(decoding: utf8[start ..< end], as: UTF8.self))
            parsedByteCount += boundary - stableLength
            stableLength = boundary
        }
        let tail = String(decoding: utf8[utf8.index(utf8.startIndex, offsetBy: stableLength)...], as: UTF8.self)
        tailBlocks = tail.isEmpty ? [] : Markdown.parse(tail)
        parsedByteCount += tail.utf8.count
    }

    /// Mirrors `Markdown.parse`: whether this complete line leaves no block open after it, and tracks fences.
    private mutating func endsBlocks(_ rawLine: String) -> Bool {
        let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        let ticks = line.prefix { $0 == "`" }.count
        if let open = fence {
            guard ticks >= open, line.dropFirst(ticks).isEmpty else { return false }
            fence = nil
            return true
        }
        if ticks >= 3, !line.dropFirst(ticks).contains("`") {
            fence = ticks
            return false
        }
        return line.isEmpty || Markdown.isHeading(line) || line == "---" || line == "***" || line == "___"
    }
}

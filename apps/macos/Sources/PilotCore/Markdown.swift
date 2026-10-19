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
    case table(MarkdownTable)
    case rule
}

public enum MarkdownTableAlignment: String, Equatable, Sendable {
    case none, leading, center, trailing
}

/// A GitHub-style pipe table: a header row, a delimiter row that sets column alignment, then body rows.
/// Cells hold inline Markdown with escaped pipes (`\|`) already unescaped and surrounding spaces trimmed.
/// Every row has `columnCount` cells. Short rows are padded with empty cells. A row with more cells than the
/// header widens the table with empty header cells instead of dropping text. `source` keeps the original lines.
public struct MarkdownTable: Equatable, Sendable {
    public let header: [String]
    public let alignments: [MarkdownTableAlignment]
    public let rows: [[String]]
    /// The table's Markdown lines as written, joined by newlines, for copying it whole.
    public let source: String

    public init(header: [String], alignments: [MarkdownTableAlignment], rows: [[String]], source: String) {
        let columns = max(header.count, alignments.count, rows.map(\.count).max() ?? 0)
        func padded<T>(_ values: [T], with value: T) -> [T] {
            values.count < columns ? values + Array(repeating: value, count: columns - values.count) : values
        }
        self.header = padded(header, with: "")
        self.alignments = padded(alignments, with: .none)
        self.rows = rows.allSatisfy { $0.count == columns } ? rows : rows.map { padded($0, with: "") }
        self.source = source
    }

    public var columnCount: Int { header.count }

    /// Splits one table line into trimmed cells, or nil when it has no column separator. A pipe separates cells
    /// unless it is escaped (`\|`, which becomes a literal pipe) or inside a code span. A leading and a trailing
    /// separator are optional outer pipes, so `| a | b |` and `a | b` both have two cells.
    public static func cells(_ line: some StringProtocol) -> [String]? {
        let bytes = Array(line.utf8)
        let pipe = UInt8(ascii: "|"), backslash = UInt8(ascii: "\\"), backtick = UInt8(ascii: "`")
        var cells: [[UInt8]] = []
        var current: [UInt8] = []
        var separators = 0
        var endsWithSeparator = false
        var index = 0
        func backticks(at start: Int) -> Int {
            var end = start
            while end < bytes.count, bytes[end] == backtick { end += 1 }
            return end - start
        }
        while index < bytes.count {
            let byte = bytes[index]
            if byte == backslash, index + 1 < bytes.count {
                if bytes[index + 1] != pipe { current.append(byte) }
                current.append(bytes[index + 1])
                index += 2
                continue
            }
            if byte == backtick {
                let run = backticks(at: index)
                // A code span closes at the next run of exactly the same length; an unmatched run is literal text.
                var search = index + run
                var close: Int?
                while search < bytes.count {
                    guard bytes[search] == backtick else { search += 1; continue }
                    let length = backticks(at: search)
                    if length == run { close = search; break }
                    search += length
                }
                guard let close else {
                    current.append(contentsOf: bytes[index ..< index + run])
                    index += run
                    continue
                }
                var position = index
                while position < close + run {
                    if bytes[position] == backslash, position + 1 < close, bytes[position + 1] == pipe {
                        position += 1
                    }
                    current.append(bytes[position])
                    position += 1
                }
                index = close + run
                continue
            }
            if byte == pipe {
                separators += 1
                cells.append(current)
                current = []
                endsWithSeparator = index == bytes.count - 1
                index += 1
                continue
            }
            current.append(byte)
            index += 1
        }
        guard separators > 0 else { return nil }
        cells.append(current)
        if bytes.first == pipe { cells.removeFirst() }
        if endsWithSeparator, !cells.isEmpty { cells.removeLast() }
        return cells.map { String(decoding: $0, as: UTF8.self).trimmingCharacters(in: .whitespaces) }
    }

    /// The alignments of a delimiter row such as `|:---|:-:|--:|`, or nil when the line is not one.
    static func delimiter(_ line: String) -> [MarkdownTableAlignment]? {
        guard line.contains("-"), let cells = cells(line), !cells.isEmpty else { return nil }
        var alignments: [MarkdownTableAlignment] = []
        for cell in cells {
            let leading = cell.hasPrefix(":"), trailing = cell.count > 1 && cell.hasSuffix(":")
            let dashes = cell.dropFirst(leading ? 1 : 0).dropLast(trailing ? 1 : 0)
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            alignments.append(leading && trailing ? .center : leading ? .leading : trailing ? .trailing : .none)
        }
        return alignments
    }
}

public enum Markdown {
    public static func parse(_ source: String) -> [MarkdownBlock] {
        var parser = MarkdownParser()
        for line in source.components(separatedBy: "\n") { parser.consume(line) }
        return parser.finish()
    }
}

/// The block parser behind `Markdown.parse`, fed one line at a time so a stream can keep its state between updates.
/// A table needs a header line, then a delimiter row with the same number of cells; body rows follow until a line
/// without a column separator, a blank line or another block. A pipe line without a delimiter stays paragraph text.
struct MarkdownParser: Sendable {
    private struct OpenList: Sendable {
        var ordered: Bool
        var start: Int
        var items: [String]
    }
    private struct OpenTable: Sendable {
        var header: [String]
        var alignments: [MarkdownTableAlignment]
        var rows: [[String]] = []
        var source: String
    }
    private struct Fence: Sendable {
        var language: String?
        var length: Int
    }
    /// Finished blocks not yet taken.
    private var blocks: [MarkdownBlock] = []
    private var paragraph: [String] = []
    /// The untrimmed last paragraph line, the source of a table header if a delimiter row follows.
    private var paragraphLastLine = ""
    private var list: OpenList?
    private var quote: [String] = []
    private var table: OpenTable?
    private var code: Fence?
    private var codeLines: [String] = []

    /// No block is open, so later lines cannot change the blocks finished so far.
    var isIdle: Bool { paragraph.isEmpty && list == nil && quote.isEmpty && table == nil && code == nil }

    /// Returns the finished blocks and forgets them.
    mutating func takeBlocks() -> [MarkdownBlock] {
        defer { blocks = [] }
        return blocks
    }

    /// Closes every open block, including an unterminated fence (typically while streaming), and returns all blocks.
    mutating func finish() -> [MarkdownBlock] {
        if let current = code {
            flush()
            blocks.append(.code(language: current.language, text: codeLines.joined(separator: "\n")))
            code = nil
            codeLines = []
        } else {
            flush()
        }
        return takeBlocks()
    }

    private mutating func flush() {
        if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
        if let current = list { blocks.append(.list(ordered: current.ordered, start: current.start, items: current.items)) }
        if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))) }
        if let current = table {
            blocks.append(.table(MarkdownTable(header: current.header, alignments: current.alignments, rows: current.rows,
                                               source: current.source)))
        }
        paragraph = []
        list = nil
        quote = []
        table = nil
    }

    mutating func consume(_ rawLine: String) {
        let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        if let current = code {
            let ticks = line.prefix { $0 == "`" }.count
            if ticks >= current.length, line.dropFirst(ticks).isEmpty {
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
            return
        }
        let ticks = line.prefix { $0 == "`" }.count
        if ticks >= 3, !line.dropFirst(ticks).contains("`") {
            flush()
            let language = line.dropFirst(ticks).trimmingCharacters(in: .whitespacesAndNewlines)
            code = Fence(language: language.isEmpty ? nil : language, length: ticks)
            return
        }
        if line.isEmpty {
            flush()
            return
        }
        if let heading = Self.headingLevel(line) {
            flush()
            blocks.append(.heading(level: heading, text: line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)))
            return
        }
        if line == "---" || line == "***" || line == "___" {
            flush()
            blocks.append(.rule)
            return
        }
        if var current = table {
            if !line.hasPrefix(">"), let cells = MarkdownTable.cells(line) {
                // Move the table out while appending, so its rows and source are not copied.
                table = nil
                current.rows.append(cells)
                current.source += "\n" + rawLine
                table = current
                return
            }
            flush()
        }
        if let header = paragraph.last, let alignments = MarkdownTable.delimiter(line),
           let cells = MarkdownTable.cells(header), cells.count == alignments.count {
            let headerLine = paragraphLastLine
            paragraph.removeLast()
            flush()
            table = OpenTable(header: cells, alignments: alignments, source: headerLine + "\n" + rawLine)
            return
        }
        if line.hasPrefix(">") {
            if quote.isEmpty { flush() }
            quote.append(String(line.dropFirst()).trimmingCharacters(in: .whitespaces))
            return
        }
        if let item = Self.listItem(line) {
            if list == nil || list?.ordered != item.ordered {
                flush()
                list = OpenList(ordered: item.ordered, start: item.number, items: [])
            }
            list?.items.append(item.text)
            return
        }
        if var current = list, rawLine.first == " " || rawLine.first == "\t", !current.items.isEmpty {
            // Indented continuation of the last item.
            list = nil
            current.items[current.items.count - 1] += "\n" + line
            list = current
            return
        }
        if list != nil || !quote.isEmpty { flush() }
        paragraph.append(line)
        paragraphLastLine = rawLine
    }

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
/// The parser keeps its state after the last complete line, so each update reads only the newly completed lines
/// once, then a copy of that state reads the unfinished last line to produce the open blocks. Whenever no block is
/// open after a line (a blank line, a closing fence, a heading or a rule), the blocks before it are final and later
/// text cannot change them. A long table or list still being written is therefore never parsed again from its start.
/// `blocks` always equals `Markdown.parse(source)`.
public struct MarkdownStream: Sendable {
    public private(set) var source = ""
    /// Final blocks: everything before `stableLength`.
    public private(set) var stableBlocks: [MarkdownBlock] = []
    /// UTF-8 length of the final prefix, which ends just after a line that left no block open.
    public private(set) var stableLength = 0
    /// Blocks after the final prefix, rebuilt from the saved parser state on every update.
    public private(set) var tailBlocks: [MarkdownBlock] = []
    /// UTF-8 bytes handed to the line parser so far, for cost regressions.
    public private(set) var parsedByteCount = 0
    /// Start of the first line not yet complete (it has no newline yet), and the parser state before it.
    private var scanned = 0
    private var parser = MarkdownParser()

    public init() {}

    public var blocks: [MarkdownBlock] { stableBlocks + tailBlocks }

    /// Takes the message's current text. Text that does not extend the previous source starts over.
    public mutating func update(_ text: String) {
        let utf8 = text.utf8
        if utf8.count < source.utf8.count || !utf8.starts(with: source.utf8) { self = MarkdownStream() }
        source = text
        var index = utf8.index(utf8.startIndex, offsetBy: scanned)
        while let newline = utf8[index...].firstIndex(of: UInt8(ascii: "\n")) {
            let line = String(decoding: utf8[index ..< newline], as: UTF8.self)
            parser.consume(line)
            parsedByteCount += line.utf8.count + 1
            scanned += line.utf8.count + 1
            index = utf8.index(after: newline)
            if parser.isIdle {
                stableBlocks += parser.takeBlocks()
                stableLength = scanned
            }
        }
        var tail = parser
        let last = String(decoding: utf8[index...], as: UTF8.self)
        tail.consume(last)
        parsedByteCount += last.utf8.count
        tailBlocks = tail.finish()
    }
}

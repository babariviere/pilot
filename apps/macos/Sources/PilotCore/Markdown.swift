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
        var code: (language: String?, fenceLength: Int, lines: [String])?

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
            if var current = code {
                let ticks = line.prefix { $0 == "`" }.count
                if ticks >= current.fenceLength, line.dropFirst(ticks).isEmpty {
                    let text = current.lines.joined(separator: "\n")
                    let token = current.language?.split(whereSeparator: { $0.isWhitespace }).first?.lowercased()
                    if let token, let kind = MarkdownDiagramKind(rawValue: token) {
                        blocks.append(.diagram(kind: kind, text: text))
                    } else {
                        blocks.append(.code(language: current.language, text: text))
                    }
                    code = nil
                } else {
                    current.lines.append(rawLine)
                    code = current
                }
                continue
            }
            let ticks = line.prefix { $0 == "`" }.count
            if ticks >= 3, !line.dropFirst(ticks).contains("`") {
                flush()
                let language = line.dropFirst(ticks).trimmingCharacters(in: .whitespacesAndNewlines)
                code = (language.isEmpty ? nil : language, ticks, [])
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
            blocks.append(.code(language: current.language, text: current.lines.joined(separator: "\n")))
        } else {
            flush()
        }
        return blocks
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

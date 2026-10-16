import Foundation

/// Source-level checks for Mermaid flowcharts, independent of any renderer. The native renderer's parser
/// skips link statements it cannot read without reporting them; these helpers find each link statement
/// so the caller can confirm it was understood, and fall back to the web renderer when one was not.
public enum MermaidSource {
    /// Statement keywords that never declare a link.
    static let keywords: Set<String> = ["subgraph", "end", "classdef", "class", "style", "linkstyle", "click",
                                        "direction", "acctitle", "accdescr"]

    /// True for `flowchart` and `graph` sources (after optional front matter and comments).
    public static func isFlowchart(_ source: String) -> Bool {
        guard let header = header(source) else { return false }
        let word = header.split(whereSeparator: { $0 == " " || $0 == ";" || $0 == "\t" }).first?.lowercased()
        return word == "flowchart" || word == "graph" || word == "flowchart-elk"
    }

    /// Statements after the header, split on newlines and semicolons outside quotes and brackets, so a
    /// label that wraps onto the next line stays with its link. Comments and blank lines are omitted.
    public static func statements(_ source: String) -> [String] {
        var lines = source.split(separator: "\n", omittingEmptySubsequences: false)
        var skip = 0
        var frontMatter = false
        for line in lines {
            skip += 1
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == "---" { frontMatter.toggle(); continue }
            if frontMatter || trimmed.isEmpty || trimmed.hasPrefix("%%") { continue }
            break
        }
        lines.removeFirst(min(skip, lines.count))
        var result: [String] = []
        var current = ""
        var depth = 0
        var quoted = false
        for character in lines.joined(separator: "\n") {
            if character == "\"" {
                quoted.toggle()
            } else if !quoted, "[({".contains(character) {
                depth += 1
            } else if !quoted, "])}".contains(character) {
                depth = max(0, depth - 1)
            }
            if !quoted, depth == 0, character == "\n" || character == ";" {
                result.append(current)
                current = ""
                continue
            }
            current.append(character)
        }
        result.append(current)
        return result.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && !$0.hasPrefix("%%") }
    }

    /// Whether a statement draws a link: a link operator outside quoted text and bracketed labels.
    public static func declaresLink(_ statement: String) -> Bool {
        let word = statement.split(whereSeparator: { " [:\n\t".contains($0) }).first?.lowercased() ?? ""
        if keywords.contains(word) { return false }
        var plain = ""
        var depth = 0
        var quoted = false
        for character in statement {
            if character == "\"" { quoted.toggle(); continue }
            if quoted { continue }
            if "[({".contains(character) { depth += 1; continue }
            if "])}".contains(character) { depth = max(0, depth - 1); continue }
            if depth == 0 { plain.append(character) }
        }
        return ["--", "==", "-.", "~~~"].contains { plain.contains($0) }
    }

    /// The link statements of a flowchart; empty for other diagram types.
    public static func linkStatements(_ source: String) -> [String] {
        isFlowchart(source) ? statements(source).filter(declaresLink) : []
    }

    private static func header(_ source: String) -> Substring? {
        var frontMatter = false
        for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == "---" { frontMatter.toggle(); continue }
            if frontMatter || trimmed.isEmpty || trimmed.hasPrefix("%%") { continue }
            return Substring(trimmed)
        }
        return nil
    }
}

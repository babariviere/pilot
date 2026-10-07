import Foundation

/// Lightweight lexical highlighting for JavaScript/TypeScript, including incomplete streamed code.
/// Tokens retain the source verbatim. Unknown languages intentionally remain plain text.
/// This is not a parser: regex literals and template interpolation are not interpreted.
public enum CodeSyntax {
    public enum Kind: Equatable, Sendable {
        case keyword, string, number, comment, literal, function
    }

    public struct Token: Equatable, Sendable {
        public let text: String
        public let kind: Kind?
    }

    public static func tokens(_ source: String, language: String?) -> [Token] {
        let language = language?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let language, languages.contains(language) else {
            return [Token(text: source, kind: nil)]
        }

        let text = source as NSString
        var tokens: [Token] = []
        var offset = 0
        for match in lexer.matches(in: source, range: NSRange(location: 0, length: text.length)) {
            if match.range.location > offset {
                tokens.append(Token(text: text.substring(with: NSRange(location: offset, length: match.range.location - offset)), kind: nil))
            }
            let value = text.substring(with: match.range)
            let kind: Kind?
            if match.range(withName: "comment").location != NSNotFound {
                kind = .comment
            } else if match.range(withName: "string").location != NSNotFound {
                kind = .string
            } else if match.range(withName: "number").location != NSNotFound {
                kind = .number
            } else if keywords.contains(value) {
                kind = .keyword
            } else if literals.contains(value) {
                kind = .literal
            } else if match.range(withName: "function").location != NSNotFound {
                kind = .function
            } else {
                kind = nil
            }
            tokens.append(Token(text: value, kind: kind))
            offset = NSMaxRange(match.range)
        }
        if offset < text.length {
            tokens.append(Token(text: text.substring(from: offset), kind: nil))
        }
        return tokens
    }

    private static let languages: Set<String> = ["javascript", "js", "mjs", "cjs", "typescript", "ts"]
    private static let keywords: Set<String> = [
        "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
        "declare", "default", "delete", "do", "else", "enum", "export", "extends", "finally", "for",
        "from", "function", "get", "if", "implements", "import", "in", "instanceof", "interface", "keyof",
        "let", "namespace", "new", "of", "private", "protected", "public", "readonly", "return", "satisfies",
        "set", "static", "super", "switch", "this", "throw", "try", "type", "typeof", "var", "void",
        "while", "with", "yield",
    ]
    private static let literals: Set<String> = ["true", "false", "null", "undefined", "NaN", "Infinity"]

    // Consume comments and strings before identifiers, so their contents aren't highlighted as code.
    // Template literals are styled as a single string, including their interpolation expressions.
    private static let lexer = try! NSRegularExpression(pattern: #"""
        (?<comment> //[^\r\n]* | /\*[\s\S]*?(?:\*/|\z) )
        | (?<string>
            "(?:\\(?:[\s\S]|\z)|[^"\\\r\n])*(?:"|(?=\r|\n|\z))
            | '(?:\\(?:[\s\S]|\z)|[^'\\\r\n])*(?:'|(?=\r|\n|\z))
            | `(?:\\(?:[\s\S]|\z)|[^`\\])*(?:`|\z)
        )
        | (?<number>
            \b0[xX][\da-fA-F_]+n? | \b0[bB][01_]+n? | \b0[oO][0-7_]+n?
            | (?:\b\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?n?
        )
        | (?<function> [$\p{L}_][$\p{L}\p{N}_\u200C\u200D]*(?=\s*\() )
        | [$\p{L}_][$\p{L}\p{N}_\u200C\u200D]*
        """#, options: .allowCommentsAndWhitespace)
}

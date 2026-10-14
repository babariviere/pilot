import Foundation

// Links mentioned in a chat, for the inspector's Links tab. Pure and incremental, so it can run off the UI actor.

/// One link mentioned in the chat, de-duplicated by normalized URL.
public struct ChatLink: Identifiable, Equatable, Sendable {
    /// The normalized URL.
    public let id: String
    /// The latest spelling seen in the chat.
    public let url: String
    public let kind: MissionResourceKind
    /// The markdown label it was written with, else a name derived from the URL ("o/r#12", "ENG-3", the host and path).
    public let title: String
    /// The URL without its scheme, for the secondary line.
    public let detail: String
    /// How many times the chat mentions it.
    public let mentions: Int
}

/// Remembers the links of every scanned row, so a new pass only scans rows that are new or changed.
public struct ChatLinkIndex: Sendable {
    private struct Scan: Sendable {
        let text: String
        let found: [ChatLinkMention]
    }

    private var scans: [String: Scan] = [:]

    public init() {}

    /// Links from user, automatic and assistant messages, the most recently mentioned first.
    public mutating func links(in rows: [ChatRow]) -> [ChatLink] {
        var next: [String: Scan] = [:]
        var mentions: [ChatLinkMention] = []
        for row in rows {
            let id: String
            let text: String
            switch row {
            case let .user(rowId, value, _), let .text(rowId, value, _), let .automatic(rowId, value, _, _):
                id = rowId
                text = value
            default: continue
            }
            let scan = scans[id].flatMap { $0.text == text ? $0 : nil } ?? Scan(text: text, found: ChatLinks.mentions(in: text))
            next[id] = scan
            mentions.append(contentsOf: scan.found)
        }
        scans = next
        return ChatLinks.links(from: mentions)
    }
}

/// One URL occurrence in a message, with the markdown label it was written with, if any.
public struct ChatLinkMention: Equatable, Sendable {
    public let url: String
    public let label: String?
}

public enum ChatLinks {
    /// Characters that end a URL in prose and markdown.
    /// Square brackets end a URL so "[https://a.io](https://a.io)" reads as two clean mentions.
    private static let terminators: Set<Character> = [
        " ", "\t", "\n", "\r", "\r\n", "<", ">", "\"", "'", "`", "|", "[", "]", "\u{00A0}",
    ]
    /// Punctuation that ends a sentence rather than a URL.
    private static let trailing: Set<Character> = [".", ",", ";", ":", "!", "?", "*", "_", "~"]

    /// Absolute http(s) URLs, written with their scheme. Bare domains are skipped: "README.md" is not a link.
    public static func mentions(in text: String) -> [ChatLinkMention] {
        guard text.contains("http") else { return [] }
        var result: [ChatLinkMention] = []
        var searchStart = text.startIndex
        while let match = nextScheme(in: text, from: searchStart) {
            var end = match
            while end < text.endIndex, !terminators.contains(text[end]) { end = text.index(after: end) }
            var candidate = Substring(text[match..<end])
            trim(&candidate)
            searchStart = end
            let url = String(candidate)
            guard let parts = URLComponents(string: url), let host = parts.host, !host.isEmpty else { continue }
            result.append(ChatLinkMention(url: url, label: label(before: match, in: text, url: url)))
        }
        return result
    }

    /// De-duplicates mentions in chat order and puts the most recently mentioned first.
    public static func links(from mentions: [ChatLinkMention]) -> [ChatLink] {
        struct Seen {
            var url: String
            var label: String?
            var count: Int
            var last: Int
        }
        var seen: [String: Seen] = [:]
        for (position, mention) in mentions.enumerated() {
            let key = MissionLinks.normalizedURL(mention.url)
            var entry = seen[key] ?? Seen(url: mention.url, label: nil, count: 0, last: position)
            entry.url = mention.url
            entry.label = mention.label ?? entry.label
            entry.count += 1
            entry.last = position
            seen[key] = entry
        }
        return seen.sorted { $0.value.last > $1.value.last }.map { key, entry in
            let kind = kind(of: entry.url)
            return ChatLink(id: key, url: entry.url, kind: kind, title: entry.label ?? title(entry.url, kind: kind),
                            detail: detail(entry.url), mentions: entry.count)
        }
    }

    /// The same rules the daemon uses for mission links.
    public static func kind(of url: String) -> MissionResourceKind {
        guard let parts = URLComponents(string: url), let host = parts.host?.lowercased() else { return .url }
        let path = parts.path.split(separator: "/").map(String.init)
        if host == "linear.app", path.count >= 3 {
            if path[1] == "issue" { return .linearIssue }
            if path[1] == "project" { return .linearProject }
        }
        if host == "github.com", path.count >= 4, Int(path[3]) != nil {
            if path[2] == "pull" { return .githubPullRequest }
            if path[2] == "issues" { return .githubIssue }
        }
        if host.hasSuffix(".slack.com"), path.count >= 3, path[0] == "archives", path[2].hasPrefix("p"),
           path[2].count == 17, path[2].dropFirst().allSatisfy(\.isNumber) {
            return .slackThread
        }
        return .url
    }

    private static func title(_ url: String, kind: MissionResourceKind) -> String {
        let path = (URLComponents(string: url)?.path ?? "").split(separator: "/").map(String.init)
        switch kind {
        case .githubPullRequest, .githubIssue: return "\(path[0])/\(path[1])#\(path[3])"
        case .linearIssue: return path[2].uppercased()
        case .linearProject:
            var words = path[2].split(separator: "-").map(String.init)
            if words.count > 1, let last = words.last, last.count >= 8, last.allSatisfy(\.isHexDigit) { words.removeLast() }
            let text = words.joined(separator: " ")
            return text.isEmpty ? "Linear project" : text.prefix(1).uppercased() + text.dropFirst()
        case .slackThread: return "Slack thread"
        case .url: return detail(url)
        }
    }

    private static func detail(_ url: String) -> String {
        var text = Substring(url)
        for scheme in ["https://", "http://"] where text.lowercased().hasPrefix(scheme) {
            text = text.dropFirst(scheme.count)
        }
        if text.hasPrefix("www.") { text = text.dropFirst(4) }
        while text.count > 1, text.hasSuffix("/") { text = text.dropLast() }
        return String(text)
    }

    private static func nextScheme(in text: String, from start: String.Index) -> String.Index? {
        var cursor = start
        while let range = text.range(of: "http", options: [.caseInsensitive], range: cursor..<text.endIndex) {
            let rest = text[range.upperBound...]
            let isScheme = rest.hasPrefix("://") || ((rest.first == "s" || rest.first == "S") && rest.dropFirst().hasPrefix("://"))
            // "xhttp://" is not a link; the scheme must start a word.
            let startsWord = range.lowerBound == text.startIndex
                || !(text[text.index(before: range.lowerBound)].isLetter || text[text.index(before: range.lowerBound)].isNumber)
            if isScheme, startsWord { return range.lowerBound }
            cursor = range.upperBound
        }
        return nil
    }

    /// Drops sentence punctuation and closing brackets that the URL did not open.
    private static func trim(_ url: inout Substring) {
        while let last = url.last {
            if trailing.contains(last) {
                url.removeLast()
            } else if let open = [")": "(", "}": "{"][String(last)] {
                let opened = url.filter { String($0) == open }.count
                let closed = url.filter { $0 == last }.count
                if closed > opened { url.removeLast() } else { return }
            } else {
                return
            }
        }
    }

    /// "[label](url)" gives "label", unless the label is the URL itself.
    private static func label(before start: String.Index, in text: String, url: String) -> String? {
        guard text[..<start].hasSuffix("](") else { return nil }
        let close = text.index(start, offsetBy: -2)
        let line = text[..<close]
        guard let open = line.lastIndex(where: { $0 == "[" || $0 == "\n" }), line[open] == "[" else { return nil }
        let label = line[line.index(after: open)...].trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "`*_"))
        guard !label.isEmpty, label.count <= 200, label != url, MissionLinks.normalizedURL(label) != MissionLinks.normalizedURL(url)
        else { return nil }
        return label
    }
}

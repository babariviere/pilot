import Foundation

/// Local, deterministic link labels. Never fetches private pages or guesses what a bare #number means.
public struct ServiceLink: Equatable, Sendable {
    public enum Service: Equatable, Sendable { case github, linear, slack }
    public let service: Service
    public let title: String

    public init?(url: URL, label: String? = nil) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              ["https", "http"].contains(parts.scheme?.lowercased()),
              parts.user == nil, parts.password == nil, parts.port == nil,
              let host = parts.host?.lowercased() else { return nil }
        let path = parts.path.split(separator: "/").map(String.init)
        let fallback: String
        if host == "github.com", path.count >= 2 {
            service = .github
            let repository = "\(path[0])/\(path[1])"
            if path.count >= 4, ["pull", "issues", "discussions"].contains(path[2]),
               path[3].allSatisfy({ $0.isASCII && $0.isNumber }), path[3].first != "0" {
                fallback = "\(repository)#\(path[3])"
            } else if path.count >= 4, path[2] == "commit", path[3].allSatisfy(\.isHexDigit) {
                fallback = "\(repository)@\(path[3].prefix(7))"
            } else {
                fallback = path.count > 2 ? "\(repository) · \(path.last!)" : repository
            }
        } else if host == "linear.app", path.count >= 3, ["issue", "project"].contains(path[1]) {
            service = .linear
            if path[1] == "issue" {
                let name = path.count > 3 ? Self.words(path[3]) : ""
                fallback = path[2].uppercased() + (name.isEmpty ? "" : " · \(name)")
            } else {
                var slug = path[2].split(separator: "-")
                if let last = slug.last, last.count >= 8, last.allSatisfy(\.isHexDigit) { slug.removeLast() }
                fallback = slug.isEmpty ? "Linear project" : Self.words(slug.joined(separator: "-"))
            }
        } else if host.hasSuffix(".slack.com"), path.count >= 2, path[0] == "archives" {
            service = .slack
            fallback = path.count > 2 ? "Slack thread" : "Slack channel"
        } else if host == "app.slack.com", path.count >= 3, path[0] == "client" {
            service = .slack
            fallback = path.count > 3 ? "Slack thread" : "Slack channel"
        } else {
            return nil
        }
        let label = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        let isURL = label.map { $0.lowercased().hasPrefix("https://") || $0.lowercased().hasPrefix("http://") } ?? false
        let title = label.flatMap { $0.isEmpty || isURL ? nil : $0 } ?? fallback
        let singleLine = title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        self.title = singleLine.count > 80 ? String(singleLine.prefix(79)) + "…" : singleLine
    }

    private static func words(_ slug: String) -> String {
        let value = slug.replacingOccurrences(of: "-", with: " ")
        return value.prefix(1).uppercased() + value.dropFirst()
    }
}

public enum ServiceLinks {
    /// Runs after Markdown parsing, off the UI actor. Explicit destinations and inline code win.
    public static func detecting(in text: AttributedString) -> AttributedString {
        var result = AttributedString()
        for run in text.runs {
            let part = text[run.range]
            guard run.link == nil, !(run.inlinePresentationIntent ?? []).contains(.code) else {
                result.append(AttributedString(part))
                continue
            }
            let source = String(part.characters)
            var cursor = source.startIndex
            for mention in ChatLinks.mentions(in: source) {
                guard let range = source.range(of: mention.url, range: cursor..<source.endIndex) else { continue }
                result.append(AttributedString(String(source[cursor..<range.lowerBound]), attributes: run.attributes))
                var link = AttributedString(mention.url, attributes: run.attributes)
                if let url = URL(string: mention.url), ServiceLink(url: url) != nil { link.link = url }
                result.append(link)
                cursor = range.upperBound
            }
            result.append(AttributedString(String(source[cursor...]), attributes: run.attributes))
        }
        return result
    }
}

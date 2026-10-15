import Foundation

/// Translate content links only. Marketing, sign-in and unrelated URLs stay in the browser.
enum DesktopAppLink {
    static func url(for url: URL) -> URL? {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              ["http", "https"].contains(parts.scheme?.lowercased()),
              parts.user == nil, parts.password == nil, parts.port == nil,
              let host = parts.host?.lowercased() else { return nil }
        let path = parts.path.split(separator: "/").map(String.init)
        if host == "linear.app", path.count >= 3, ["issue", "project"].contains(path[1]) {
            parts.scheme = "linear"
            return parts.url
        }
        guard host == "slack.com" || host.hasSuffix(".slack.com") else { return nil }
        let query = parts.queryItems ?? []
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
        var team = value("team")
        let channel: String
        var message: String?
        if path.count == 2 || path.count == 3, path[0] == "archives" {
            channel = path[1]
            if path.count == 3 {
                let timestamp = path[2]
                guard timestamp.first == "p", timestamp.count > 7,
                      timestamp.dropFirst().allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
                let digits = timestamp.dropFirst()
                message = "\(digits.dropLast(6)).\(digits.suffix(6))"
            }
        } else if host == "app.slack.com", path.count == 3 || path.count == 4, path[0] == "client" {
            team = path[1]
            channel = path[2]
            if path.count == 4 { message = path[3] }
        } else {
            return nil
        }
        guard channel.range(of: #"^[CDG][A-Z0-9]+$"#, options: .regularExpression) != nil else { return nil }
        if let team, team.range(of: #"^[TE][A-Z0-9]+$"#, options: .regularExpression) == nil { return nil }
        // A reply permalink names the reply in its path and the parent in thread_ts.
        let thread = value("thread_ts")
        for timestamp in [message, thread].compactMap({ $0 }) {
            guard timestamp.range(of: #"^[0-9]+\.[0-9]{6}$"#, options: .regularExpression) != nil else { return nil }
        }
        var native = URLComponents()
        native.scheme = "slack"
        native.host = "channel"
        native.queryItems = []
        // Some permalinks (including tracked messages) have no team ID. Let Slack resolve
        // those in its active workspace rather than guessing an ID from the subdomain.
        if let team { native.queryItems?.append(URLQueryItem(name: "team", value: team)) }
        native.queryItems?.append(URLQueryItem(name: "id", value: channel))
        // Slack's channel deep link uses ts, not message. An ignored parameter still
        // launches Slack successfully, but leaves it at the channel's current position.
        if let timestamp = message ?? thread { native.queryItems?.append(URLQueryItem(name: "ts", value: timestamp)) }
        if let thread { native.queryItems?.append(URLQueryItem(name: "thread_ts", value: thread)) }
        return native.url
    }
}

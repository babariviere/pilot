import Foundation

/// A Slack workspace the desktop app is signed in to.
struct SlackWorkspace: Equatable {
    let id: String
    let host: String?
}

/// Translate content links only. Marketing, sign-in and unrelated URLs stay in the browser.
enum DesktopAppLink {
    static func url(for url: URL,
                    slackWorkspaces: () -> [SlackWorkspace] = SlackDesktopState.workspaces) -> URL? {
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
        // slack://channel needs a team: without one Slack only comes to the front. Most
        // permalinks carry none, so resolve it from the workspaces the app is signed in to.
        // An unknown workspace opens in the browser, which can resolve it properly.
        guard let team = team ?? slackTeam(host: host, workspaces: slackWorkspaces()) else { return nil }
        var native = URLComponents()
        native.scheme = "slack"
        native.host = "channel"
        native.queryItems = [URLQueryItem(name: "team", value: team), URLQueryItem(name: "id", value: channel)]
        // Slack scrolls to `message`; it ignores `ts` and stays at the channel's current position.
        if let timestamp = message ?? thread { native.queryItems?.append(URLQueryItem(name: "message", value: timestamp)) }
        if let thread { native.queryItems?.append(URLQueryItem(name: "thread_ts", value: thread)) }
        return native.url
    }

    /// A workspace subdomain names its team; bare slack.com links are unambiguous only with one workspace.
    static func slackTeam(host: String, workspaces: [SlackWorkspace]) -> String? {
        if host == "slack.com" || host == "app.slack.com" {
            return workspaces.count == 1 ? workspaces[0].id : nil
        }
        return workspaces.first { $0.host == host }?.id
    }
}

/// Reads the Slack desktop app's signed-in workspaces. Only on a Slack link click, never polled.
enum SlackDesktopState {
    static func workspaces() -> [SlackWorkspace] {
        let support = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library")
        for base in ["Application Support/Slack",
                     "Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack"] {
            let file = support.appending(path: base).appending(path: "storage/root-state.json")
            // The state file is a few kilobytes; skip anything implausibly large.
            guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size < 4_000_000,
                  let data = try? Data(contentsOf: file) else { continue }
            return workspaces(rootState: data)
        }
        return []
    }

    static func workspaces(rootState data: Data) -> [SlackWorkspace] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = root["workspaces"] as? [String: Any] else { return [] }
        return entries.values.compactMap { entry -> SlackWorkspace? in
            guard let entry = entry as? [String: Any], let id = entry["id"] as? String,
                  id.range(of: #"^[TE][A-Z0-9]+$"#, options: .regularExpression) != nil else { return nil }
            let host = (entry["url"] as? String).flatMap { URL(string: $0)?.host?.lowercased() }
                ?? (entry["domain"] as? String).map { "\($0.lowercased()).slack.com" }
            return SlackWorkspace(id: id, host: host)
        }.sorted { $0.id < $1.id }
    }
}


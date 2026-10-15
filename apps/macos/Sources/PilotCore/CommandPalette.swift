import Foundation

/// One entry the ⌘K palette can list: a chat, a mission task, a mission, a project scope, a page, an action, or a
/// Linear or Slack Inbox item. Views keep what an entry looks like and does; this carries only what search needs.
public struct CommandPaletteItem: Identifiable, Equatable, Sendable {
    /// The palette's groups, in their tie-breaking order.
    public enum Kind: Int, CaseIterable, Sendable {
        case chat, task, mission, project, page, action, linear, slack

        public var title: String {
            switch self {
            case .chat: "Chats"
            case .task: "Tasks"
            case .mission: "Missions"
            case .project: "Projects"
            case .page: "Pages"
            case .action: "Actions"
            case .linear: "Linear"
            case .slack: "Slack"
            }
        }
    }

    public let id: String
    public let kind: Kind
    /// Matched first, and weighted above keywords.
    public let title: String
    /// Also matched: a chat's branch and project, a page's project, a Linear ID or a Slack channel.
    public let keywords: [String]
    /// Pull requests a chat owns, or a mission task links to. A number query opens the owner.
    public let pullRequestNumbers: [Int]
    /// A mission task's number, so "#25" goes to task 25.
    public let taskNumber: Int?
    /// Listed while the field is empty, in the order given.
    public let suggested: Bool

    public init(id: String, kind: Kind, title: String, keywords: [String] = [], pullRequestNumbers: [Int] = [],
                taskNumber: Int? = nil, suggested: Bool = false) {
        self.id = id
        self.kind = kind
        self.title = title
        self.keywords = keywords
        self.pullRequestNumbers = pullRequestNumbers
        self.taskNumber = taskNumber
        self.suggested = suggested
    }
}

/// A titled group of palette rows.
public struct CommandPaletteSection: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let items: [CommandPaletteItem]

    public init(id: String, title: String, items: [CommandPaletteItem]) {
        self.id = id
        self.title = title
        self.items = items
    }
}

/// Search and ranking for the ⌘K palette, kept apart from views so they can be tested.
///
/// - An empty field lists the suggested items: recent chats, then pages, then actions for the open chat.
/// - A number ("406" or "#406") first lists the chat that owns that pull request, then that chat's actions. With no
///   owning chat, the mission tasks linked to the pull request take its place. Tasks numbered 406 come next.
/// - Words match titles and keywords, case- and accent-insensitively. Every word must match. A match at the start
///   of a title ranks above one at the start of a word, which ranks above one inside a word, and titles count
///   twice as much as keywords. Groups follow their best match, ties in Kind order, and rows keep the given order
///   (recency for chats) among equal scores.
public enum CommandPalette {
    /// Rows per group.
    public static let limit = 6

    /// The number in "406" or "#406", or nil for anything else.
    public static func number(in query: String) -> Int? {
        var text = Substring(query.trimmingCharacters(in: .whitespacesAndNewlines))
        if text.first == "#" { text = text.dropFirst() }
        guard !text.isEmpty, text.count <= 9, text.allSatisfy({ $0.isASCII && $0.isNumber }),
              let number = Int(text), number > 0 else { return nil }
        return number
    }

    /// Chats that own the pull request, or, when no chat does, the mission tasks linked to it.
    public static func pullRequestOwners(_ number: Int, in items: [CommandPaletteItem]) -> [CommandPaletteItem] {
        let chats = items.filter { $0.kind == .chat && $0.pullRequestNumbers.contains(number) }
        if !chats.isEmpty { return chats }
        return items.filter { $0.kind == .task && $0.pullRequestNumbers.contains(number) }
    }

    /// The number of a GitHub pull request link ("https://github.com/o/r/pull/406/files"), or nil.
    public static func pullRequestNumber(fromURL url: String) -> Int? {
        guard let parts = URLComponents(string: url), let scheme = parts.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return nil }
        let path = parts.path.split(separator: "/")
        guard let index = path.firstIndex(of: "pull"), index >= 2, index + 1 < path.count else { return nil }
        return number(in: String(path[index + 1]))
    }

    /// The palette's groups for a query. actions lists what can be done to a chat, shown after the pull request
    /// when a number query resolves to a single chat.
    public static func results(for query: String, items: [CommandPaletteItem],
                               actions: (String) -> [CommandPaletteItem] = { _ in [] },
                               limit: Int = limit) -> [CommandPaletteSection] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return suggestions(items, limit: limit) }
        var sections: [CommandPaletteSection] = []
        var used = Set<String>()
        var pinnedTasks: [CommandPaletteItem] = []
        if let number = number(in: trimmed) {
            let owners = pullRequestOwners(number, in: items)
            if !owners.isEmpty {
                sections.append(CommandPaletteSection(id: "pull-request", title: "Pull request #\(number)",
                                                      items: Array(owners.prefix(limit))))
                used.formUnion(owners.map(\.id))
                if owners.count == 1, owners[0].kind == .chat {
                    let chatActions = actions(owners[0].id).filter { !used.contains($0.id) }
                    if !chatActions.isEmpty {
                        sections.append(CommandPaletteSection(id: "pull-request-actions", title: "Actions",
                                                              items: chatActions))
                        used.formUnion(chatActions.map(\.id))
                    }
                }
            }
            pinnedTasks = items.filter { $0.kind == .task && $0.taskNumber == number && !used.contains($0.id) }
            used.formUnion(pinnedTasks.map(\.id))
        }
        let tokens = tokens(trimmed)
        var groups: [CommandPaletteItem.Kind: [(item: CommandPaletteItem, score: Int, index: Int)]] = [:]
        for (index, item) in pinnedTasks.enumerated() {
            groups[.task, default: []].append((item, Int.max, index))
        }
        for (index, item) in items.enumerated() where !used.contains(item.id) {
            guard let score = score(item, tokens: tokens) else { continue }
            groups[item.kind, default: []].append((item, score, pinnedTasks.count + index))
        }
        let ranked = groups.map { kind, rows in
            (kind: kind, rows: rows.sorted { $0.score != $1.score ? $0.score > $1.score : $0.index < $1.index })
        }
        .sorted { lhs, rhs in
            let left = lhs.rows[0].score, right = rhs.rows[0].score
            return left != right ? left > right : lhs.kind.rawValue < rhs.kind.rawValue
        }
        for group in ranked {
            sections.append(CommandPaletteSection(id: "kind-\(group.kind.rawValue)", title: group.kind.title,
                                                  items: group.rows.prefix(limit).map(\.item)))
        }
        return sections
    }

    /// How well every token matches an item, or nil when one does not.
    public static func score(_ item: CommandPaletteItem, tokens: [String]) -> Int? {
        guard !tokens.isEmpty else { return nil }
        let title = normalized(item.title)
        let keywords = item.keywords.map(normalized)
        var total = 0
        for token in tokens {
            var best = 2 * level(token, in: title)
            for keyword in keywords { best = max(best, level(token, in: keyword)) }
            guard best > 0 else { return nil }
            total += best
        }
        if title == tokens.joined(separator: " ") { total += 4 }
        return total
    }

    /// The words of a query, normalised. A leading "#" before a number is dropped, so "#25" also finds "25".
    public static func tokens(_ query: String) -> [String] {
        normalized(query).split(whereSeparator: \.isWhitespace).map { word in
            let digits = word.dropFirst()
            return word.first == "#" && !digits.isEmpty && digits.allSatisfy(\.isNumber) ? String(digits) : String(word)
        }
    }

    static func normalized(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }

    /// 3 at the start of the text, 2 at the start of a word, 1 inside a word, 0 when absent.
    static func level(_ token: String, in text: String) -> Int {
        var start = text.startIndex
        var found = 0
        while let range = text.range(of: token, range: start ..< text.endIndex) {
            if range.lowerBound == text.startIndex { return 3 }
            let previous = text[text.index(before: range.lowerBound)]
            if !previous.isLetter && !previous.isNumber { return 2 }
            found = 1
            start = text.index(after: range.lowerBound)
        }
        return found
    }

    private static func suggestions(_ items: [CommandPaletteItem], limit: Int) -> [CommandPaletteSection] {
        let suggested = items.filter(\.suggested)
        return CommandPaletteItem.Kind.allCases.compactMap { kind in
            let rows = suggested.filter { $0.kind == kind }
            guard !rows.isEmpty else { return nil }
            return CommandPaletteSection(id: "kind-\(kind.rawValue)", title: kind == .chat ? "Recent chats" : kind.title,
                                         items: Array(rows.prefix(limit)))
        }
    }
}

import Foundation

/// The Control screen's sections, in picker order.
public enum ControlScreenSection: String, CaseIterable, Hashable, Sendable {
    case summaries, log, watches, health

    public var title: String {
        switch self {
        case .summaries: "Summaries"
        case .log: "Log"
        case .watches: "Watches & actions"
        case .health: "Health"
        }
    }
}

/// One whole logged message, assembled from its pages (`nodes/:id/1?offset`). Bounded: "Show more" stops after
/// `maxCharacters`, so one huge tool input cannot grow the page without limit.
public struct ControlMemoryMessageText: Equatable, Sendable {
    public static let maxCharacters = 240_000
    public let message: ControlMemoryMessagePage.Message
    public private(set) var text: String
    public let format: String?
    /// Offset of the next page, while more can be loaded.
    public private(set) var next: Int?

    public init(_ page: ControlMemoryMessagePage) {
        message = page.message
        text = page.message.text
        format = page.format
        next = page.next
    }

    /// Adds the page that continues at `next`. Other pages are ignored.
    public mutating func append(_ page: ControlMemoryMessagePage, offset: Int) {
        guard page.message.id == message.id, offset == next else { return }
        text += page.message.text
        next = page.next
    }

    /// More text exists and the bound allows loading it.
    public var canLoadMore: Bool { next != nil && text.count < Self.maxCharacters }
    /// More text exists beyond the bound.
    public var truncated: Bool { next != nil && text.count >= Self.maxCharacters }
}

/// One visible row of the summaries tree.
public struct ControlMemoryTreeRow: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case line(ControlMemoryLine, expanded: Bool)
        case message(ControlMemoryMessageText)
        case loading
        case failed(String)
    }

    public let id: String
    public let depth: Int
    public let kind: Kind
    /// The summary line this row expands from, for retrying or paging.
    public let parent: ControlMemoryLine?
}

/// Flattens the view into rows: each expanded summary shows its two halves, down to a single message, which shows
/// the original message. Halves and messages load on expansion; until then the row says it is loading.
public enum ControlMemoryTree {
    public static func rows(lines: [ControlMemoryLine], expanded: Set<String>,
                            children: [String: [ControlMemoryLine]], messages: [Int: ControlMemoryMessageText],
                            failures: [String: String] = [:]) -> [ControlMemoryTreeRow] {
        var rows: [ControlMemoryTreeRow] = []
        func add(_ line: ControlMemoryLine, depth: Int) {
            let open = expanded.contains(line.id)
            rows.append(ControlMemoryTreeRow(id: line.id, depth: depth, kind: .line(line, expanded: open), parent: nil))
            guard open else { return }
            if line.n == 1, let message = messages[line.start] {
                rows.append(ControlMemoryTreeRow(id: "message:\(line.start)", depth: depth + 1, kind: .message(message),
                                                 parent: line))
            } else if line.n > 1, let halves = children[line.id] {
                for half in halves { add(half, depth: depth + 1) }
            } else if let failure = failures[line.id] {
                rows.append(ControlMemoryTreeRow(id: "failed:\(line.id)", depth: depth + 1, kind: .failed(failure),
                                                 parent: line))
            } else {
                rows.append(ControlMemoryTreeRow(id: "loading:\(line.id)", depth: depth + 1, kind: .loading, parent: line))
            }
        }
        for line in lines { add(line, depth: 0) }
        return rows
    }
}

/// The message log as loaded pages, newest first.
public enum ControlMemoryLog {
    /// Rows kept after "Show more" and refreshes.
    public static let cap = 1_000

    /// Folds the newest page, fetched after a change, into the rows already held. New rows (above the newest held)
    /// go on top. A page made only of new rows that has more behind it may leave a gap, so it replaces the list.
    public static func merge(held: [ControlMemoryLogEntry], heldNext: Int?, newest: ControlMemoryMessagesResponse)
        -> (entries: [ControlMemoryLogEntry], next: Int?) {
        guard let top = held.first?.id else { return (newest.messages, newest.next) }
        let fresh = newest.messages.filter { $0.id > top }
        if !fresh.isEmpty, fresh.count == newest.messages.count, newest.next != nil {
            return (newest.messages, newest.next)
        }
        return bounded(fresh + held, next: heldNext)
    }

    /// Adds an older page below the held rows. Pages for a stale cursor are ignored by the caller.
    public static func append(held: [ControlMemoryLogEntry], older: ControlMemoryMessagesResponse)
        -> (entries: [ControlMemoryLogEntry], next: Int?) {
        let bottom = held.last?.id ?? Int.max
        return bounded(held + older.messages.filter { $0.id < bottom }, next: older.next)
    }

    private static func bounded(_ entries: [ControlMemoryLogEntry], next: Int?) -> (entries: [ControlMemoryLogEntry], next: Int?) {
        guard entries.count > cap else { return (entries, next) }
        let kept = Array(entries.prefix(cap))
        return (kept, kept.last?.id)
    }
}

/// Words and numbers for the Control screen.
public enum ControlMemoryFormat {
    /// "Message 12" or "Messages 8–15".
    public static func range(_ line: ControlMemoryLine) -> String {
        line.n == 1 ? "Message \(line.start)" : "Messages \(line.start)–\(line.end)"
    }

    public static func kind(_ kind: ControlMemoryKind) -> String {
        switch kind {
        case .user: "You"
        case .assistant: "Control"
        case .tool: "Tool call"
        case .echo: "Tool result"
        case .event: "Event"
        case .note: "Note"
        }
    }

    /// Text the agent wrote or an event carried. The screen shows it as quoted content, never as instructions.
    public static func isQuoted(_ kind: ControlMemoryKind) -> Bool { kind != .user }

    public static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }

    /// A whole tool message (`format == "json"`) as name, input and result; other messages unchanged.
    public static func toolParts(_ message: ControlMemoryMessageText) -> (name: String?, input: String?, text: String)? {
        guard message.format == "json", message.next == nil,
              let value = try? JSONValue.decode(Data(message.text.utf8)) else { return nil }
        let input = value["input"].flatMap { input -> String? in
            guard let data = try? JSONEncoder.pretty.encode(input) else { return nil }
            return String(data: data, encoding: .utf8)
        }
        return (value["name"]?.string, input, value["text"]?.string ?? "")
    }
}

private extension JSONEncoder {
    static var pretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}


import Foundation

/// Which control-chat details a `watches.changed` or `control-audit.changed` invalidation covers.
public enum ControlDetailsChange: Sendable, Equatable {
    case watches, audit
}

/// One audited control action, folded from its requested, succeeded and failed entries into the latest state.
/// The control chat's details list these under "Actions", newest first.
public struct ControlAuditOperation: Identifiable, Equatable, Sendable {
    public var id: String { operationId }
    public let operationId: String
    public let action: String
    /// The latest phase. `requested` alone means the outcome is not known yet (or was lost in a crash).
    public let phase: ControlAuditEntry.Phase
    /// When the latest phase was recorded, epoch milliseconds.
    public let at: Double
    /// Lowest sequence of the loaded entries, the cursor for older pages.
    public let oldestSeq: Int
    public let args: [String: JSONValue]
    public let result: JSONValue?

    /// What happened, in words: "Started a chat", "Added a memory note".
    public var title: String { ControlAuditOperation.title(for: action) }

    /// The free text the action carried (message, goal or note), on one line and clipped. Untrusted: show as text.
    public var detail: String? {
        for key in ["message", "goal", "text", "title"] {
            if let value = args[key]?.string, let line = ControlAuditOperation.line(value) { return line }
        }
        return nil
    }

    /// The failure pilotd recorded, when the action failed.
    public var error: String? { phase == .failed ? result?["error"]?.string ?? "Failed" : nil }

    /// The chat the action started, messaged or attached, when known.
    public var chatId: String? {
        result?["sessionId"]?.string ?? result?["coordinator"]?["sessionId"]?.string ?? args["sessionId"]?.string
    }

    public var projectId: String? { args["projectId"]?.string ?? result?["projectId"]?.string }
    public var missionId: String? { result?["missionId"]?.string ?? args["missionId"]?.string }

    /// Characters kept from the action's text.
    public static let detailLimit = 160

    public static func title(for action: String) -> String {
        switch action {
        case "start": "Started a chat"
        case "send": "Sent a message"
        case "mission_create": "Created a mission"
        case "coordinator_start": "Started a mission coordinator"
        case "mission_attach": "Added a chat to a mission"
        case "memory_note": "Added a memory note"
        default: action.replacingOccurrences(of: "_", with: " ").capitalizedFirst
        }
    }

    /// Folds entries (newest first, as pilotd pages them) into one operation each, in order of their latest entry.
    /// An operation whose entries span two loaded pages folds the same way.
    public static func fold(_ entries: [ControlAuditEntry]) -> [ControlAuditOperation] {
        var order: [String] = []
        var latest: [String: ControlAuditEntry] = [:]
        var oldest: [String: Int] = [:]
        for entry in entries {
            if let current = latest[entry.operationId] {
                if entry.seq > current.seq { latest[entry.operationId] = entry }
            } else {
                order.append(entry.operationId)
                latest[entry.operationId] = entry
            }
            oldest[entry.operationId] = min(oldest[entry.operationId] ?? entry.seq, entry.seq)
        }
        return order.compactMap { id in
            guard let entry = latest[id] else { return nil }
            return ControlAuditOperation(operationId: id, action: entry.action, phase: entry.phase, at: entry.at,
                                         oldestSeq: oldest[id] ?? entry.seq, args: entry.args, result: entry.result)
        }
        .sorted { $0.at > $1.at }
    }

    static func line(_ text: String) -> String? {
        let collapsed = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !collapsed.isEmpty else { return nil }
        guard collapsed.count > detailLimit else { return collapsed }
        return collapsed.prefix(detailLimit).trimmingCharacters(in: .whitespaces) + "…"
    }
}

/// Words for a watch in the control chat's Watching list. Targets are named by the caller, which can resolve
/// chats, projects and missions; these cover what needs no lookup.
public enum WatchPresentation {
    /// The event as "when …" reads it: "When a chat settles".
    public static func event(_ event: WatchEvent, filter: WatchFilter? = nil) -> String {
        switch event {
        case .chatSettled:
            switch filter?.outcome {
            case .done: "Chat finishes"
            case .failed: "Chat fails"
            case .stopped: "Chat is stopped"
            case nil: "Chat settles"
            }
        case .chatFailed: "Chat fails"
        case .prMerged: "PR merges"
        case .prClosed: "PR closes"
        case .prReady: "PR is ready to merge"
        case .linearDone: "Linear issue is done"
        case .missionTaskDone: "Task is done"
        case .missionDone: "Mission is done"
        }
    }

    /// "Once" or "Every time", then the expiry when there is one.
    public static func mode(_ watch: Watch, now: Date = Date()) -> String {
        let mode = watch.mode == .once ? "Once" : "Every time"
        guard let expiresAt = watch.expiresAt else { return mode }
        let date = Date(timeIntervalSince1970: expiresAt / 1000)
        let style: Date.FormatStyle = Calendar.current.isDate(date, inSameDayAs: now)
            ? .dateTime.hour().minute() : .dateTime.month(.abbreviated).day().hour().minute()
        return "\(mode) · until \(date.formatted(style))"
    }

    /// "owner/repo#12" for a GitHub pull request URL, or the URL itself.
    public static func pullRequest(_ url: String) -> String {
        let parts = URL(string: url)?.pathComponents.filter { $0 != "/" } ?? []
        guard parts.count >= 4, parts[2] == "pull" else { return url }
        return "\(parts[0])/\(parts[1])#\(parts[3])"
    }

    /// What the watch looks at, named with the caller's lookups and a plain fallback when it is gone or unknown.
    public static func target(_ target: WatchTarget, chat: (String) -> String?, project: (String) -> String?,
                              mission: (String) -> String?) -> String {
        switch target.kind {
        case .chat: chat(target.id) ?? "A chat"
        case .chatPRs: "PRs of \(chat(target.id) ?? "a chat")"
        case .project: "Chats in \(project(target.id) ?? "a project")"
        case .mission: mission(target.id).map { "Mission \($0)" } ?? "A mission"
        case .pr: pullRequest(target.id)
        case .linear: target.id
        case .task:
            target.missionId.flatMap(mission).map { "A task in \($0)" } ?? "A mission task"
        }
    }

    /// The watch's note on one line, clipped like audit text. Untrusted: show as text.
    public static func note(_ watch: Watch) -> String? { ControlAuditOperation.line(watch.note) }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

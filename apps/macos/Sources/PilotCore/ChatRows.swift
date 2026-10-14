import Foundation

public enum ToolStatus: String, Equatable, Sendable {
    case pending
    case running
    case done
    case error
}

public struct ToolItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let arguments: JSONValue
    public let status: ToolStatus
    public let output: String
    public var artifact: ArtifactReference? = nil

    private var cachedSummary: ToolSummary?
    public var summary: ToolSummary { cachedSummary ?? ToolSummary(name: name, arguments: arguments) }

    init(id: String, name: String, arguments: JSONValue, status: ToolStatus, output: String, artifact: ArtifactReference? = nil) {
        self.id = id
        self.name = name
        self.arguments = arguments
        self.status = status
        self.output = output
        self.artifact = artifact
    }

    mutating func prepare(summary: ToolSummary) { cachedSummary = summary }

    public static func == (lhs: ToolItem, rhs: ToolItem) -> Bool {
        // A rendering cache must not change the identity or equality of a tool result.
        lhs.id == rhs.id && lhs.name == rhs.name && lhs.arguments == rhs.arguments
            && lhs.status == rhs.status && lhs.output == rhs.output && lhs.artifact == rhs.artifact
    }
}

/// One visual row of the chat. Consecutive tool calls are grouped.
public enum ChatRow: Identifiable, Equatable, Sendable {
    case user(id: String, text: String, timestamp: Double? = nil)
    /// Input the user did not type, such as mission messages, job results and PR follow-ups.
    case automatic(id: String, text: String, origin: InputOrigin, timestamp: Double? = nil)
    case text(id: String, text: String, timestamp: Double? = nil)
    case thinking(id: String, text: String, streaming: Bool)
    case tools(id: String, items: [ToolItem])
    case artifact(id: String, reference: ArtifactReference)
    /// A question the agent asked with ask_user. The reply follows as a user message.
    case question(id: String, question: AgentQuestion)
    case error(id: String, text: String)
    case notice(id: String, text: String)
    case event(ChatEvent)
    /// A turn's thinking, notes and tool calls before its answer, folded into one work line.
    case work(id: String, group: TurnWork)

    public var id: String {
        switch self {
        case let .event(event): event.id
        case let .user(id, _, _), let .text(id, _, _), let .thinking(id, _, _), let .tools(id, _), let .error(id, _),
             let .notice(id, _), let .artifact(id, _), let .automatic(id, _, _, _), let .question(id, _),
             let .work(id, _):
            id
        }
    }

    /// The row itself, or the thinking, notes and tool groups folded into a work row.
    public var unfolded: [ChatRow] {
        if case let .work(_, group) = self { return group.rows }
        return [self]
    }

    public var isWork: Bool {
        if case .work = self { return true }
        return false
    }
}

extension Transcript {
    public var rows: [ChatRow] {
        renderRows(entries: entries, streaming: streaming, error: error, context: rowContext)
    }

    struct RowContext {
        let results: [String: ChatMessage]
        let published: Set<String>
    }

    var rowContext: RowContext {
        RowContext(results: results, published: Set(entries.compactMap(\.artifact).map {
            "\($0.sessionId)/\($0.id)/\($0.revision)"
        }))
    }

    // Separating committed history from the streaming suffix lets the processor reuse
    // history on every text delta. Both paths use the same identity/grouping rules.
    func renderRows(entries: [Entry], streaming: ChatMessage?, error: String?, context: RowContext) -> [ChatRow] {
        var rows: [ChatRow] = []
        // Thinking, text and tool groups since the last other row. Text after the last step is the answer;
        // everything before it folds into one work row.
        var run: [ChatRow] = []
        var runStart: Double?
        var runEnd: Double?

        func flushRun() {
            guard !run.isEmpty else { return }
            var split = run.count
            while split > 0, case .text = run[split - 1] { split -= 1 }
            if split > 0 {
                rows.append(.work(id: run[0].id, group: TurnWork(
                    rows: Array(run[..<split]), startedAt: runStart, endedAt: runEnd)))
            }
            rows.append(contentsOf: run[split...])
            run = []
            runStart = nil
            runEnd = nil
        }

        func note(_ timestamp: Double?) {
            guard let timestamp else { return }
            runStart = min(runStart ?? timestamp, timestamp)
            runEnd = max(runEnd ?? timestamp, timestamp)
        }

        func append(_ row: ChatRow) {
            switch row {
            case let .tools(_, items):
                // Merge adjacent tool groups, also across assistant messages.
                if case let .tools(id, previous)? = run.last {
                    run[run.count - 1] = .tools(id: id, items: previous + items)
                } else {
                    run.append(row)
                }
            case .thinking, .text:
                run.append(row)
            default:
                flushRun()
                if case var .event(event) = row, case let .event(previous) = rows.last,
                   previous.canCollapse(with: event) {
                    let latest = event.timestamp
                    let doubt = previous.uncertainty ?? event.uncertainty
                    event = previous
                    event.uncertainty = doubt
                    event.endTimestamp = latest
                    event.count += 1
                    rows[rows.count - 1] = .event(event)
                } else { rows.append(row) }
            }
        }

        func appendAssistant(_ message: ChatMessage, id: String, streaming: Bool) {
            for (index, block) in message.blocks.enumerated() {
                let blockId = "\(id)-\(index)"
                let isLast = index == message.blocks.count - 1
                switch block {
                case let .text(text) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                    note(message.timestamp)
                    append(.text(id: blockId, text: text, timestamp: message.timestamp))
                case let .thinking(text) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                    note(message.timestamp)
                    append(.thinking(id: blockId, text: text, streaming: streaming && isLast))
                case let .toolCall(callId, name, arguments):
                    // A recorded question renders as its own row; keep the card only for a failed call.
                    if name == AgentQuestion.toolName, let result = context.results[callId], !result.isError { break }
                    let item = tool(callId, name: name, arguments: arguments, context: context)
                    note(message.timestamp)
                    note(context.results[callId]?.timestamp)
                    append(.tools(id: blockId, items: [item]))
                default:
                    break
                }
            }
            if message.stopReason == "error", let error = message.errorMessage {
                append(.error(id: "\(id)-error", text: error))
            } else if message.stopReason == "aborted" {
                append(.event(ChatEvent(id: "\(id)-aborted", kind: "stopped", text: "Stopped", timestamp: message.timestamp)))
            }
        }

        for entry in entries {
            switch entry.kind {
            case "pilot.activity":
                if let text = entry.activity {
                    let summary = entry.eventSummary
                    append(.event(ChatEvent(id: "\(entry.id)", kind: summary?.kind ?? "activity",
                                           text: summary?.text ?? text, timestamp: entry.messages.first?.timestamp,
                                           detail: summary == nil ? nil : text)))
                }
            case "pilot.github-event":
                if let action = entry.githubAction { append(.event(action.event)) }
            case "pilot.artifact":
                if let artifact = entry.artifact { append(.artifact(id: "\(entry.id)-artifact", reference: artifact)) }
            case AgentQuestion.entryKind:
                if let question = entry.question { append(.question(id: "\(entry.id)-question", question: question)) }
            case "pi.compaction", "pi.reset":
                let compacted = entry.kind == "pi.compaction"
                var text = compacted ? "Context compacted" : "Context reset"
                if let before = entry.data?["tokensBefore"]?.int, let after = entry.data?["tokensAfter"]?.int {
                    let tokens = { (value: Int) in value >= 1000 ? "\(value / 1000)k" : String(value) }
                    text += " · \(tokens(before)) to \(tokens(after)) tokens"
                }
                let detail = entry.data?["summary"]?.string
                    ?? entry.messages.map(\.text).filter { !$0.isEmpty }.joined(separator: "\n")
                append(.event(ChatEvent(id: "\(entry.id)", kind: entry.kind, text: text,
                                       timestamp: entry.messages.first?.timestamp,
                                       uncertainty: entry.data?["tokensEstimated"]?.bool == true ? "Token counts are estimates." : nil,
                                       detail: detail.isEmpty ? nil : detail)))
            default:
                for (index, message) in entry.messages.enumerated() {
                    let id = "\(entry.id)-\(index)"
                    switch message.role {
                    case "user":
                        if entry.origin == .mission {
                            let summary = entry.eventSummary
                            append(.event(ChatEvent(id: id, kind: summary?.kind ?? "mission_updated",
                                                   text: summary?.text ?? "Mission updated",
                                                   timestamp: message.timestamp, detail: message.text)))
                        } else if let origin = entry.origin {
                            append(.automatic(id: id, text: message.text, origin: origin, timestamp: message.timestamp))
                        } else {
                            append(.user(id: id, text: message.text, timestamp: message.timestamp))
                        }
                    case "assistant": appendAssistant(message, id: id, streaming: false)
                    default: break
                    }
                }
            }
        }
        if let streaming { appendAssistant(streaming, id: "streaming", streaming: true) }
        if let error { append(.error(id: "transcript-error", text: error)) }
        flushRun()
        return rows
    }

    func tool(_ callId: String, name: String, arguments: JSONValue, context: RowContext) -> ToolItem {
        var item = tool(callId, name: name, arguments: arguments, results: context.results)
        if let artifact = item.artifact,
           context.published.contains("\(artifact.sessionId)/\(artifact.id)/\(artifact.revision)") { item.artifact = nil }
        return item
    }

    private func tool(_ callId: String, name: String, arguments: JSONValue, results: [String: ChatMessage]) -> ToolItem {
        if let result = results[callId] {
            let action = arguments["action"]?.string
            let publicationTool = name == "artifact_create" || name == "artifact_update"
                || (name == "artifact" && (action == "create" || action == "update"))
            return ToolItem(id: callId, name: name, arguments: arguments, status: result.isError ? .error : .done,
                            output: result.text, artifact: publicationTool ? result.artifact : nil)
        }
        let live = tools[callId]
        let status: ToolStatus = switch live?.status {
        case "running": .running
        case "done": .done
        default: .pending
        }
        return ToolItem(id: callId, name: name, arguments: arguments, status: status, output: live?.output ?? "")
    }
}

/// A short, human description of a tool call.
public struct ToolSummary: Equatable, Sendable {
    /// What a call did, for work-line counts and step sentences.
    public enum Kind: Equatable, Sendable {
        case read, edit, command, script, search, fetch, other
    }

    public let icon: String
    public let title: String
    public let detail: String?
    /// The most useful argument to show expanded (a command, script or patch), else nil for JSON.
    public let body: String?
    /// Line diffs for edits (applyPatch, edit, write), for stats and colored rendering.
    public let diffs: [FileDiff]
    public let kind: Kind
    /// The verb phrase a step sentence starts with ("Ran", "Read", "Searched the web for").
    public let verb: String

    public let additions: Int
    public let deletions: Int

    public init(name: String, arguments: JSONValue) {
        let string = { (key: String) in arguments[key]?.string }
        var diffs: [FileDiff] = []
        var kind = Kind.other
        var verb: String?
        switch name {
        case "bash":
            icon = "terminal"
            title = "Ran command"
            detail = string("command").map(Self.firstLine)
            body = string("command")
            kind = .command
        case "codemode":
            let code = string("code") ?? ""
            icon = "curlybraces"
            if let command = Self.match(code, #"tools\.bash\(\{\s*command:\s*"((?:[^"\\]|\\.)*)""#) {
                title = "Ran command"
                detail = Self.firstLine(command.replacingOccurrences(of: "\\\"", with: "\""))
                kind = .command
            } else if let path = Self.match(code, #"tools\.read\(\{\s*path:\s*"([^"]*)""#) {
                title = "Read file"
                detail = path
                kind = .read
            } else if Self.match(code, #"(tools\.applyPatch)"#) != nil {
                title = "Edited files"
                detail = Self.patchedFiles(code)
                kind = .edit
            } else {
                title = "Ran script"
                detail = Self.firstLine(code)
                kind = .script
                verb = "Ran a script"
            }
            body = code
        case "read":
            icon = "doc.text"
            title = "Read file"
            detail = string("path")
            body = nil
            kind = .read
        case "edit", "write":
            icon = "pencil"
            title = name == "edit" ? "Edited file" : "Wrote file"
            detail = string("path")
            body = string("content") ?? string("newText")
            kind = .edit
            verb = name == "edit" ? "Edited" : "Wrote"
            let path = string("path") ?? "file"
            if name == "write", let content = string("content") {
                diffs = [Diff.parseEdit(path: path, old: "", new: content)]
            } else if let old = string("oldText"), let new = string("newText") {
                diffs = [Diff.parseEdit(path: path, old: old, new: new)]
            } else if let edits = arguments["edits"]?.array {
                diffs = edits.compactMap { edit in
                    guard let old = edit["oldText"]?.string, let new = edit["newText"]?.string else { return nil }
                    return Diff.parseEdit(path: path, old: old, new: new)
                }
            }
        case "applyPatch":
            icon = "pencil"
            title = "Edited files"
            detail = string("patch").flatMap(Self.patchedFiles)
            body = string("patch")
            diffs = string("patch").map(Diff.parsePatch) ?? []
            kind = .edit
        case "web_search":
            icon = "magnifyingglass"
            title = "Searched the web"
            detail = string("query")
            body = nil
            kind = .search
            verb = "Searched the web for"
        case "fetch_content":
            icon = "globe"
            title = "Fetched page"
            detail = string("url")
            body = nil
            kind = .fetch
            verb = "Fetched"
        case "subagent":
            icon = "person.2"
            title = "Subagent \(string("action") ?? "")".trimmingCharacters(in: .whitespaces)
            detail = string("name")
            body = string("message")
            verb = title
        default:
            icon = name.hasPrefix("mcp__") ? "puzzlepiece.extension" : "wrench.and.screwdriver"
            title = name.replacingOccurrences(of: "_", with: " ")
            detail = Self.firstStringArgument(arguments).map(Self.firstLine)
            body = nil
            let words = name.split(separator: "_", omittingEmptySubsequences: true)
            verb = "Used " + (name.hasPrefix("mcp__") ? words.dropFirst() : words[...]).joined(separator: " ")
        }
        self.diffs = diffs
        self.kind = kind
        self.verb = verb ?? {
            switch kind {
            case .read: "Read"
            case .edit: "Edited"
            case .command, .script: "Ran"
            case .search: "Searched for"
            case .fetch: "Fetched"
            case .other: "Used"
            }
        }()
        additions = diffs.reduce(0) { $0 + $1.additions }
        deletions = diffs.reduce(0) { $0 + $1.deletions }
    }

    /// What a step sentence names after its verb: file names for reads and edits, else the detail.
    public var subject: String? {
        guard let detail, !detail.isEmpty else { return nil }
        switch kind {
        case .read, .edit:
            if !diffs.isEmpty {
                return Self.names(diffs.map { URL(filePath: $0.path).lastPathComponent })
            }
            return detail.contains(", ") ? detail : URL(filePath: detail).lastPathComponent
        default:
            return detail
        }
    }

    /// The files a read or edit touched, for distinct counts. Nil for other calls.
    var paths: [String] {
        switch kind {
        case .edit where !diffs.isEmpty: diffs.map(\.path)
        case .read, .edit: detail.map { $0.components(separatedBy: ", ") } ?? []
        default: []
        }
    }

    /// "a, b and 2 more": a bounded list of names for one sentence.
    static func names(_ names: [String], limit: Int = 3) -> String {
        var unique: [String] = []
        for name in names where !unique.contains(name) { unique.append(name) }
        guard unique.count > limit else { return unique.joined(separator: ", ") }
        return unique.prefix(limit).joined(separator: ", ") + " and \(unique.count - limit) more"
    }

    private static func firstLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return line.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
    }

    private static func match(_ text: String, _ pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let found = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(found.range(at: 1), in: text)
        else { return nil }
        return String(text[range])
    }

    private static func patchedFiles(_ patch: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: #"\*\*\* (?:Update|Add|Delete) File: ([^\n"\\]+)"#) else { return nil }
        let names = regex.matches(in: patch, range: NSRange(patch.startIndex..., in: patch)).compactMap {
            Range($0.range(at: 1), in: patch).map { URL(filePath: String(patch[$0])).lastPathComponent }
        }
        return names.isEmpty ? nil : names.joined(separator: ", ")
    }

    private static func firstStringArgument(_ arguments: JSONValue) -> String? {
        guard case let .object(object) = arguments else { return nil }
        return object.keys.sorted().lazy.compactMap { object[$0]?.string }.first
    }
}

/// Conversation points a row offers to continue from. Only committed rows qualify: streaming rows and the live
/// error row have no durable entry yet.
extension ChatRow {
    /// The durable entry a committed row was rendered from. Row IDs start with the entry ID.
    public var entryID: Int? {
        guard let prefix = id.split(separator: "-", maxSplits: 1).first, let value = Int(prefix), value > 0 else { return nil }
        return value
    }

    /// Edit for messages the user typed, restore for agent replies, retry for a failed turn.
    public var rewindAction: RewindAction? {
        guard entryID != nil else { return nil }
        switch self {
        case .user: return .edit
        case .text: return .restore
        case .error: return .retry
        default: return nil
        }
    }
}

extension TranscriptPresentation {
    /// The failed turn the chat offers to retry: a committed error that is the transcript's last row while idle.
    public var retryEntryID: Int? {
        guard !working, !streaming, let last = liveRows.last ?? historyRows.last, last.rewindAction == .retry else { return nil }
        return last.entryID
    }
}

/// A turn's thinking, notes and tool calls before its answer, shown as one folded work line.
public struct TurnWork: Equatable, Sendable {
    /// Thinking, text note and tool group rows, in order.
    public var rows: [ChatRow]
    /// Epoch milliseconds of the first and last message the work spans, when known.
    public var startedAt: Double?
    public var endedAt: Double?

    public init(rows: [ChatRow], startedAt: Double? = nil, endedAt: Double? = nil) {
        self.rows = rows
        self.startedAt = startedAt
        self.endedAt = endedAt
    }

    public var tools: [ToolItem] {
        rows.flatMap { row -> [ToolItem] in
            if case let .tools(_, items) = row { return items }
            return []
        }
    }

    /// Continue with later work of the same turn, such as the streamed message after committed steps.
    public func appending(_ other: TurnWork) -> TurnWork {
        var rows = rows
        for row in other.rows {
            if case let .tools(id, previous)? = rows.last, case let .tools(_, items) = row {
                rows[rows.count - 1] = .tools(id: id, items: previous + items)
            } else {
                rows.append(row)
            }
        }
        let starts = [startedAt, other.startedAt].compactMap { $0 }
        let ends = [endedAt, other.endedAt].compactMap { $0 }
        return TurnWork(rows: rows, startedAt: starts.min(), endedAt: ends.max())
    }

    /// Steps as sentences: consecutive successful reads merge into one.
    public var steps: [WorkStep] {
        var steps: [WorkStep] = []
        for row in rows {
            switch row {
            case let .thinking(id, text, streaming): steps.append(.thinking(id: id, text: text, streaming: streaming))
            case let .text(id, text, _): steps.append(.note(id: id, text: text))
            case let .tools(_, items):
                for item in items {
                    let mergeable = item.summary.kind == .read && item.status == .done
                    if mergeable, case let .reads(id, previous)? = steps.last {
                        steps[steps.count - 1] = .reads(id: id, items: previous + [item])
                    } else if mergeable, case let .tool(previous)? = steps.last,
                              previous.summary.kind == .read, previous.status == .done {
                        steps[steps.count - 1] = .reads(id: previous.id, items: [previous, item])
                    } else {
                        steps.append(.tool(item))
                    }
                }
            default: break
            }
        }
        return steps
    }

    /// The turn's work ended on a failed step, so the line stays open.
    public var endedOnFailure: Bool { tools.last?.status == .error }

    public var failureCount: Int { tools.reduce(0) { $0 + ($1.status == .error ? 1 : 0) } }

    /// "Worked for 3 min" and "read 3 files, edited 1, ran 2 commands". While active the lead is "Working".
    public func summary(active: Bool) -> (lead: String, detail: String?) {
        let tools = tools
        let detail = Self.counts(tools)
        if active { return ("Working", detail) }
        let verb = tools.isEmpty ? "Thought" : "Worked"
        guard let startedAt, let endedAt, let duration = Self.duration(endedAt - startedAt) else { return (verb, detail) }
        return ("\(verb) for \(duration)", detail)
    }

    /// "12s", "3 min", "1 h 5 min", or nil under a second.
    public static func duration(_ milliseconds: Double) -> String? {
        let seconds = Int(milliseconds / 1000)
        guard seconds >= 1 else { return nil }
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes) min" }
        return minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min"
    }

    static func counts(_ tools: [ToolItem]) -> String? {
        var reads = Set<String>()
        var edits = Set<String>()
        var readCalls = 0, editCalls = 0, commands = 0, scripts = 0, searches = 0, fetches = 0, other = 0
        for tool in tools {
            let summary = tool.summary
            switch summary.kind {
            case .read: readCalls += 1; reads.formUnion(summary.paths)
            case .edit: editCalls += 1; edits.formUnion(summary.paths)
            case .command: commands += 1
            case .script: scripts += 1
            case .search: searches += 1
            case .fetch: fetches += 1
            case .other: other += 1
            }
        }
        func plural(_ count: Int, _ noun: String) -> String { "\(count) \(noun)\(count == 1 ? "" : "s")" }
        var parts: [String] = []
        if readCalls > 0 { parts.append("read " + plural(max(reads.count, 1), "file")) }
        if editCalls > 0 {
            let count = max(edits.count, 1)
            parts.append(readCalls > 0 ? "edited \(count)" : "edited " + plural(count, "file"))
        }
        if commands > 0 { parts.append("ran " + plural(commands, "command")) }
        if scripts > 0 { parts.append((commands > 0 ? "" : "ran ") + plural(scripts, "script")) }
        if searches > 0 { parts.append(searches == 1 ? "searched the web" : "searched the web \(searches) times") }
        if fetches > 0 { parts.append("fetched " + plural(fetches, "page")) }
        if other > 0 { parts.append("used " + plural(other, "tool")) }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}

/// One line inside an open work row.
public enum WorkStep: Identifiable, Equatable, Sendable {
    case thinking(id: String, text: String, streaming: Bool)
    /// Text the agent wrote between steps, before its answer.
    case note(id: String, text: String)
    case tool(ToolItem)
    /// Consecutive successful reads, as one sentence.
    case reads(id: String, items: [ToolItem])

    public var id: String {
        switch self {
        case let .thinking(id, _, _), let .note(id, _), let .reads(id, _): id
        case let .tool(item): item.id
        }
    }

    /// The step sentence: a verb, then what it acted on.
    public var sentence: (verb: String, subject: String?) {
        switch self {
        case let .thinking(_, _, streaming): (streaming ? "Thinking…" : "Thought", nil)
        case .note: ("", nil)
        case let .tool(item): (item.summary.verb, item.summary.subject)
        case let .reads(_, items): ("Read", ToolSummary.names(items.compactMap(\.summary.subject)))
        }
    }
}

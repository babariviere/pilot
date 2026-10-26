import Foundation

/// One content block of a pi-ai message.
public enum Block: Equatable, Sendable {
    case text(String)
    case thinking(String)
    case toolCall(id: String, name: String, arguments: JSONValue)
    case image
    case other

    init(json: JSONValue) {
        switch json["type"]?.string {
        case "text": self = .text(json["text"]?.string ?? "")
        case "thinking": self = .thinking(json["thinking"]?.string ?? "")
        case "toolCall":
            self = .toolCall(
                id: json["id"]?.string ?? "",
                name: json["name"]?.string ?? "tool",
                arguments: json["arguments"] ?? .object([:])
            )
        case "image": self = .image
        default: self = .other
        }
    }
}

public struct ChatMessage: Equatable, Sendable {
    public var role: String
    /// pi-ai's original epoch-millisecond message time, never the client receipt time.
    public var timestamp: Double?
    public var blocks: [Block]
    public var toolCallId: String?
    public var isError: Bool
    public var stopReason: String?
    public var errorMessage: String?
    public var artifact: ArtifactReference?

    public init(json: JSONValue) {
        role = json["role"]?.string ?? "unknown"
        timestamp = json["timestamp"]?.number.flatMap { MessageTimeFormatting.date($0) == nil ? nil : $0 }
        if let text = json["content"]?.string {
            blocks = [.text(text)]
        } else {
            blocks = (json["content"]?.array ?? []).map(Block.init(json:))
        }
        toolCallId = json["toolCallId"]?.string
        isError = json["isError"]?.bool ?? false
        stopReason = json["stopReason"]?.string
        errorMessage = json["errorMessage"]?.string
        artifact = role == "toolResult" && !isError ? ArtifactReference.fromToolResult(json) : nil
    }

    public var text: String {
        blocks.compactMap { block in
            switch block {
            case let .text(text): text
            case .image: "[image]"
            default: nil
            }
        }.joined()
    }
}

/// A committed transcript entry (pi-durable `EntryRecord`).
public struct Entry: Identifiable, Equatable, Sendable {
    public let id: Int
    public let kind: String
    /// First entry still in context, on a compaction or reset marker. Earlier entries are hidden from the snapshot.
    public let head: Int?
    public let messages: [ChatMessage]
    public let artifact: ArtifactReference?
    public let activity: String?
    public let eventSummary: ChatEventSummary?
    public let githubAction: GitHubAction?
    public let data: JSONValue?
    /// A question from ask_user, on `pilot.question` entries.
    public let question: AgentQuestion?
    /// Set on user entries that were automatic input. Unknown future origins read as extension input.
    public let origin: InputOrigin?
    /// Display-only sender projected from durable submission provenance. Never inferred from message text.
    public let sourceSessionId: String?

    public init?(json: JSONValue) {
        guard let id = json["id"]?.int else { return nil }
        self.id = id
        kind = json["kind"]?.string ?? ""
        head = json["head"]?.int
        messages = (json["model"]?.array ?? []).map(ChatMessage.init(json:))
        artifact = kind == "pilot.artifact" ? ArtifactReference.fromToolResult(.object(["details": json["data"] ?? .null])) : nil
        data = json["data"]
        eventSummary = ChatEventSummary(json: json["data"]?["event"])
        githubAction = kind == "pilot.github-event" ? json["data"].flatMap(GitHubAction.init(json:)) : nil
        activity = kind == "pilot.activity" ? json["data"]?["text"]?.string : nil
        question = kind == AgentQuestion.entryKind ? AgentQuestion(entryID: id, data: json["data"]) : nil
        origin = json["origin"]?.string.map { InputOrigin(rawValue: $0) ?? .extension }
        sourceSessionId = origin == nil ? nil : json["sourceSessionId"]?.string
    }
}

public struct LiveTool: Equatable, Sendable {
    public var callId: String
    public var name: String
    public var output: String
    public var status: String
}

/// Mirrors packages/protocol's QueuedMessage, not the agent stream's content-free inbox IDs.
public struct QueuedMessage: Identifiable, Codable, Equatable, Sendable {
    public let guardToken: String?
    public let id: Int
    public let mode: DeliveryMode
    public let text: String

    public init?(json: JSONValue) {
        guard let id = json["id"]?.int,
              let rawMode = json["mode"]?.string,
              let mode = DeliveryMode(rawValue: rawMode)
        else { return nil }
        self.id = id
        self.mode = mode
        guardToken = json["guardToken"]?.string
        text = ChatMessage(json: .object(["role": .string("user"), "content": json["content"] ?? .string("")])).text
    }
}

/// Mirrors packages/protocol's PendingAutomaticInput: a system message waiting to join a run. Read-only.
public struct PendingAutomaticInput: Identifiable, Equatable, Sendable {
    public let id: Int
    public let origin: InputOrigin
    public let mode: DeliveryMode
    public let preview: String
    /// Epoch milliseconds.
    public let queuedAt: Double
    public let held: Bool

    public init(id: Int, origin: InputOrigin, mode: DeliveryMode, preview: String, queuedAt: Double, held: Bool = false) {
        self.id = id
        self.origin = origin
        self.mode = mode
        self.preview = preview
        self.queuedAt = queuedAt
        self.held = held
    }

    public init?(json: JSONValue) {
        guard let id = json["id"]?.int,
              let mode = json["mode"]?.string.flatMap(DeliveryMode.init(rawValue:))
        else { return nil }
        self.init(
            id: id,
            origin: json["origin"]?.string.map { InputOrigin(rawValue: $0) ?? .extension } ?? .extension,
            mode: mode,
            preview: json["preview"]?.string ?? "",
            queuedAt: json["queuedAt"]?.number ?? 0,
            held: json["held"]?.bool ?? false
        )
    }

    /// Steering joins the current run before follow-ups, like the user's own queue. FIFO within each mode.
    public static func inDeliveryOrder(_ inputs: [PendingAutomaticInput]) -> [PendingAutomaticInput] {
        inputs.filter { $0.mode == .steer } + inputs.filter { $0.mode == .followUp }
    }
}

/// Folds pi-durable agent events into a renderable transcript.
public struct Transcript: Equatable, Sendable {
    private var storedEntries: [Entry] = []
    /// Bounded activity projection, never part of transcript pagination or compaction ancestry.
    private var githubEntries: [Entry] = []
    /// Rebuilt only on committed/audit changes, never copied for streaming deltas.
    private var displayedEntries: [Entry] = []
    private var entryIDs: Set<Int> = []
    public var entries: [Entry] {
        get { githubEntries.isEmpty ? storedEntries : displayedEntries }
        set {
            guard storedEntries != newValue else { return }
            storedEntries = newValue
            if !githubEntries.isEmpty { rebuildDisplayedEntries() }
            entryIDs = Set(newValue.map(\.id))
            invalidateCommittedRows()
        }
    }
    // Rendering generations are deliberately excluded from value equality.
    var rowRevision: UInt64 = 0
    var committedRowRevision: UInt64 = 0
    /// In-flight assistant message, until its entry is committed.
    public var streaming: ChatMessage? {
        get { storedStreaming }
        set {
            guard storedStreaming != newValue else { return }
            storedStreaming = newValue
            rowRevision &+= 1
        }
    }
    private var storedStreaming: ChatMessage?
    private var storedTools: [String: LiveTool] = [:]
    public var tools: [String: LiveTool] {
        get { storedTools }
        set {
            guard storedTools != newValue else { return }
            storedTools = newValue
            invalidateCommittedRows()
        }
    }
    private var changedToolIDs: Set<String> = []
    public var working = false
    public var queuedMessages: [QueuedMessage] = []
    /// System messages waiting to join a run, in submission order.
    public var automaticInputs: [PendingAutomaticInput] = []
    public var todos: [SessionTodo] = []
    public var queued: Int { queuedMessages.count }
    public var retry: String?
    /// Running compaction task IDs. Manual compactions can run while no run is active.
    private var compactionTasks: Set<Int> = []
    public var compacting: Bool { !compactionTasks.isEmpty }
    /// Pass as `before` to load the next older page hidden by compaction or reset; nil when none remain.
    public private(set) var earlierCursor: Int?
    /// Where the snapshot's active transcript starts. Earlier pages stay valid only while this is unchanged.
    private var activeStart: Int?
    /// Loaded history kept across a replacement snapshot that is split: its older entries follow in
    /// `snapshot_prefix`, and only then is the active transcript, and so its start, known.
    private var pendingPrefix: KeptHistory?

    private struct KeptHistory: Sendable {
        var activeStart: Int?
        var earlierCursor: Int?
        var earlier: [Entry]
    }
    public var error: String? {
        didSet { if error != oldValue { rowRevision &+= 1 } }
    }

    public init() {}

    /// Client-side event carrying one page of `GET /api/sessions/:id/history` (`SessionHistoryPage`).
    public static let earlierEntriesEvent = "pilot.earlier_entries"

    /// Wraps a decoded history page so it is reduced in order with the live stream.
    public static func earlierEntries(before: Int, page: JSONValue) -> JSONValue {
        .object([
            "type": .string(earlierEntriesEvent),
            "before": .number(Double(before)),
            "entries": page["entries"] ?? .array([]),
            "more": page["more"] ?? .bool(false),
        ])
    }

    public static func == (lhs: Transcript, rhs: Transcript) -> Bool {
        lhs.entries == rhs.entries && lhs.streaming == rhs.streaming && lhs.tools == rhs.tools
            && lhs.working == rhs.working && lhs.queuedMessages == rhs.queuedMessages
            && lhs.automaticInputs == rhs.automaticInputs
            && lhs.todos == rhs.todos && lhs.retry == rhs.retry && lhs.error == rhs.error
            && lhs.compactionTasks == rhs.compactionTasks
            && lhs.earlierCursor == rhs.earlierCursor
    }

    private mutating func invalidateCommittedRows() {
        committedRowRevision &+= 1
        rowRevision &+= 1
    }

    /// Event updates compare only the changed tool, not the entire historical tool dictionary.
    private mutating func setTool(_ tool: LiveTool) {
        guard storedTools[tool.callId] != tool else { return }
        storedTools[tool.callId] = tool
        changedToolIDs.insert(tool.callId)
        rowRevision &+= 1
    }

    mutating func takeChangedToolIDs() -> Set<String> {
        let ids = changedToolIDs
        changedToolIDs.removeAll(keepingCapacity: true)
        return ids
    }

    /// Steering joins the current run before follow-ups. Keep FIFO order within each delivery mode.
    public var queuedMessagesInDeliveryOrder: [QueuedMessage] {
        queuedMessages.filter { $0.mode == .steer } + queuedMessages.filter { $0.mode == .followUp }
    }

    /// Tool results by call ID; they render inside their call's card.
    public var results: [String: ChatMessage] {
        var results: [String: ChatMessage] = [:]
        for entry in entries {
            for message in entry.messages where message.role == "toolResult" {
                if let id = message.toolCallId { results[id] = message }
            }
        }
        return results
    }

    public mutating func apply(_ events: [JSONValue]) {
        for event in events { apply(event) }
    }

    public mutating func apply(_ event: JSONValue) {
        switch event["type"]?.string {
        case "snapshot":
            // Queue contents have their own exact-frame watch. An agent stream overflow snapshot
            // must not erase them; reconnects deliver a fresh queue_update after the snapshot.
            let queue = queuedMessages
            let automatic = automaticInputs
            let savedTodos = todos
            let savedGitHubEntries = githubEntries
            let savedRowRevision = rowRevision
            let savedCommittedRevision = committedRowRevision
            // A split snapshot replacing another split snapshot still keeps the history of the last complete one.
            let kept = pendingPrefix ?? KeptHistory(
                activeStart: activeStart, earlierCursor: earlierCursor,
                earlier: activeStart.map { start in storedEntries.filter { $0.id < start } } ?? []
            )
            self = Transcript()
            queuedMessages = queue
            automaticInputs = automatic
            todos = savedTodos
            githubEntries = savedGitHubEntries
            displayedEntries = []
            let active = (event["entries"]?.array ?? []).compactMap(Entry.init(json:))
            if event["prefixPending"]?.bool == true {
                // The newest entries paint first. No earlier page is offered until the prefix completes the snapshot.
                pendingPrefix = kept
                entries = active.sorted { $0.id < $1.id }
            } else {
                setActive(active, kept: kept)
            }
            if let message = event["generation"]?["message"], !message.isNull { streaming = ChatMessage(json: message) }
            for tool in event["tools"]?.array ?? [] {
                guard let id = tool["callId"]?.string else { continue }
                storedTools[id] = LiveTool(
                    callId: id,
                    name: tool["name"]?.string ?? "tool",
                    output: tool["output"]?.string ?? "",
                    status: tool["status"]?.string ?? "pending"
                )
            }
            working = event["run"].map { !$0.isNull } ?? false
            retry = event["generation"]?["retry"]?["error"]?.string
            compactionTasks = Set((event["compactions"]?.array ?? []).compactMap { $0["taskId"]?.int })
            // A replacement always invalidates rendering context, including result and
            // artifact lookups. Never reuse a previous snapshot's generation numbers.
            rowRevision = savedRowRevision &+ 1
            committedRowRevision = savedCommittedRevision &+ 1
        case "snapshot_prefix":
            // Completes a split snapshot. Live events cannot precede it, so everything held is the snapshot's tail.
            guard let kept = pendingPrefix else { return }
            pendingPrefix = nil
            let prefix = (event["entries"]?.array ?? []).compactMap(Entry.init(json:)).filter { !entryIDs.contains($0.id) }
            setActive(prefix + storedEntries, kept: kept)
        case Transcript.earlierEntriesEvent:
            // Only the page that was asked for: stale or duplicate pages are ignored.
            guard let before = event["before"]?.int, before == earlierCursor else { return }
            let page = (event["entries"]?.array ?? []).compactMap(Entry.init(json:))
                .filter { $0.id < before && !entryIDs.contains($0.id) }
            if !page.isEmpty { entries = (page + storedEntries).sorted { $0.id < $1.id } }
            let oldest = page.map(\.id).min()
            earlierCursor = event["more"]?.bool == true ? oldest.flatMap { $0 > 1 ? $0 : nil } : nil
        case "run_start":
            working = true
            error = nil
        case "run_end":
            working = false
            streaming = nil
            retry = nil
        case "message_start":
            if let message = event["message"], message["role"]?.string == "assistant" {
                streaming = ChatMessage(json: message)
            }
        case "message_update":
            // Take the message out, so a delta appends to its text in place when nothing else shares it, and
            // never compare the whole message: a delta that changes something bumps the revision directly.
            guard var message = storedStreaming else { return }
            storedStreaming = nil
            var changed = false
            for change in event["changes"]?.array ?? [] { changed = Self.apply(change, to: &message) || changed }
            storedStreaming = message
            if changed { rowRevision &+= 1 }
            retry = nil
        case "message_end":
            streaming = nil
            if let entry = event["entry"].flatMap(Entry.init(json:)) { add(entry) }
        case "entry_appended":
            if let entry = event["entry"].flatMap(Entry.init(json:)) { add(entry) }
        case "tool_execution_start":
            guard let id = event["toolCallId"]?.string else { return }
            setTool(LiveTool(callId: id, name: event["toolName"]?.string ?? "tool", output: "", status: "running"))
        case "tool_execution_update":
            guard let id = event["toolCallId"]?.string, var tool = storedTools[id], let output = event["output"] else { return }
            if let set = output["set"]?.string {
                tool.output = set
            } else {
                let trim = max(0, output["trimStart"]?.int ?? 0)
                if trim > 0 { tool.output = String(tool.output.dropFirst(trim)) }
                tool.output += output["append"]?.string ?? ""
            }
            setTool(tool)
        case "tool_execution_end":
            guard let id = event["toolCallId"]?.string else { return }
            if var tool = storedTools[id] {
                tool.status = "done"
                setTool(tool)
            }
            if let entry = event["entry"].flatMap(Entry.init(json:)) { add(entry) }
        case "queue_update":
            queuedMessages = (event["items"]?.array ?? []).compactMap(QueuedMessage.init(json:))
            automaticInputs = (event["automatic"]?.array ?? []).compactMap(PendingAutomaticInput.init(json:))
        case "github_actions_update":
            let projected = Array((event["actions"]?.array ?? []).suffix(200)).enumerated().compactMap { index, action in
                Entry(json: .object([
                    "id": .number(Double(-index - 1)), "kind": .string("pilot.github-event"),
                    "data": action, "model": .array([]),
                ]))
            }
            if githubEntries != projected {
                githubEntries = projected
                rebuildDisplayedEntries()
                invalidateCommittedRows()
            }
        case "todos_update":
            todos = (event["items"]?.array ?? []).compactMap(SessionTodo.init(json:))
        case "auto_retry_start":
            retry = event["errorMessage"]?.string
        case "auto_retry_end":
            retry = nil
        case "compaction_start":
            if let id = event["taskId"]?.int { compactionTasks.insert(id) }
        case "compaction_end":
            if let id = event["taskId"]?.int { compactionTasks.remove(id) }
        case "task_failed":
            error = event["message"]?.string
        default:
            break
        }
    }

    /// Sets a complete snapshot's active transcript. Older entries are hidden only behind a compaction or reset
    /// marker; a reconnect or overflow snapshot keeps pages already loaded above the same head.
    private mutating func setActive(_ active: [Entry], kept: KeptHistory) {
        let start = active.contains { $0.head != nil } ? active.map { $0.head ?? $0.id }.min() : nil
        activeStart = start
        if let start, start == kept.activeStart {
            entries = (kept.earlier + active).sorted { $0.id < $1.id }
            earlierCursor = kept.earlierCursor
        } else {
            entries = active.sorted { $0.id < $1.id }
            earlierCursor = start.flatMap { $0 > 1 ? $0 : nil }
        }
    }

    private mutating func add(_ entry: Entry) {
        guard entryIDs.insert(entry.id).inserted else { return }
        let outOfOrder = storedEntries.last.map { $0.id > entry.id } ?? false
        storedEntries.append(entry)
        if outOfOrder { storedEntries.sort { $0.id < $1.id } }
        if !githubEntries.isEmpty { rebuildDisplayedEntries() }
        invalidateCommittedRows()
    }

    /// O(history + bounded audit), only on committed changes. Never touched by streaming deltas.
    private mutating func rebuildDisplayedEntries() {
        guard !githubEntries.isEmpty else { displayedEntries = []; return }
        let wantedCalls = Set(githubEntries.compactMap { $0.githubAction?.toolCallId })
        let wantedIDs = Set(githubEntries.compactMap { $0.githubAction?.afterEntryId })
        let legacy = githubEntries.compactMap(\.githubAction)
            .filter { $0.afterEntryId == nil && $0.toolCallId == nil }.sorted { $0.at < $1.at }
        var legacyAnchors = Array(repeating: -1, count: legacy.count)
        var calls: [String: Int] = [:]
        var indexes: [Int: Int] = [:]
        for (index, entry) in storedEntries.enumerated() {
            if wantedIDs.contains(entry.id) { indexes[entry.id] = index }
            if let time = entry.messages.compactMap(\.timestamp).min(), !legacy.isEmpty {
                var lo = 0, hi = legacy.count
                while lo < hi {
                    let mid = (lo + hi) / 2
                    if legacy[mid].at < time { lo = mid + 1 } else { hi = mid }
                }
                if lo < legacy.count { legacyAnchors[lo] = index }
            }
            for message in entry.messages {
                for block in message.blocks {
                    if case let .toolCall(id, _, _) = block, wantedCalls.contains(id) { calls[id] = index }
                }
            }
        }
        var legacyByID: [String: Int] = [:]
        var latest = -1
        for (index, action) in legacy.enumerated() {
            latest = max(latest, legacyAnchors[index])
            legacyByID[action.id] = latest < 0 ? storedEntries.count - 1 : latest
        }
        var after: [Int: [Entry]] = [:]
        for entry in githubEntries {
            guard let action = entry.githubAction else { continue }
            let anchor = action.afterEntryId.flatMap { indexes[$0] }
                ?? action.toolCallId.flatMap { calls[$0] }
            if let anchor {
                after[anchor, default: []].append(entry)
            } else if action.afterEntryId == nil && action.toolCallId == nil {
                // Old kernels supplied no position. Use their execution time without parsing the audit text.
                let anchor = legacyByID[action.id] ?? (storedEntries.count - 1)
                after[anchor, default: []].append(entry)
            }
            // Hidden by compaction, a split prefix, or another attempt: wait until its anchor is loaded.
        }
        var result: [Entry] = []
        result.reserveCapacity(storedEntries.count + githubEntries.count)
        result.append(contentsOf: after[-1] ?? [])
        for (index, entry) in storedEntries.enumerated() {
            result.append(entry)
            result.append(contentsOf: after[index] ?? [])
        }
        displayedEntries = result
    }

    /// Returns whether the change could alter the message.
    private static func apply(_ change: JSONValue, to message: inout ChatMessage) -> Bool {
        if change["type"]?.string == "message", let full = change["message"] {
            message = ChatMessage(json: full)
            return true
        }
        guard let index = change["contentIndex"]?.int, index >= 0 else { return false }
        var changed = false
        while message.blocks.count <= index {
            message.blocks.append(.other)
            changed = true
        }
        switch change["type"]?.string {
        case "text_start", "thinking_start", "toolcall_start", "block":
            if let block = change["block"] {
                message.blocks[index] = Block(json: block)
                changed = true
            }
        case "text_delta":
            if case var .text(text) = message.blocks[index], let delta = change["delta"]?.string, !delta.isEmpty {
                // Release the block's reference first, so the append does not copy the text when it is unshared.
                message.blocks[index] = .other
                text += delta
                message.blocks[index] = .text(text)
                changed = true
            }
        case "thinking_delta":
            if case var .thinking(text) = message.blocks[index], let delta = change["delta"]?.string, !delta.isEmpty {
                message.blocks[index] = .other
                text += delta
                message.blocks[index] = .thinking(text)
                changed = true
            }
        default:
            // toolcall_delta carries partial JSON arguments; the final "block" change replaces it.
            break
        }
        return changed
    }
}

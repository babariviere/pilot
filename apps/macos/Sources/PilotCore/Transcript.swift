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
    public let messages: [ChatMessage]
    public let artifact: ArtifactReference?

    public init?(json: JSONValue) {
        guard let id = json["id"]?.int else { return nil }
        self.id = id
        kind = json["kind"]?.string ?? ""
        messages = (json["model"]?.array ?? []).map(ChatMessage.init(json:))
        artifact = kind == "pilot.artifact" ? ArtifactReference.fromToolResult(.object(["details": json["data"] ?? .null])) : nil
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
        text = ChatMessage(json: .object(["role": .string("user"), "content": json["content"] ?? .string("")])).text
    }
}

/// Folds pi-durable agent events into a renderable transcript.
public struct Transcript: Equatable, Sendable {
    private var storedEntries: [Entry] = []
    private var entryIDs: Set<Int> = []
    public var entries: [Entry] {
        get { storedEntries }
        set {
            guard storedEntries != newValue else { return }
            storedEntries = newValue
            entryIDs = Set(newValue.map(\.id))
            invalidateCommittedRows()
        }
    }
    // Rendering generations are deliberately excluded from value equality.
    var rowRevision: UInt64 = 0
    var committedRowRevision: UInt64 = 0
    /// In-flight assistant message, until its entry is committed.
    public var streaming: ChatMessage? {
        didSet { if streaming != oldValue { rowRevision &+= 1 } }
    }
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
    public var todos: [SessionTodo] = []
    public var queued: Int { queuedMessages.count }
    public var retry: String?
    public var error: String? {
        didSet { if error != oldValue { rowRevision &+= 1 } }
    }

    public init() {}

    public static func == (lhs: Transcript, rhs: Transcript) -> Bool {
        lhs.entries == rhs.entries && lhs.streaming == rhs.streaming && lhs.tools == rhs.tools
            && lhs.working == rhs.working && lhs.queuedMessages == rhs.queuedMessages
            && lhs.todos == rhs.todos && lhs.retry == rhs.retry && lhs.error == rhs.error
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
            let savedTodos = todos
            let savedRowRevision = rowRevision
            let savedCommittedRevision = committedRowRevision
            self = Transcript()
            queuedMessages = queue
            todos = savedTodos
            entries = (event["entries"]?.array ?? []).compactMap(Entry.init(json:)).sorted { $0.id < $1.id }
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
            // A replacement always invalidates rendering context, including result and
            // artifact lookups. Never reuse a previous snapshot's generation numbers.
            rowRevision = savedRowRevision &+ 1
            committedRowRevision = savedCommittedRevision &+ 1
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
            guard var message = streaming else { return }
            for change in event["changes"]?.array ?? [] { Self.apply(change, to: &message) }
            streaming = message
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
        case "todos_update":
            todos = (event["items"]?.array ?? []).compactMap(SessionTodo.init(json:))
        case "auto_retry_start":
            retry = event["errorMessage"]?.string
        case "auto_retry_end":
            retry = nil
        case "task_failed":
            error = event["message"]?.string
        default:
            break
        }
    }

    private mutating func add(_ entry: Entry) {
        guard entryIDs.insert(entry.id).inserted else { return }
        let outOfOrder = storedEntries.last.map { $0.id > entry.id } ?? false
        storedEntries.append(entry)
        if outOfOrder { storedEntries.sort { $0.id < $1.id } }
        invalidateCommittedRows()
    }

    private static func apply(_ change: JSONValue, to message: inout ChatMessage) {
        if change["type"]?.string == "message", let full = change["message"] {
            message = ChatMessage(json: full)
            return
        }
        guard let index = change["contentIndex"]?.int, index >= 0 else { return }
        while message.blocks.count <= index { message.blocks.append(.other) }
        switch change["type"]?.string {
        case "text_start", "thinking_start", "toolcall_start", "block":
            if let block = change["block"] { message.blocks[index] = Block(json: block) }
        case "text_delta":
            if case let .text(text) = message.blocks[index] {
                message.blocks[index] = .text(text + (change["delta"]?.string ?? ""))
            }
        case "thinking_delta":
            if case let .thinking(text) = message.blocks[index] {
                message.blocks[index] = .thinking(text + (change["delta"]?.string ?? ""))
            }
        default:
            // toolcall_delta carries partial JSON arguments; the final "block" change replaces it.
            break
        }
    }
}

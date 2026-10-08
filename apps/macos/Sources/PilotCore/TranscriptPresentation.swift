import Foundation

/// Prepared off the UI actor. Views never rebuild rows or compare the full transcript.
public struct TranscriptPresentation: Equatable, Sendable {
    public var rows: [ChatRow] = []
    public var working = false
    public var streaming = false
    public var queuedMessages: [QueuedMessage] = []
    public var todos: [SessionTodo] = []
    public var queued: Int { queuedMessages.count }
    public var queuedMessagesInDeliveryOrder: [QueuedMessage] {
        queuedMessages.filter { $0.mode == .steer } + queuedMessages.filter { $0.mode == .followUp }
    }
    public var retry: String?
    public var error: String?
    public var revision = 0

    public init() {}

    public init(transcript: Transcript) {
        self.init(transcript: transcript, rows: transcript.rows)
    }

    init(transcript: Transcript, rows: [ChatRow]) {
        self.rows = rows
        working = transcript.working
        streaming = transcript.streaming != nil
        queuedMessages = transcript.queuedMessages
        todos = transcript.todos
        retry = transcript.retry
        error = transcript.error
    }
}

/// One reducer per subscription. Actor isolation keeps event batches ordered and off main.
public actor TranscriptProcessor {
    private var transcript = Transcript()
    private var revision = 0
    private var last: TranscriptPresentation?
    private struct CachedSummary {
        let name: String
        let arguments: JSONValue
        let summary: ToolSummary
    }
    private var summaries: [String: CachedSummary] = [:]
    private var builtRowRevision: UInt64?
    private var builtCommittedRevision: UInt64?
    private var committedRows: [ChatRow] = []
    private var cachedRows: [ChatRow] = []
    private var context: Transcript.RowContext?
    // Operation counts support deterministic scaling regressions, not wall-clock limits.
    private(set) var rowBuildCount = 0
    private(set) var committedRowBuildCount = 0

    public init() {}

    public func apply(_ events: [JSONValue]) throws -> TranscriptPresentation {
        try Task.checkCancellation()
        if events.contains(where: { $0["type"]?.string == "snapshot" }) { summaries = [:] }
        transcript.apply(events)
        try Task.checkCancellation()
        let rowsChanged = builtRowRevision != transcript.rowRevision
        if rowsChanged {
            if builtCommittedRevision != transcript.committedRowRevision {
                let nextContext = transcript.rowContext
                committedRows = try prepare(transcript.renderRows(
                    entries: transcript.entries, streaming: nil, error: nil, context: nextContext))
                context = nextContext
                builtCommittedRevision = transcript.committedRowRevision
                committedRowBuildCount += 1
            }
            let suffix = try prepare(transcript.renderRows(
                entries: [], streaming: transcript.streaming, error: transcript.error, context: context!))
            cachedRows = committedRows
            // A streaming tool call may join the final committed tool group. Keep the
            // committed group's identity, and never mutate a previously returned snapshot.
            if case let .tools(id, previous)? = cachedRows.last,
               case let .tools(_, next)? = suffix.first {
                cachedRows[cachedRows.count - 1] = .tools(id: id, items: previous + next)
                cachedRows.append(contentsOf: suffix.dropFirst())
            } else {
                cachedRows.append(contentsOf: suffix)
            }
            builtRowRevision = transcript.rowRevision
            rowBuildCount += 1
        }
        var result = TranscriptPresentation(transcript: transcript, rows: cachedRows)
        // No row traversal at all for ignored/duplicate or metadata-only batches.
        result.revision = revision
        if let last,
           result.working == last.working, result.streaming == last.streaming,
           result.queuedMessages == last.queuedMessages, result.todos == last.todos,
           result.retry == last.retry, result.error == last.error,
           !rowsChanged || result.rows == last.rows { return last }
        revision += 1
        result.revision = revision
        last = result
        return result
    }

    private func prepare(_ originalRows: [ChatRow]) throws -> [ChatRow] {
        var rows = originalRows
        for index in rows.indices {
            try Task.checkCancellation()
            guard case let .tools(id, original) = rows[index] else { continue }
            var items = original
            for toolIndex in items.indices {
                try Task.checkCancellation()
                let item = items[toolIndex]
                let summary: ToolSummary
                if let cached = summaries[item.id], cached.name == item.name, cached.arguments == item.arguments {
                    summary = cached.summary
                } else {
                    summary = item.summary
                    summaries[item.id] = CachedSummary(name: item.name, arguments: item.arguments, summary: summary)
                }
                items[toolIndex].prepare(summary: summary)
            }
            rows[index] = .tools(id: id, items: items)
        }
        return rows
    }
}

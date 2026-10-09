import Foundation

/// Prepared off the UI actor. Views never rebuild rows or compare the full transcript.
public struct TranscriptPresentation: Equatable, Sendable {
    private var storedHistoryRows: [ChatRow] = []
    private var storedLiveRows: [ChatRow] = []
    /// Compatibility projection for fixtures/actions. UI rendering uses the shared split arrays
    /// below, so publishing a text delta never copies the history-sized array.
    public var rows: [ChatRow] {
        get {
            if storedLiveRows.isEmpty { return storedHistoryRows }
            if storedHistoryRows.isEmpty { return storedLiveRows }
            return storedHistoryRows + storedLiveRows
        }
        set {
            let count = Self.historyPrefixCount(newValue)
            storedHistoryRows = Array(newValue.prefix(count))
            storedLiveRows = Array(newValue.dropFirst(count))
            rowByteCount = Self.byteCount(of: newValue)
            historyRevision = UUID()
        }
    }
    public var historyRows: [ChatRow] { storedHistoryRows }
    public var liveRows: [ChatRow] { storedLiveRows }
    /// A constant-time invalidation key for the stable history subtree. The final tool group
    /// stays in the live tail so merging streaming calls does not destroy its expansion state.
    public private(set) var historyRevision = UUID()
    public var historyRowCount: Int { storedHistoryRows.count }
    public var working = false
    public var streaming = false
    public var queuedMessages: [QueuedMessage] = [] {
        didSet { updateMetadataByteCount() }
    }
    public var todos: [SessionTodo] = [] {
        didSet { updateMetadataByteCount() }
    }
    public var queued: Int { queuedMessages.count }
    public var queuedMessagesInDeliveryOrder: [QueuedMessage] {
        queuedMessages.filter { $0.mode == .steer } + queuedMessages.filter { $0.mode == .followUp }
    }
    public var retry: String? {
        didSet { updateMetadataByteCount() }
    }
    public var error: String? {
        didSet { updateMetadataByteCount() }
    }
    public var revision = 0
    private var rowByteCount = 0
    private var metadataByteCount = 0

    /// Conservative retained-storage estimate, not a measurement of allocator/shared storage.
    /// Reading this never traverses rows, tool arguments, or prepared diffs.
    public var cachedByteCount: Int { rowByteCount + metadataByteCount }

    public init() {}

    public init(transcript: Transcript) {
        let rows = transcript.rows
        let committed = transcript.streaming == nil && transcript.error == nil ? rows : transcript.renderRows(
            entries: transcript.entries, streaming: nil, error: nil, context: transcript.rowContext)
        let count = Self.historyPrefixCount(committed)
        self.init(transcript: transcript, historyRows: Array(rows.prefix(count)), liveRows: Array(rows.dropFirst(count)),
            rowByteCount: Self.byteCount(of: rows), historyRevision: UUID())
    }

    init(transcript: Transcript, historyRows: [ChatRow], liveRows: [ChatRow], rowByteCount: Int, historyRevision: UUID) {
        storedHistoryRows = historyRows
        storedLiveRows = liveRows
        self.rowByteCount = rowByteCount
        self.historyRevision = historyRevision
        working = transcript.working
        streaming = transcript.streaming != nil
        queuedMessages = transcript.queuedMessages
        todos = transcript.todos
        retry = transcript.retry
        error = transcript.error
        updateMetadataByteCount()
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        // Accounting and subtree invalidation keys are rendering caches, not transcript value.
        lhs.hasSameRows(as: rhs) && lhs.working == rhs.working && lhs.streaming == rhs.streaming
            && lhs.queuedMessages == rhs.queuedMessages && lhs.todos == rhs.todos
            && lhs.retry == rhs.retry && lhs.error == rhs.error && lhs.revision == rhs.revision
    }

    func hasSameRows(as other: Self) -> Bool {
        if storedHistoryRows.count == other.storedHistoryRows.count {
            return storedHistoryRows == other.storedHistoryRows && storedLiveRows == other.storedLiveRows
        }
        // Public fixture mutation can choose a different split for an identical projection.
        return [storedHistoryRows, storedLiveRows].joined()
            .elementsEqual([other.storedHistoryRows, other.storedLiveRows].joined())
    }

    static func historyPrefixCount(_ rows: [ChatRow]) -> Int {
        if case .tools? = rows.last { return rows.count - 1 }
        return rows.count
    }

    private mutating func updateMetadataByteCount() {
        var bytes = retry?.utf8.count ?? 0
        bytes += error?.utf8.count ?? 0
        for message in queuedMessages {
            bytes += 128 + message.text.utf8.count
        }
        for todo in todos {
            bytes += 128 + todo.id.utf8.count + todo.title.utf8.count
            bytes += todo.status.utf8.count + todo.createdAt.utf8.count
            bytes += todo.assignedToSession?.utf8.count ?? 0
        }
        metadataByteCount = bytes
    }

    static func byteCount(of rows: [ChatRow]) -> Int {
        rows.reduce(0) { total, row in
            let base = total + 128 + row.id.utf8.count
            switch row {
            case let .user(_, text, _), let .text(_, text, _), let .thinking(_, text, _),
                 let .error(_, text), let .notice(_, text):
                return base + text.utf8.count
            case let .tools(_, items):
                return base + items.reduce(0) { $0 + byteCount(of: $1) }
            case let .artifact(_, reference): return base + artifactByteCount(reference)
            }
        }
    }

    static func byteCount(of item: ToolItem) -> Int {
        let summary = item.summary
        var summaryBytes = 256 + summary.icon.utf8.count + summary.title.utf8.count
        summaryBytes += summary.detail?.utf8.count ?? 0
        summaryBytes += summary.body?.utf8.count ?? 0
        for diff in summary.diffs {
            summaryBytes += MemoryLayout<FileDiff>.stride + diff.path.utf8.count
            for line in diff.lines {
                summaryBytes += MemoryLayout<DiffLine>.stride + 32 + line.text.utf8.count
            }
        }
        return 512 + item.id.utf8.count + item.name.utf8.count + item.output.utf8.count
            + item.arguments.cachedByteCount + summaryBytes + artifactByteCount(item.artifact)
    }

    private static func artifactByteCount(_ reference: ArtifactReference?) -> Int {
        guard let reference else { return 0 }
        return 128 + reference.id.utf8.count + reference.sessionId.utf8.count + reference.title.utf8.count
    }
}

private extension JSONValue {
    var cachedByteCount: Int {
        switch self {
        case let .string(value): return value.utf8.count + 32
        case let .array(values): return values.reduce(32) { $0 + $1.cachedByteCount }
        case let .object(values): return values.reduce(32) { $0 + $1.key.utf8.count + $1.value.cachedByteCount + 32 }
        default: return 16
        }
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
    private var committedRowsByteCount = 0
    private var cachedHistoryRows: [ChatRow] = []
    private var cachedLiveRows: [ChatRow] = []
    private var cachedRowsByteCount = 0
    private var cachedSuffix: [ChatRow] = []
    private var historyRevision = UUID()
    private var historyRowCount = 0
    private struct ToolLocation {
        let row: Int
        let item: Int
    }
    private var toolLocations: [String: [ToolLocation]] = [:]
    private var context: Transcript.RowContext?
    // Operation counts support deterministic scaling regressions, not wall-clock limits.
    private(set) var rowBuildCount = 0
    private(set) var committedRowBuildCount = 0
    /// Number of rows visited for byte accounting, including committed rebuilds and live suffixes.
    private(set) var rowByteCountCalculationCount = 0
    private(set) var committedToolUpdateCount = 0
    private(set) var historyRowComparisonCount = 0
    private(set) var historyRowCopyCount = 0

    public init() {}

    public func apply(_ events: [JSONValue]) throws -> TranscriptPresentation {
        try Task.checkCancellation()
        if events.contains(where: { $0["type"]?.string == "snapshot" }) { summaries = [:] }
        transcript.apply(events)
        try Task.checkCancellation()
        let changedTools = transcript.takeChangedToolIDs()
        let rowsChanged = builtRowRevision != transcript.rowRevision
        var rowsDiffer = false
        var rebuiltHistory = false
        if rowsChanged {
            rebuiltHistory = builtCommittedRevision != transcript.committedRowRevision
            var updatedHistory = false
            if rebuiltHistory {
                let nextContext = transcript.rowContext
                committedRows = try prepare(transcript.renderRows(
                    entries: transcript.entries, streaming: nil, error: nil, context: nextContext))
                committedRowsByteCount = byteCount(of: committedRows)
                historyRowCount = TranscriptPresentation.historyPrefixCount(committedRows)
                cachedHistoryRows = Array(committedRows.prefix(historyRowCount))
                historyRowCopyCount += historyRowCount
                historyRevision = UUID()
                indexTools()
                context = nextContext
                builtCommittedRevision = transcript.committedRowRevision
                committedRowBuildCount += 1
            } else {
                updatedHistory = try updateTools(changedTools)
            }
            let suffix = try prepare(transcript.renderRows(
                entries: [], streaming: transcript.streaming, error: transcript.error, context: context!))
            let suffixChanged = suffix != cachedSuffix
            if rebuiltHistory || updatedHistory || suffixChanged {
                cachedLiveRows = Array(committedRows.dropFirst(historyRowCount))
                cachedRowsByteCount = committedRowsByteCount + byteCount(of: suffix)
                // A streaming tool call may join the final committed tool group. Keep the
                // committed group's identity, and never mutate a previously returned snapshot.
                if case let .tools(id, previous)? = cachedLiveRows.last,
                   case let .tools(_, next)? = suffix.first {
                    cachedLiveRows[cachedLiveRows.count - 1] = .tools(id: id, items: previous + next)
                    // The suffix group's tools survive, but its row storage and identity do not.
                    cachedRowsByteCount -= 128 + suffix[0].id.utf8.count
                    cachedLiveRows.append(contentsOf: suffix.dropFirst())
                } else {
                    cachedLiveRows.append(contentsOf: suffix)
                }
            }
            rowsDiffer = updatedHistory || suffixChanged || last == nil
            cachedSuffix = suffix
            builtRowRevision = transcript.rowRevision
            rowBuildCount += 1
        }
        var result = TranscriptPresentation(transcript: transcript, historyRows: cachedHistoryRows, liveRows: cachedLiveRows,
            rowByteCount: cachedRowsByteCount, historyRevision: historyRevision)
        if rebuiltHistory, let last {
            // Replacement snapshots/entry changes may still have identical visible rows.
            historyRowComparisonCount += cachedHistoryRows.count + cachedLiveRows.count
            rowsDiffer = !result.hasSameRows(as: last)
        }
        // No row traversal at all for ignored/duplicate or metadata-only batches.
        result.revision = revision
        if let last,
           result.working == last.working, result.streaming == last.streaming,
           result.queuedMessages == last.queuedMessages, result.todos == last.todos,
           result.retry == last.retry, result.error == last.error,
           !rowsDiffer { return last }
        revision += 1
        result.revision = revision
        last = result
        return result
    }

    private func indexTools() {
        toolLocations = [:]
        for (rowIndex, row) in committedRows.enumerated() {
            guard case let .tools(_, items) = row else { continue }
            for (itemIndex, item) in items.enumerated() {
                toolLocations[item.id, default: []].append(ToolLocation(row: rowIndex, item: itemIndex))
            }
        }
    }

    private func updateTools(_ ids: Set<String>) throws -> Bool {
        var changed = false
        var copiedHistory = false
        for id in ids {
            for location in toolLocations[id] ?? [] {
                try Task.checkCancellation()
                guard case let .tools(rowID, original) = committedRows[location.row] else { continue }
                let previous = original[location.item]
                var next = transcript.tool(previous.id, name: previous.name, arguments: previous.arguments, context: context!)
                committedToolUpdateCount += 1
                guard next != previous else { continue }
                // Output/status changes cannot change the call's prepared argument summary.
                next.prepare(summary: previous.summary)
                // Only the output string's storage changes; status has fixed-size storage.
                committedRowsByteCount += next.output.utf8.count - previous.output.utf8.count
                var items = original
                items[location.item] = next
                committedRows[location.row] = .tools(id: rowID, items: items)
                if location.row < historyRowCount {
                    // Only a real historical change needs a new immutable history array.
                    if !copiedHistory { historyRowCopyCount += historyRowCount; copiedHistory = true }
                    cachedHistoryRows[location.row] = committedRows[location.row]
                    historyRevision = UUID()
                }
                changed = true
            }
        }
        return changed
    }

    private func byteCount(of rows: [ChatRow]) -> Int {
        rowByteCountCalculationCount += rows.count
        return TranscriptPresentation.byteCount(of: rows)
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

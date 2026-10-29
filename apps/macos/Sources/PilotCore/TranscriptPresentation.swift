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
    public var automaticInputs: [PendingAutomaticInput] = [] {
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
    public var compacting = false
    /// The `before` cursor of the next older page hidden by compaction, or nil when there is none.
    public var earlierCursor: Int?
    /// The agent's unanswered question, shown in place of the composer while idle.
    public var pendingQuestion: AgentQuestion?
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

    /// Reuse the persisted diagnostic after reconnect, without duplicating the transcript's last error row.
    public func failureBannerText(for session: SessionSummary) -> String? {
        guard error == nil, !session.isWorking,
              let reason = session.error ?? (session.outcome == .failed ? session.outcomeReason : nil) else { return nil }
        if case let .error(_, text) = liveRows.last ?? historyRows.last, text == reason { return nil }
        return reason
    }

    public init(transcript: Transcript) {
        let rows = transcript.rows
        let committed = transcript.streaming == nil && transcript.error == nil ? rows : transcript.renderRows(
            entries: transcript.entries, streaming: nil, error: nil, context: transcript.rowContext)
        let count = Self.historyPrefixCount(committed)
        self.init(transcript: transcript, historyRows: Array(rows.prefix(count)), liveRows: Array(rows.dropFirst(count)),
            rowByteCount: Self.byteCount(of: rows), historyRevision: UUID(), pendingQuestion: transcript.pendingQuestion)
    }

    init(transcript: Transcript, historyRows: [ChatRow], liveRows: [ChatRow], rowByteCount: Int, historyRevision: UUID,
         pendingQuestion: AgentQuestion?) {
        storedHistoryRows = historyRows
        storedLiveRows = liveRows
        self.rowByteCount = rowByteCount
        self.historyRevision = historyRevision
        self.pendingQuestion = pendingQuestion
        working = transcript.working
        streaming = transcript.streaming != nil
        queuedMessages = transcript.queuedMessages
        automaticInputs = transcript.automaticInputs
        todos = transcript.todos
        retry = transcript.retry
        compacting = transcript.compacting
        earlierCursor = transcript.earlierCursor
        error = transcript.error
        updateMetadataByteCount()
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        // Accounting and subtree invalidation keys are rendering caches, not transcript value.
        lhs.hasSameRows(as: rhs) && lhs.working == rhs.working && lhs.streaming == rhs.streaming
            && lhs.queuedMessages == rhs.queuedMessages && lhs.automaticInputs == rhs.automaticInputs
            && lhs.todos == rhs.todos
            && lhs.retry == rhs.retry && lhs.compacting == rhs.compacting && lhs.error == rhs.error
            && lhs.earlierCursor == rhs.earlierCursor && lhs.revision == rhs.revision
            && lhs.pendingQuestion == rhs.pendingQuestion
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
        // The turn's latest work row grows while it runs; keep it out of the stable history subtree.
        switch rows.last {
        case .tools?, .work?: return rows.count - 1
        default: return rows.count
        }
    }

    private mutating func updateMetadataByteCount() {
        var bytes = retry?.utf8.count ?? 0
        bytes += error?.utf8.count ?? 0
        for message in queuedMessages {
            bytes += 128 + message.text.utf8.count
        }
        for input in automaticInputs {
            bytes += 128 + input.preview.utf8.count
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
                 let .error(_, text), let .notice(_, text), let .automatic(_, text, _, _):
                return base + text.utf8.count
            case let .event(event):
                return base + eventByteCount(event)
            case let .tools(_, items):
                return base + items.reduce(0) { $0 + byteCount(of: $1) }
            case let .work(_, group):
                return base + workByteCount(group)
            case let .artifact(_, reference): return base + artifactByteCount(reference)
            case let .question(_, question):
                return base + questionByteCount(question)
            }
        }
    }

    /// Keep optional additions outside the row reduce: Swift 6.2's type checker otherwise times out.
    static func workByteCount(_ group: TurnWork) -> Int {
        let rows: [ChatRow] = group.rows
        let bytes: Int = byteCount(of: rows)
        return 32 + bytes
    }

    /// Keep optional additions outside the row reduce: Swift 6.2's type checker otherwise times out.
    static func eventByteCount(_ event: ChatEvent) -> Int {
        var bytes: Int = event.text.utf8.count
        bytes += event.detail?.utf8.count ?? 0
        bytes += event.branch?.utf8.count ?? 0
        bytes += event.title?.utf8.count ?? 0
        return bytes
    }

    /// Separate, typed steps: CI's compiler times out type-checking this inline in the reduce above.
    static func questionByteCount(_ question: AgentQuestion) -> Int {
        var bytes: Int = question.question.utf8.count
        bytes += question.context?.utf8.count ?? 0
        for option in question.options {
            bytes += 64 + option.label.utf8.count
            bytes += option.detail?.utf8.count ?? 0
        }
        return bytes
    }

    static func byteCount(of item: ToolItem) -> Int {
        let summary = item.summary
        var summaryBytes = 256 + MemoryLayout<ToolIcon>.stride + summary.title.utf8.count
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


/// The chat around the transcript (composer, working line, banners, queue) reads only this. It changes with a
/// turn's state, not with each streamed token, so those views are not re-evaluated while text streams.
public struct TranscriptStatus: Equatable, Sendable {
    public var working = false
    public var streaming = false
    public var queuedMessages: [QueuedMessage] = []
    public var automaticInputs: [PendingAutomaticInput] = []
    public var todos: [SessionTodo] = []
    public var retry: String?
    public var compacting = false
    public var error: String?
    public var earlierCursor: Int?
    public var pendingQuestion: AgentQuestion?
    public var hasRows = false
    /// The failed turn the chat offers to retry, see `TranscriptPresentation.retryEntryID`.
    public var retryEntryID: Int?
    /// The last row's text when it is an error, so the failure banner does not repeat it.
    public var lastErrorText: String?

    public init() {}

    public init(_ presentation: TranscriptPresentation) {
        working = presentation.working
        streaming = presentation.streaming
        queuedMessages = presentation.queuedMessages
        automaticInputs = presentation.automaticInputs
        todos = presentation.todos
        retry = presentation.retry
        compacting = presentation.compacting
        error = presentation.error
        earlierCursor = presentation.earlierCursor
        pendingQuestion = presentation.pendingQuestion
        let last = presentation.liveRows.last ?? presentation.historyRows.last
        hasRows = last != nil
        retryEntryID = presentation.retryEntryID
        if case let .error(_, text)? = last { lastErrorText = text }
    }

    public var queuedMessagesInDeliveryOrder: [QueuedMessage] {
        queuedMessages.filter { $0.mode == .steer } + queuedMessages.filter { $0.mode == .followUp }
    }

    /// Same as `TranscriptPresentation.failureBannerText(for:)`.
    public func failureBannerText(for session: SessionSummary) -> String? {
        guard error == nil, !session.isWorking,
              let reason = session.error ?? (session.outcome == .failed ? session.outcomeReason : nil) else { return nil }
        return lastErrorText == reason ? nil : reason
    }

    /// Same as `TranscriptPresentation.questionForComposer(session:hasSnapshot:)`.
    public func questionForComposer(session: SessionSummary, hasSnapshot: Bool) -> AgentQuestion? {
        AgentQuestion.forComposer(pendingQuestion, working: working, session: session, hasSnapshot: hasSnapshot)
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
        /// The tool group inside a work row, or nil for a top-level tool group.
        let child: Int?
        let item: Int
    }
    private var toolLocations: [String: [ToolLocation]] = [:]
    private var context: Transcript.RowContext?
    /// Recomputed only when committed entries change, never per streamed delta.
    private var pendingQuestion: AgentQuestion?
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
                pendingQuestion = transcript.pendingQuestion
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
                } else if case let .work(id, previous)? = cachedLiveRows.last,
                          case let .work(_, next)? = suffix.first {
                    // Streamed steps continue the turn's committed work row, under its identity.
                    cachedLiveRows[cachedLiveRows.count - 1] = .work(id: id, group: previous.appending(next))
                    // The suffix row's own storage goes, and so does its first tool group when it joins ours.
                    cachedRowsByteCount -= 128 + suffix[0].id.utf8.count + 32
                    if case .tools? = previous.rows.last, case let .tools(childID, _)? = next.rows.first {
                        cachedRowsByteCount -= 128 + childID.utf8.count
                    }
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
            rowByteCount: cachedRowsByteCount, historyRevision: historyRevision, pendingQuestion: pendingQuestion)
        if rebuiltHistory, let last {
            // Replacement snapshots/entry changes may still have identical visible rows.
            historyRowComparisonCount += cachedHistoryRows.count + cachedLiveRows.count
            rowsDiffer = !result.hasSameRows(as: last)
        }
        // No row traversal at all for ignored/duplicate or metadata-only batches.
        result.revision = revision
        if let last,
           result.working == last.working, result.streaming == last.streaming,
           result.queuedMessages == last.queuedMessages, result.automaticInputs == last.automaticInputs,
           result.todos == last.todos,
           result.retry == last.retry, result.compacting == last.compacting, result.error == last.error,
           result.earlierCursor == last.earlierCursor, result.pendingQuestion == last.pendingQuestion,
           !rowsDiffer { return last }
        revision += 1
        result.revision = revision
        last = result
        return result
    }

    private func indexTools() {
        toolLocations = [:]
        for (rowIndex, row) in committedRows.enumerated() {
            switch row {
            case let .tools(_, items):
                for (itemIndex, item) in items.enumerated() {
                    toolLocations[item.id, default: []].append(ToolLocation(row: rowIndex, child: nil, item: itemIndex))
                }
            case let .work(_, group):
                for (childIndex, child) in group.rows.enumerated() {
                    guard case let .tools(_, items) = child else { continue }
                    for (itemIndex, item) in items.enumerated() {
                        toolLocations[item.id, default: []].append(
                            ToolLocation(row: rowIndex, child: childIndex, item: itemIndex))
                    }
                }
            default: continue
            }
        }
    }

    /// The tool group a location points into, as a top-level row or a work row's child.
    private func toolGroup(at location: ToolLocation) -> (id: String, items: [ToolItem])? {
        let row = committedRows[location.row]
        let group: ChatRow
        if let child = location.child {
            guard case let .work(_, work) = row, child < work.rows.count else { return nil }
            group = work.rows[child]
        } else {
            group = row
        }
        guard case let .tools(id, items) = group, location.item < items.count else { return nil }
        return (id, items)
    }

    private func replaceToolGroup(at location: ToolLocation, with items: [ToolItem], id: String) {
        let updated = ChatRow.tools(id: id, items: items)
        guard let child = location.child else {
            committedRows[location.row] = updated
            return
        }
        guard case let .work(workID, work) = committedRows[location.row] else { return }
        var group = work
        group.rows[child] = updated
        committedRows[location.row] = .work(id: workID, group: group)
    }

    private func updateTools(_ ids: Set<String>) throws -> Bool {
        var changed = false
        var copiedHistory = false
        for id in ids {
            for location in toolLocations[id] ?? [] {
                try Task.checkCancellation()
                guard let (rowID, original) = toolGroup(at: location) else { continue }
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
                replaceToolGroup(at: location, with: items, id: rowID)
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
            switch rows[index] {
            case let .tools(id, original):
                rows[index] = .tools(id: id, items: try prepare(original))
            case let .work(id, original):
                var group = original
                for child in group.rows.indices {
                    guard case let .tools(toolsID, items) = group.rows[child] else { continue }
                    group.rows[child] = .tools(id: toolsID, items: try prepare(items))
                }
                rows[index] = .work(id: id, group: group)
            default: continue
            }
        }
        return rows
    }

    private func prepare(_ original: [ToolItem]) throws -> [ToolItem] {
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
        return items
    }
}

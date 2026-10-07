import Foundation

/// Prepared off the UI actor. Views never rebuild rows or compare the full transcript.
public struct TranscriptPresentation: Equatable, Sendable {
    public var rows: [ChatRow] = []
    public var working = false
    public var streaming = false
    public var queued = 0
    public var retry: String?
    public var error: String?
    public var revision = 0

    public init() {}

    public init(transcript: Transcript) {
        rows = transcript.rows
        working = transcript.working
        streaming = transcript.streaming != nil
        queued = transcript.queued
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

    public init() {}

    public func apply(_ events: [JSONValue]) throws -> TranscriptPresentation {
        try Task.checkCancellation()
        if events.contains(where: { $0["type"]?.string == "snapshot" }) { summaries = [:] }
        transcript.apply(events)
        try Task.checkCancellation()
        var result = TranscriptPresentation(transcript: transcript)
        for index in result.rows.indices {
            try Task.checkCancellation()
            guard case let .tools(id, original) = result.rows[index] else { continue }
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
            result.rows[index] = .tools(id: id, items: items)
        }
        // Equality stays on this actor. Ignored/duplicate events must not republish or force a scroll.
        result.revision = revision
        if result == last { return result }
        revision += 1
        result.revision = revision
        last = result
        return result
    }
}

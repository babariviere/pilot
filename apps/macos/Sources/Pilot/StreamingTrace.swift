import Foundation
import os

/// Signposts on the streaming path, for Instruments' os_signpost track (subsystem com.babariviere.pilot,
/// category Streaming). The offline performance check also totals their durations, so it reports where time
/// goes without Instruments. Totals are collected only while that check runs; otherwise each interval costs
/// one disabled signpost.
enum StreamingTrace {
    enum Phase: Int, CaseIterable, Sendable {
        /// Reducing a batch of agent events into rows (off the main actor, awaited by the feed).
        case transcriptApply
        /// Publishing a new presentation to SwiftUI (main actor).
        case publish
        /// Parsing and styling one message's Markdown (off the main actor).
        case markdownPrepare
        /// Replacing a text region's content in its NSTextView (main actor).
        case textUpdate
        /// Laying out a text region to answer a SwiftUI size probe (main actor).
        case textMeasure

        var label: String {
            switch self {
            case .transcriptApply: "transcript apply"
            case .publish: "publish"
            case .markdownPrepare: "markdown prepare"
            case .textUpdate: "text update"
            case .textMeasure: "text measure"
            }
        }

        fileprivate var name: StaticString {
            switch self {
            case .transcriptApply: "transcript apply"
            case .publish: "publish"
            case .markdownPrepare: "markdown prepare"
            case .textUpdate: "text update"
            case .textMeasure: "text measure"
            }
        }
    }

    struct Total: Sendable {
        var count = 0
        var nanoseconds: UInt64 = 0
        var longest: UInt64 = 0
    }

    static let signposter = OSSignposter(subsystem: "com.babariviere.pilot", category: "Streaming")
    private static let totals = OSAllocatedUnfairLock(initialState: [Total](repeating: Total(), count: Phase.allCases.count))
    private static let collectingState = OSAllocatedUnfairLock(initialState: false)

    /// Set by the offline performance check only.
    static var collecting: Bool {
        get { collectingState.withLock { $0 } }
        set { collectingState.withLock { $0 = newValue } }
    }

    static func measure<T>(_ phase: Phase, _ body: () throws -> T) rethrows -> T {
        let state = signposter.beginInterval(phase.name)
        let start = collecting ? DispatchTime.now().uptimeNanoseconds : nil
        defer {
            signposter.endInterval(phase.name, state)
            if let start { record(phase, since: start) }
        }
        return try body()
    }

    static func measureAsync<T>(_ phase: Phase, _ body: () async throws -> T) async rethrows -> T {
        let state = signposter.beginInterval(phase.name)
        let start = collecting ? DispatchTime.now().uptimeNanoseconds : nil
        defer {
            signposter.endInterval(phase.name, state)
            if let start { record(phase, since: start) }
        }
        return try await body()
    }

    private static func record(_ phase: Phase, since start: UInt64) {
        let elapsed = DispatchTime.now().uptimeNanoseconds &- start
        totals.withLock { totals in
            totals[phase.rawValue].count += 1
            totals[phase.rawValue].nanoseconds &+= elapsed
            totals[phase.rawValue].longest = max(totals[phase.rawValue].longest, elapsed)
        }
    }

    static func reset() {
        totals.withLock { $0 = [Total](repeating: Total(), count: Phase.allCases.count) }
    }

    static func snapshot() -> [(phase: Phase, total: Total)] {
        let values = totals.withLock { $0 }
        return Phase.allCases.map { ($0, values[$0.rawValue]) }
    }
}


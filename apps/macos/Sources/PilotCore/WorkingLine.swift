import Foundation

/// The text of a chat's working line, including its background jobs. "Working… · 2 jobs" while the agent runs,
/// "Waiting on 2 jobs · Tests 4m" once only its jobs run (the longest-running one is named).
public struct WorkingLine: Equatable, Sendable {
    /// Leading text, such as "Working… · 2 jobs" or "Waiting on 2 jobs ·".
    public let lead: String
    /// The job named after the lead while only jobs run. Truncates before the elapsed time does.
    public let jobName: String?
    /// Compact elapsed time of `jobName`, such as "4m". Nil unless a job is named.
    public let elapsed: String?
    /// The sentence VoiceOver reads.
    public let accessibilityLabel: String
    /// Only jobs run: the agent itself is idle, so the line and corners use the slower background motion.
    public let waitingOnJobs: Bool

    public var text: String { [lead, jobName, elapsed].compactMap { $0 }.joined(separator: " ") }

    /// `now` and job start times are epoch milliseconds.
    public init(retry: String? = nil, compacting: Bool = false, agentWorking: Bool, jobs: [SessionJob], now: Double) {
        let count = jobs.count
        let jobCount = "\(count) \(count == 1 ? "job" : "jobs")"
        let spokenJobs = "\(count) background \(count == 1 ? "job" : "jobs") running"
        let activity = retry.map { "Retrying: \($0)" } ?? (compacting ? "Compacting context…" : nil)
        guard activity == nil, !agentWorking, let oldest = jobs.min(by: { $0.startedAt < $1.startedAt }) else {
            let base = activity ?? "Working…"
            lead = count > 0 ? "\(base) · \(jobCount)" : base
            jobName = nil
            elapsed = nil
            accessibilityLabel = count > 0 ? "\(base), \(spokenJobs)" : base
            waitingOnJobs = false
            return
        }
        let spoken = Self.spokenElapsed(milliseconds: now - oldest.startedAt)
        lead = "Waiting on \(jobCount) ·"
        jobName = oldest.name
        elapsed = Self.compactElapsed(milliseconds: now - oldest.startedAt)
        accessibilityLabel = count == 1
            ? "Waiting on 1 background job: \(oldest.name), running for \(spoken)"
            : "Waiting on \(count) background jobs. Longest: \(oldest.name), running for \(spoken)"
        waitingOnJobs = true
    }

    /// "12s" under a minute, "4m" under an hour, then "1h 5m" or "2h".
    public static func compactElapsed(milliseconds: Double) -> String {
        let seconds = Int(max(0, milliseconds) / 1000)
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        let minutes = (seconds / 60) % 60
        return minutes == 0 ? "\(seconds / 3600)h" : "\(seconds / 3600)h \(minutes)m"
    }

    static func spokenElapsed(milliseconds: Double) -> String {
        let seconds = Int(max(0, milliseconds) / 1000)
        func unit(_ value: Int, _ name: String) -> String { "\(value) \(name)\(value == 1 ? "" : "s")" }
        if seconds < 60 { return unit(seconds, "second") }
        if seconds < 3600 { return unit(seconds / 60, "minute") }
        let minutes = (seconds / 60) % 60
        return minutes == 0 ? unit(seconds / 3600, "hour") : "\(unit(seconds / 3600, "hour")) \(unit(minutes, "minute"))"
    }

    /// When a compact elapsed time next changes: every second for the first minute, then on each whole minute
    /// since `startedAt`. Both are epoch milliseconds.
    public static func nextElapsedChange(after now: Double, startedAt: Double) -> Double {
        let elapsed = max(0, now - startedAt)
        let step: Double = elapsed < 60_000 ? 1000 : 60_000
        return startedAt + ((elapsed / step).rounded(.down) + 1) * step
    }
}

extension SessionSummary {
    /// The agent is idle while its background jobs run. The chat still counts as working, with quieter motion.
    public var isWaitingOnJobs: Bool {
        isWorking && state != "working" && state != "starting" && !(runningJobs ?? []).isEmpty
    }
}

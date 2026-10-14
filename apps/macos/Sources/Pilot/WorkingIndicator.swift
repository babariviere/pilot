import PilotCore
import SwiftUI

/// The chat's working line: a dithered ripple in Theme.working, then what is happening. While background jobs run
/// it counts them ("Working… · 2 jobs"), and once only the jobs run it names the longest one with its elapsed time
/// ("Waiting on 2 jobs · Tests 4m") over a slower, fainter ripple. With `showJobs`, a line with jobs opens the
/// jobs panel. Reusable wherever live work is shown; Reduce Motion keeps the ripple still.
struct WorkingIndicator: View {
    let retry: String?
    var compacting = false
    /// The agent itself runs. False while only its background jobs do.
    var agentWorking = true
    var jobs: [SessionJob] = []
    var showJobs: (() -> Void)? = nil
    @State private var hovered = false

    var label: String { line(now: Date()).text }

    var body: some View {
        if !agentWorking, retry == nil, !compacting, let oldest = jobs.min(by: { $0.startedAt < $1.startedAt }) {
            // Only the elapsed time changes: each second for a minute, then each minute.
            TimelineView(JobElapsedSchedule(startedAt: oldest.startedAt)) { context in
                content(line(now: context.date))
            }
        } else {
            content(line(now: Date()))
        }
    }

    private func line(now: Date) -> WorkingLine {
        WorkingLine(retry: retry, compacting: compacting, agentWorking: agentWorking, jobs: jobs,
                    now: now.timeIntervalSince1970 * 1000)
    }

    @ViewBuilder private func content(_ line: WorkingLine) -> some View {
        let row = HStack(spacing: 8) {
            DitherRipple(background: line.waitingOnJobs)
            HStack(spacing: 4) {
                Text(line.lead).layoutPriority(2)
                if let name = line.jobName { Text(name).truncationMode(.tail) }
                if let elapsed = line.elapsed { Text(elapsed).monospacedDigit().layoutPriority(2) }
            }
            .lineLimit(1)
            .foregroundStyle(hovered ? Theme.foreground : Theme.mutedForeground)
        }
        .font(.callout)
        if let showJobs, !jobs.isEmpty {
            Button(action: showJobs) { row.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .onHover { hovered = $0 }
                .help("Show running jobs")
                .accessibilityLabel(line.accessibilityLabel)
                .accessibilityHint("Shows running jobs")
        } else {
            row
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(line.accessibilityLabel)
        }
    }
}

/// Ticks when a job's compact elapsed time changes, aligned to its start.
struct JobElapsedSchedule: TimelineSchedule {
    /// Epoch milliseconds.
    let startedAt: Double

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> AnyIterator<Date> {
        var next = startDate
        return AnyIterator {
            let current = next
            next = Date(timeIntervalSince1970: WorkingLine.nextElapsedChange(
                after: current.timeIntervalSince1970 * 1000, startedAt: startedAt) / 1000)
            return current
        }
    }
}

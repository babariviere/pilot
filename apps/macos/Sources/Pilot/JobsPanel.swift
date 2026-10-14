import AppKit
import PilotCore
import SwiftUI

/// The chat's running background jobs, live from the session summary (no fetch of its own), with Stop on each.
/// Opened from the working line or /jobs. Stopping a job tells the agent, which then takes a short turn.
struct JobsPanel: View {
    let sessionId: String
    let jobs: [SessionJob]
    let close: () -> Void
    @State private var expanded: Set<String> = []
    @State private var stopping: Set<String> = []
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                PilotSymbol(PilotIcon.terminal, context: .row).foregroundStyle(Theme.mutedForeground)
                Text("Running jobs").fontWeight(.medium)
                Text("\(jobs.count)").monospacedDigit().foregroundStyle(Theme.mutedForeground)
                Spacer()
                Button(action: close) {
                    PilotSymbol(PilotIcon.close, context: .row).frame(width: 20, height: 20)
                }
                .help("Close jobs").accessibilityLabel("Close jobs")
            }
            .font(.pilot(.label))
            .buttonStyle(.plain)
            .padding(.horizontal, 12).padding(.vertical, 6)
            Divider().opacity(0.5)
            if let error {
                Text(error).font(.pilot(.caption)).foregroundStyle(Theme.destructive)
                    .textSelection(.enabled).lineLimit(3)
                    .padding(.horizontal, 12).padding(.top, 8)
            }
            if jobs.isEmpty {
                Text("No running jobs.").font(.pilot(.label))
                    .foregroundStyle(Theme.mutedForeground).padding(12)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(jobs) { job in jobRow(job) }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 4)
                }
                .frame(height: min(180, CGFloat(jobs.count) * 30 + CGFloat(expanded.count) * 66 + 8))
            }
        }
        .card()
        .padding(.horizontal, 28).padding(.vertical, 8)
        .frame(maxWidth: Theme.column + 56)
        .frame(maxWidth: .infinity)
        .onChange(of: jobs.map(\.id)) { _, ids in
            expanded.formIntersection(ids)
            stopping.formIntersection(ids)
        }
    }

    private func jobRow(_ job: SessionJob) -> some View {
        let isExpanded = expanded.contains(job.id)
        let isStopping = stopping.contains(job.id)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    if isExpanded { expanded.remove(job.id) } else { expanded.insert(job.id) }
                } label: {
                    HStack(spacing: 8) {
                        PilotSymbol(isExpanded ? PilotIcon.disclosureOpen : PilotIcon.disclosure, context: .disclosure).foregroundStyle(Theme.faintForeground).frame(width: 10)
                        Text(job.name).font(.pilot(.label)).lineLimit(1)
                        Spacer(minLength: 8)
                        TimelineView(JobElapsedSchedule(startedAt: job.startedAt)) { context in
                            Text(isStopping ? "Stopping…" : "Running · \(Self.elapsed(job, at: context.date))")
                                .font(.pilot(.caption)).monospacedDigit()
                                .foregroundStyle(Theme.mutedForeground).fixedSize()
                        }
                    }
                    .frame(height: 30).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(job.name)
                .accessibilityLabel("\(job.name), running for \(Self.elapsed(job, at: Date()))")
                .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
                Button("Stop") { stop(job) }
                    .buttonStyle(.link)
                    .font(.pilot(.caption))
                    .disabled(isStopping)
                    .help("Stop \(job.name). The agent is told you stopped it.")
                    .accessibilityLabel("Stop \(job.name)")
            }
            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    Text(job.id).foregroundStyle(Theme.faintForeground)
                    Text(job.outputPath.abbreviatingHome)
                        .foregroundStyle(Theme.mutedForeground).lineLimit(2).help(job.outputPath)
                }
                .font(.pilot(.caption, design: .monospaced)).textSelection(.enabled)
                .padding(.leading, 18).padding(.bottom, 10)
                .contextMenu {
                    Button("Copy Log Path") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(job.outputPath, forType: .string)
                    }
                    Button("Show Log in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: job.outputPath)])
                    }
                }
            }
        }
    }

    private static func elapsed(_ job: SessionJob, at date: Date) -> String {
        WorkingLine.compactElapsed(milliseconds: date.timeIntervalSince1970 * 1000 - job.startedAt)
    }

    /// The row stays, marked Stopping…, until the session summary drops the job.
    private func stop(_ job: SessionJob) {
        stopping.insert(job.id)
        error = nil
        Task {
            do {
                try await AppModel.shared.client.stopJob(sessionId, jobId: job.id)
            } catch {
                stopping.remove(job.id)
                self.error = "Could not stop \(job.name): \(error.localizedDescription)"
            }
        }
    }
}

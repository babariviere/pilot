import AppKit
import PilotCore
import SwiftUI

/// A read-only snapshot, fetched on opening and explicit refresh only.
struct JobsPanel: View {
    let sessionId: String
    let close: () -> Void
    @State private var jobs: [SessionJob] = []
    @State private var loading = true
    @State private var error: String?
    @State private var refresh = 0
    @State private var fetchedAt = 0.0
    @State private var expanded: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "terminal").foregroundStyle(Theme.mutedForeground)
                Text("Running jobs").fontWeight(.medium)
                if !loading, error == nil {
                    Text("\(jobs.count)").monospacedDigit().foregroundStyle(Theme.mutedForeground)
                }
                Spacer()
                Button { refresh += 1 } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 20, height: 20)
                }
                    .disabled(loading)
                    .help("Refresh jobs").accessibilityLabel("Refresh jobs")
                Button(action: close) {
                    Image(systemName: "xmark").frame(width: 20, height: 20)
                }
                .help("Close jobs").accessibilityLabel("Close jobs")
            }
            .font(.pilot(.label))
            .buttonStyle(.plain)
            .padding(.horizontal, 12).padding(.vertical, 6)
            Divider().opacity(0.5)
            if loading {
                ProgressView("Loading jobs…").controlSize(.small)
                    .font(.pilot(.caption)).padding(12)
            } else if let error {
                Text(error).font(.pilot(.caption)).foregroundStyle(Theme.destructive)
                    .textSelection(.enabled).lineLimit(3).padding(12)
            } else if jobs.isEmpty {
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
        .task(id: refresh) {
            loading = true
            error = nil
            do {
                let result = try await AppModel.shared.client.jobs(sessionId)
                guard !Task.isCancelled else { return }
                jobs = result
                expanded.formIntersection(result.map(\.id))
                fetchedAt = Date().timeIntervalSince1970 * 1000
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
            loading = false
        }
    }

    private func jobRow(_ job: SessionJob) -> some View {
        let isExpanded = expanded.contains(job.id)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                if isExpanded { expanded.remove(job.id) } else { expanded.insert(job.id) }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.pilot(.micro)).foregroundStyle(Theme.faintForeground).frame(width: 10)
                    Text(job.name).font(.pilot(.label)).lineLimit(1)
                    Spacer(minLength: 8)
                    Text("Running · \(job.elapsed(at: fetchedAt))")
                        .font(.pilot(.caption)).monospacedDigit()
                        .foregroundStyle(Theme.mutedForeground).fixedSize()
                }
                .frame(height: 30).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(job.name)
            .accessibilityLabel("\(job.name), running for \(job.elapsed(at: fetchedAt))")
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
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
}

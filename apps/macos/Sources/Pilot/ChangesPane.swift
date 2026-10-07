import Combine
import PilotCore
import SwiftUI

@MainActor
final class ChangesModel: ObservableObject {
    @Published private(set) var changes: SessionChanges?
    @Published private(set) var diffs: [String: FileDiff] = [:]
    @Published private(set) var error: String?
    @Published private(set) var loading = false
    @Published var expanded: Set<String> = []
    let sessionId: String

    init(sessionId: String) { self.sessionId = sessionId }

    func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let changes = try await AppModel.shared.client.changes(sessionId)
            if changes != self.changes {
                let diffs = await Task.detached(priority: .userInitiated) {
                    Dictionary(Diff.parseUnified(changes.diff).map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
                }.value
                let firstLoad = self.changes == nil
                self.changes = changes
                self.diffs = diffs
                // Small change sets open fully: that is the review.
                if firstLoad, changes.files.reduce(0, { $0 + $1.additions + $1.deletions }) <= 400 {
                    expanded = Set(changes.files.map(\.path))
                }
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// What the session changed in its working copy: committed and uncommitted, since it branched.
struct ChangesPane: View {
    let session: SessionSummary
    @StateObject private var model: ChangesModel
    /// Refresh while the pane is visible: cheap git commands, and the agent may be editing.
    private let timer = Timer.publish(every: 4, on: .main, in: .common).autoconnect()

    init(session: SessionSummary) {
        self.session = session
        _model = StateObject(wrappedValue: ChangesModel(sessionId: session.id))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Theme.border).frame(height: 1)
            content
        }
        .background(Theme.background)
        .onAppear { if session.state != "starting" { Task { await model.load() } } }
        .onChange(of: session.state) { _, state in
            if state != "starting" { Task { await model.load() } }
        }
        .onReceive(timer) { _ in if session.state != "starting" { Task { await model.load() } } }
    }

    private var header: some View {
        HStack(spacing: 8) {
            if let changes = model.changes {
                Text(changes.files.isEmpty ? "No changes" : "\(changes.files.count) file\(changes.files.count == 1 ? "" : "s")")
                    .font(.system(size: 12, weight: .medium))
                DiffStat(
                    additions: changes.files.reduce(0) { $0 + $1.additions },
                    deletions: changes.files.reduce(0) { $0 + $1.deletions }
                )
                Text("since \(changes.base)").font(.caption).foregroundStyle(Theme.faintForeground).lineLimit(1)
            } else {
                Text("Changes").font(.system(size: 12, weight: .medium))
            }
            Spacer()
            if model.loading { ProgressView().controlSize(.mini) }
            Button { Task { await model.load() } } label: { Image(systemName: "arrow.clockwise").font(.caption) }
                .buttonStyle(.borderless)
                .help("Refresh")
        }
        .foregroundStyle(Theme.foreground)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder private var content: some View {
        if session.state == "starting", model.changes == nil {
            ProgressView("Preparing task…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = model.error, model.changes == nil {
            placeholder(icon: "exclamationmark.triangle", text: error)
        } else if let changes = model.changes, changes.files.isEmpty {
            placeholder(icon: "checkmark.circle", text: "The working copy matches \(changes.base).")
        } else if let changes = model.changes {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(changes.files) { file in
                        FileRow(file: file, expanded: model.expanded.contains(file.path)) {
                            if model.expanded.contains(file.path) { model.expanded.remove(file.path) } else { model.expanded.insert(file.path) }
                        }
                        if model.expanded.contains(file.path), let diff = model.diffs[file.path] {
                            DiffView(file: diff)
                                .padding(.vertical, 4)
                                .background(Theme.code)
                        }
                        Rectangle().fill(Theme.border).frame(height: 1)
                    }
                    if changes.truncated {
                        Text("Diff truncated at 1 MiB.").font(.caption).foregroundStyle(Theme.mutedForeground).padding(12)
                    }
                }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func placeholder(icon: String, text: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(.title2).foregroundStyle(Theme.faintForeground)
            Text(text).font(.callout).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct FileRow: View {
    let file: ChangedFile
    let expanded: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.faintForeground)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                Text(letter)
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(color)
                    .frame(width: 14)
                HStack(spacing: 0) {
                    Text(directory).foregroundStyle(Theme.mutedForeground)
                    Text(name).foregroundStyle(Theme.foreground)
                }
                .font(.system(size: 12))
                .lineLimit(1)
                .truncationMode(.head)
                Spacer(minLength: 6)
                DiffStat(additions: file.additions, deletions: file.deletions)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(file.previousPath.map { "\($0) → \(file.path)" } ?? file.path)
    }

    private var name: String { URL(filePath: file.path).lastPathComponent }
    private var directory: String {
        let dir = (file.path as NSString).deletingLastPathComponent
        return dir.isEmpty ? "" : dir + "/"
    }

    private var letter: String {
        switch file.status {
        case "added": "A"
        case "deleted": "D"
        case "renamed": "R"
        case "untracked": "U"
        default: "M"
        }
    }

    private var color: Color {
        switch file.status {
        case "added", "untracked": Theme.success
        case "deleted": Theme.destructive
        case "renamed": Theme.info
        default: Theme.warning
        }
    }
}

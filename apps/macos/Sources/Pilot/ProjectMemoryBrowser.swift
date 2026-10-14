import PilotCore
import SwiftUI

struct MemoryCompactionLine: View {
    let compaction: MemoryCompaction

    var body: some View {
        HStack(spacing: 7) {
            if compaction.state == .running || compaction.state == .pending {
                PilotSymbol(PilotIcon.working, context: .row).frame(width: 16)
            } else {
                PilotSymbol(compaction.state == .backoff ? PilotIcon.warning : PilotIcon.complete)
                    .foregroundStyle(compaction.state == .backoff ? Theme.warning : Theme.faintForeground)
                    .frame(width: 16)
            }
            Text(message).font(.pilot(.caption))
                .foregroundStyle(compaction.state == .backoff ? Theme.warning : Theme.mutedForeground)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private var message: String {
        if compaction.state == .backoff { return "Compaction paused: \(compaction.error ?? "will retry automatically")" }
        if compaction.state == .running { return "Updating memory summaries…" }
        if compaction.state == .pending { return "\(compaction.pending) summaries waiting to build" }
        return "Memory summaries are up to date"
    }
}

/// A bounded tree browser. Nodes are expanded on demand and recall is a single explicit request,
/// so large project logs never load or scan on the UI thread.
struct ProjectMemoryBrowser: View {
    let project: Project
    @StateObject private var state: ProjectMemoryBrowserModel
    @Environment(\.dismiss) private var dismiss

    init(project: Project, client: PilotClient) {
        self.project = project
        _state = StateObject(wrappedValue: ProjectMemoryBrowserModel(projectId: project.id, client: client))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Browse memory").font(.pilot(.title))
                    Text(project.name).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            HStack(spacing: 8) {
                TextField("Search memories (regular expression)", text: $state.query)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await state.search() } }
                    .accessibilityLabel("Search project memories")
                Button("Search") { Task { await state.search() } }
                    .disabled(state.busy || state.query.isEmpty)
                    .keyboardShortcut(.return, modifiers: [.command])
            }
            if let error = state.error {
                Label(error, icon: PilotIcon.warning)
                    .font(.pilot(.caption)).foregroundStyle(Theme.warning).textSelection(.enabled)
            }
            if let resultCount = state.resultCount {
                if state.results.isEmpty {
                    Text("No matching memories.").font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                } else {
                    Text("\(resultCount) matches").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(state.results.enumerated()), id: \.element.id) { index, entry in
                                if index > 0 { HairlineDivider(leading: 28) }
                                memoryEntry(entry)
                            }
                        }
                    }
                }
            } else if state.loading {
                ProgressView("Loading memory…").frame(maxWidth: .infinity, alignment: .leading)
            } else if state.roots.isEmpty {
                EmptyStateView(icon: PilotIcon.memory, title: "No memories yet",
                               message: "Lasting project notes from agents will appear here.")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(state.roots, id: \.key) { node in treeNode(node, depth: 0) }
                    }
                }
            }
        }
        .padding(24)
        .frame(minWidth: 520, minHeight: 440)
        .background(Theme.background)
        .task { await state.load() }
        .confirmationDialog("Forget this summary?", isPresented: Binding(
            get: { state.forgetting != nil }, set: { if !$0 { state.cancelForget() } }
        ), titleVisibility: .visible) {
            Button("Forget summary", role: .destructive) { Task { await state.confirmForget() } }
            Button("Cancel", role: .cancel) { state.cancelForget() }
        } message: {
            Text("The original memory notes stay unchanged. This summary and summaries built from it will be rebuilt.")
        }
    }

    private func treeNode(_ node: MemoryNode, depth: Int) -> AnyView {
        let canExpand = node.hi - node.lo + 1 >= 2
        return AnyView(VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Button { Task { await state.expand(node) } } label: {
                    PilotSymbol(canExpand ? (state.expanded.contains(node.key) ? PilotIcon.disclosureOpen : PilotIcon.disclosure) :
                          PilotIcon.memoryEntry, filled: !canExpand && !node.isReplaced, context: .disclosure).foregroundStyle(Theme.faintForeground).frame(width: 14)
                }
                .buttonStyle(.plain).disabled(!canExpand || state.busy)
                .accessibilityLabel(state.expanded.contains(node.key) ? "Collapse entries \(node.lo) through \(node.hi)" :
                                    "Expand entries \(node.lo) through \(node.hi)")
                VStack(alignment: .leading, spacing: 3) {
                    Text(node.title)
                        .font(.pilot(.body)).foregroundStyle(node.isReplaced ? Theme.mutedForeground : Theme.foreground)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    if let entry = node.entry {
                        MemoryEntryMeta(entry: entry)
                    } else {
                        Text("Entries \(node.lo)–\(node.hi)").font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                    }
                }
                Spacer(minLength: 4)
                if node.canForget {
                    Button { state.requestForget(node) } label: { PilotSymbol(PilotIcon.delete, context: .toolbar) }
                        .buttonStyle(.plain).help("Forget this summary")
                        .accessibilityLabel("Forget summary for entries \(node.lo) through \(node.hi)")
                }
            }
            .padding(.leading, CGFloat(depth) * 18 + 4).padding(.vertical, 7)
            if state.expanded.contains(node.key) {
                ForEach(state.children[node.key] ?? [], id: \.key) { child in treeNode(child, depth: depth + 1) }
            }
            HairlineDivider(leading: CGFloat(depth) * 18 + 26)
        })
    }

    private func memoryEntry(_ entry: MemoryEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.text).font(.pilot(.body))
                .foregroundStyle(entry.replacedBy == nil ? Theme.foreground : Theme.mutedForeground)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            MemoryEntryMeta(entry: entry)
        }.padding(.horizontal, 8).padding(.vertical, 8)
    }
}

/// "#7 · date", followed by a quiet "Replaced by #n" when a later note corrects this one.
private struct MemoryEntryMeta: View {
    let entry: MemoryEntry

    var body: some View {
        HStack(spacing: 0) {
            Text("#\(entry.index) · \(Date(timeIntervalSince1970: entry.at / 1000).formatted(date: .abbreviated, time: .shortened))")
                .foregroundStyle(Theme.faintForeground)
            if let label = entry.replacedLabel {
                Text(" · \(label)").foregroundStyle(Theme.mutedForeground)
            }
        }
        .font(.pilot(.caption)).lineLimit(1)
        .accessibilityElement(children: .combine)
    }
}

extension MemoryNode {
    var key: String { "\(lo)-\(hi)" }

    /// A replaced note, or a summary whose notes were all replaced by later corrections.
    var isReplaced: Bool { replaced == true || entry?.replacedBy != nil }

    /// Only built summaries can be forgotten. Single-note leaves also carry text, but forgetting their
    /// one-entry range would drop the covering summaries rather than the note.
    var canForget: Bool { entry == nil && text != nil }

    /// Primary line: the note or summary text, otherwise a plain description of the range.
    var title: String {
        if let text = entry?.text ?? text { return text }
        if replaced == true { return "All notes here were replaced by later corrections" }
        if pending == true { return "Summary is being built…" }
        return "Memory range"
    }
}

extension MemoryEntry {
    var replacedLabel: String? { replacedBy.map { "Replaced by #\($0)" } }
}

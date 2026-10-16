import PilotCore
import SwiftUI

/// Content only, embedded by MemoryPage. No execution-project memory route is used.
struct SharedMemoryContent: View {
    let host: HostRef
    let binding: SharedContextBinding
    @ObservedObject var hosts: HostClients
    var onOpenChat: (HostResourceRef) -> Void = { _ in }
    var contributions: [SharedMemoryProposal]? = nil

    var body: some View {
        if let contributions { SharedMemoryContributionRows(proposals: contributions) }
        else { SharedMemoryBody(context: SharedProjectContext(binding: binding, readingHost: host, hosts: hosts),
                         revision: hosts.sharedRevision, available: hosts.available.contains(host), onOpenChat: onOpenChat)
            .id(SharedProjectScope(binding: binding, host: host)) }
    }
}

private struct SharedMemoryBody: View {
    let context: SharedProjectContext
    let revision: Int
    let available: Bool
    var onOpenChat: (HostResourceRef) -> Void
    @StateObject private var model: SharedProjectModel
    @State private var query = ""
    @State private var showingTree = false
    @State private var visibleCount = 12

    init(context: SharedProjectContext, revision: Int, available: Bool, onOpenChat: @escaping (HostResourceRef) -> Void) {
        self.context = context; self.onOpenChat = onOpenChat
        self.revision = revision; self.available = available
        _model = StateObject(wrappedValue: SharedProjectModel(context: context))
    }

    private var proposals: [SharedMemoryProposal] {
        showingTree ? model.memoryTree?.proposals ?? [] : model.memory?.proposals ?? []
    }
    private var nodes: [MemoryNode] {
        if showingTree { return model.memoryTree?.value.nodes.map(\.node) ?? [] }
        guard let value = model.memory?.value else { return [] }
        switch value {
        case let .view(view): return view.nodes
        case let .nodes(nodes): return nodes
        case let .recall(recall): return recall.entries.map { MemoryNode(lo: $0.index, hi: $0.index, text: $0.text, entry: $0) }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Notes are saved on \(context.name(context.binding.memoryHome.host))")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                Spacer()
                Button("Refresh") { Task { await refresh() } }.disabled(model.busy)
            }
            HStack {
                TextField("Search shared memory", text: $query).textFieldStyle(.roundedBorder)
                    .onSubmit { search() }
                Button("Search", action: search).disabled(model.busy || query.utf16.count > 512)
                Button(showingTree ? "Recent notes" : "Browse") {
                    showingTree.toggle(); visibleCount = 12
                    Task { await refresh() }
                }.disabled(model.busy)
            }
            if let error = model.error { InlineProblem(error) { Task { await refresh() } } }
            if model.busy, model.memory == nil, model.memoryTree == nil { ProgressView().controlSize(.small) }
            PageSectionHeader(title: SharedSaveState.saved.rawValue, count: nodes.count)
            if nodes.isEmpty, !model.busy {
                Text("No saved notes in this view.").font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
            }
            ForEach(Array(nodes.prefix(visibleCount).enumerated()), id: \.offset) { _, node in
                VStack(alignment: .leading, spacing: 4) {
                    Text(node.entry?.text ?? node.text ?? "Saved notes")
                        .font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(8).textSelection(.enabled)
                    HStack {
                        Text(node.lo == node.hi ? "Note \(node.lo)" : "Notes \(node.lo)–\(node.hi)")
                            .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                        if let origin = node.entry?.sharedOrigin, let host = try? context.host(for: origin.host) {
                            Button("Open chat on \(context.name(origin.host))") {
                                onOpenChat(HostResourceRef(host: host, kind: .session, localId: origin.sessionId))
                            }.font(.pilot(.caption))
                        }
                        if showingTree, node.hi > node.lo {
                            Button("Open notes") { Task { await model.loadTree(range: MemoryRange(lo: node.lo, hi: node.hi)) } }
                                .font(.pilot(.caption)).disabled(model.busy)
                        }
                    }
                }
                HairlineDivider()
            }
            if nodes.count > visibleCount {
                Button("Show more notes") { visibleCount = min(nodes.count, visibleCount + 12) }
            }
            if !proposals.isEmpty {
                PageSectionHeader(title: "Contributions", count: proposals.count)
                ForEach(proposals.prefix(visibleCount), id: \.mutation.operationId) { proposal in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(proposal.state == .pending ? SharedSaveState.pending.rawValue : SharedSaveState.conflict.rawValue)
                            .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        Text(proposal.mutation.text).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                            .lineLimit(6).textSelection(.enabled)
                        if proposal.state != .pending {
                            Text("Kept separately from saved notes. Review on \(context.name(context.binding.memoryHome.host)).")
                                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        }
                    }
                    HairlineDivider()
                }
                if proposals.count > visibleCount { Button("Show more contributions") { visibleCount += 12 } }
            }
            if showingTree, model.memoryTree?.value.truncated == true {
                Text("Open a group to read the remaining notes.").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }
        .font(.pilot(.body)).foregroundStyle(Theme.foreground)
        .task(id: [String(revision), String(available)]) {
            if model.memory != nil || model.memoryTree != nil { try? await Task.sleep(for: .milliseconds(200)) }
            guard !Task.isCancelled else { return }
            await refresh()
        }
        .onDisappear { model.stop() }
    }

    private func search() {
        guard query.utf16.count <= 512 else { return }
        showingTree = false; visibleCount = 12
        Task { await model.loadMemory(regex: query.isEmpty ? nil : query) }
    }
    private func refresh() async {
        if showingTree { await model.loadTree() }
        else { await model.loadMemory(regex: query.isEmpty ? nil : query) }
    }
}

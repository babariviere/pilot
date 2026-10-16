import Combine
import PilotCore
import SwiftUI

/// Endpoint-local inboxes, two reads at a time. Event invalidations coalesce; no polling.
@MainActor final class UnifiedInboxSource: ObservableObject {
    @Published private(set) var values: [HostRef: Inbox] = [:]
    @Published private(set) var errors: Set<HostRef> = []
    private struct Entry {
        let client: PilotClient
        let generation: UUID
        let tracked: UUID
        var observations: [AnyCancellable]
    }
    private var entries: [HostRef: Entry] = [:]
    private var queued: Set<HostRef> = []
    private var running: [HostRef: Task<Void, Never>] = [:]
    private var hostObservation: AnyCancellable?
    private var hosts: HostClients?
    private var actions: [HostRef: TrackedItemActions] = [:]

    func actions(on host: HostRef) -> TrackedItemActions {
        if let value = actions[host] { return value }
        let value = TrackedItemActions(); actions[host] = value; return value
    }

    func start(_ hosts: HostClients) {
        self.hosts = hosts
        hostObservation = hosts.objectWillChange.debounce(for: .milliseconds(30), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in self?.configure() }
        configure()
    }

    private func configure() {
        guard let hosts else { return }
        for host in Array(entries.keys) where !hosts.available.contains(host) { detach(host); errors.insert(host) }
        for host in hosts.available {
            guard let client = try? hosts.endpoint(host) else { continue }
            if entries[host]?.client === client, entries[host]?.generation == client.connectionGeneration { continue }
            detach(host)
            let tracked = client.observeTrackedItems { [weak self] _ in self?.enqueue(host) }
            let counts = client.$projectCounts.dropFirst().removeDuplicates().debounce(for: .milliseconds(200), scheduler: DispatchQueue.main)
                .sink { [weak self] _ in self?.enqueue(host) }
            let ready = client.$sessions.map(InboxText.readyToMergeKey).removeDuplicates().dropFirst()
                .debounce(for: .milliseconds(200), scheduler: DispatchQueue.main).sink { [weak self] _ in self?.enqueue(host) }
            entries[host] = Entry(client: client, generation: client.connectionGeneration, tracked: tracked, observations: [counts, ready])
            enqueue(host)
        }
    }

    private func detach(_ host: HostRef) {
        if let entry = entries.removeValue(forKey: host) { entry.client.stopObservingTrackedItems(entry.tracked) }
        running.removeValue(forKey: host)?.cancel(); queued.remove(host)
    }

    private func enqueue(_ host: HostRef) { queued.insert(host); pump() }
    private func pump() {
        guard let hosts else { return }
        while running.count < 2, let host = queued.first(where: { running[$0] == nil }) {
            queued.remove(host)
            guard let entry = entries[host] else { continue }
            running[host] = Task { [weak self] in
                defer { self?.running[host] = nil; self?.pump() }
                do {
                    let fence = try hosts.token(for: host)
                    let value = try await entry.client.inbox(projectId: nil)
                    try hosts.validate(fence); try Task.checkCancellation()
                    guard let self, self.entries[host]?.generation == entry.generation else { return }
                    if self.values[host] != value { self.values[host] = value }
                    self.errors.remove(host)
                } catch { if !Task.isCancelled { self?.errors.insert(host) } }
            }
        }
    }

    func stop() {
        hostObservation = nil
        for host in Array(entries.keys) { detach(host) }
        hosts = nil
    }
}

/// Existing Inbox rows and order, now carrying their owning endpoint through every action.
struct UnifiedInboxContent: View {
    @ObservedObject var hosts: HostClients
    @StateObject private var source = UnifiedInboxSource()
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                let needs = needsYou
                if !needs.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        PageSectionHeader(title: "Needs you", count: source.values.values.reduce(0) { $0 + $1.needsYou.total }, countStyle: .attention)
                        ForEach(needs) { row in
                            ProjectNeedsYouRow(item: row.value.item, now: Date(), context: place(row.ref.host, row.value.projectId))
                                .environment(\.hostViewContext, HostViewContext(host: row.ref.host, hosts: hosts))
                            HairlineDivider(leading: InboxRowLayout.dividerInset)
                        }
                    }
                }
                let ready = readyToMerge
                if !ready.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        PageSectionHeader(title: "Ready to merge", count: source.values.values.reduce(0) { $0 + $1.readyToMerge.total })
                        ForEach(ready) { row in
                            InboxReadyToMergeRow(pr: row.value.pullRequest, context: place(row.ref.host, row.value.projectId))
                                .environment(\.hostViewContext, HostViewContext(host: row.ref.host, hosts: hosts))
                            HairlineDivider(leading: InboxRowLayout.dividerInset)
                        }
                    }
                }
                tracked(.linear, title: "Linear")
                tracked(.slack, title: "Slack")
                ForEach(knownUnavailable, id: \.self) { host in
                    Text("Reconnect to \(HostViewContext(host: host, hosts: hosts).name) to check what needs you. Last-known chats remain in the sidebar.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                if needs.isEmpty, ready.isEmpty, trackedRows(.linear).isEmpty, trackedRows(.slack).isEmpty,
                   knownUnavailable.isEmpty, !source.values.isEmpty {
                    Text("Nothing is waiting on you.").font(.pilot(.headline)).foregroundStyle(Theme.mutedForeground)
                } else if source.values.isEmpty, knownUnavailable.isEmpty { ProgressView("Loading Inbox…") }
            }.padding(32).frame(maxWidth: Theme.column).frame(maxWidth: .infinity)
        }
        .onAppear { source.start(hosts) }
        .onDisappear { source.stop() }
    }

    private var knownUnavailable: [HostRef] {
        Set(hosts.offlineHosts.keys).subtracting(hosts.available).union(source.errors).sorted { $0.hostId < $1.hostId }
    }
    private var needsYou: [Hosted<InboxNeedsYouItem>] {
        source.values.flatMap { host, value in value.needsYou.items.map {
            Hosted(ref: HostResourceRef(host: host, kind: .project, localId: $0.id), value: $0)
        } }.sorted { $0.value.item.id < $1.value.item.id }
    }
    private var readyToMerge: [Hosted<InboxReadyToMergeItem>] {
        source.values.flatMap { host, value in value.readyToMerge.items.map {
            Hosted(ref: HostResourceRef(host: host, kind: .project, localId: $0.id), value: $0)
        } }
    }
    private func trackedRows(_ kind: TrackedKind) -> [Hosted<TrackedItem>] {
        source.values.flatMap { host, value in
            (kind == .linear ? value.linear?.items ?? [] : value.slack?.items ?? []).map {
                Hosted(ref: HostResourceRef(host: host, kind: .project, localId: $0.id), value: $0)
            }
        }
    }
    @ViewBuilder private func tracked(_ kind: TrackedKind, title: String) -> some View {
        let rows = trackedRows(kind)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                PageSectionHeader(title: title, count: rows.count)
                ForEach(rows) { row in
                    TrackedItemRow(item: row.value, actions: source.actions(on: row.ref.host), now: Date(), context: place(row.ref.host, row.value.projectId))
                        .environment(\.hostViewContext, HostViewContext(host: row.ref.host, hosts: hosts))
                    HairlineDivider()
                }
            }
        }
    }
    private func place(_ host: HostRef, _ projectId: String) -> String {
        [hosts.projects.first { $0.ref.host == host && $0.value.id == projectId }?.value.name,
         HostViewContext(host: host, hosts: hosts).name].compactMap { $0 }.joined(separator: " · ")
    }
}

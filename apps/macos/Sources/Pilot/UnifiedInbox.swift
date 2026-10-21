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
    private var hosts: ClientDirectory?
    private var actions: [HostRef: TrackedItemActions] = [:]

    func actions(on host: HostRef) -> TrackedItemActions {
        if let value = actions[host] { return value }
        let value = TrackedItemActions(); actions[host] = value; return value
    }

    func start(_ hosts: ClientDirectory) {
        self.hosts = hosts
        hostObservation = hosts.objectWillChange.debounce(for: .milliseconds(30), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in self?.configure() }
        configure()
    }

    private func configure() {
        guard let hosts else { return }
        for host in Array(entries.keys) where !hosts.available.contains(host) { detach(host); errors.insert(host) }
        // A removed host has nothing left to say; an unreachable one keeps its last-known rows.
        let kept = UnifiedInboxPresentation.retained(values: values, errors: errors,
                                                     known: Set(hosts.available).union(hosts.offlineHosts.keys))
        if kept.values.count != values.count { values = kept.values }
        if kept.errors != errors { errors = kept.errors }
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

/// The Inbox across hosts: pilotd's own order and counts (`UnifiedInboxPresentation`), each row carrying its owning
/// endpoint through every action.
struct UnifiedInboxContent: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var hosts: ClientDirectory
    @StateObject private var source = UnifiedInboxSource()
    var body: some View {
        let page = UnifiedInboxPresentation(source.values)
        let unavailable = knownUnavailable
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if !page.needsYou.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        PageSectionHeader(title: "Needs you", count: page.needsYou.total, countStyle: .attention)
                        ForEach(page.needsYou.rows) { row in
                            ProjectNeedsYouRow(item: row.value.item, now: Date(), context: place(row.ref.host, row.value.projectId))
                                .inboxCorner(row.value.item.signal)
                                .environment(\.hostViewContext, HostViewContext(host: row.ref.host, hosts: hosts))
                            HairlineDivider(leading: InboxRowLayout.dividerInset)
                        }
                        capNote(shown: page.needsYou.rows.count, total: page.needsYou.total)
                    }
                }
                if !page.readyToMerge.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        PageSectionHeader(title: "Ready to merge", count: page.readyToMerge.total)
                        ForEach(page.readyToMerge.rows) { row in
                            InboxReadyToMergeRow(pr: row.value.pullRequest, context: place(row.ref.host, row.value.projectId))
                                .inboxCorner(.readyToMerge)
                                .environment(\.hostViewContext, HostViewContext(host: row.ref.host, hosts: hosts))
                            HairlineDivider(leading: InboxRowLayout.dividerInset)
                        }
                        capNote(shown: page.readyToMerge.rows.count, total: page.readyToMerge.total)
                    }
                }
                tracked(page.linear, title: "Linear")
                tracked(page.slack, title: "Slack", triage: SlackTriageInboxHeader.choices(hosts: hosts, model: model))
                ForEach(unavailable, id: \.self) { host in
                    Text(UnifiedInboxPresentation.unavailableNote(
                        host: HostViewContext(host: host, hosts: hosts).name, hasLastKnownRows: source.values[host] != nil))
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                if let hidden = InboxText.hiddenFooter(page.hidden) {
                    Text(hidden).font(.pilot(.caption)).foregroundStyle(Theme.faintForeground).padding(.horizontal, 8)
                }
                if page.isEmpty, unavailable.isEmpty, !source.values.isEmpty {
                    Text("Nothing is waiting on you.").font(.pilot(.headline)).foregroundStyle(Theme.mutedForeground)
                } else if source.values.isEmpty, unavailable.isEmpty { ProgressView("Loading Inbox…") }
            }.padding(32).frame(maxWidth: Theme.column).frame(maxWidth: .infinity)
        }
        .onAppear { source.start(hosts) }
        .onDisappear { source.stop() }
    }

    private var knownUnavailable: [HostRef] {
        Set(hosts.offlineHosts.keys).subtracting(hosts.available).union(source.errors).sorted(by: UnifiedInboxPresentation.hostOrder)
    }
    @ViewBuilder private func tracked(_ section: UnifiedInboxSection<TrackedItem>, title: String,
                                      triage: [PageSectionLinkChoice] = []) -> some View {
        if !section.isEmpty || !triage.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                SlackTriageInboxHeader.header(title: title, total: section.total, choices: triage)
                if section.isEmpty {
                    Text("No open Slack messages.").font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                }
                ForEach(section.rows) { row in
                    TrackedItemRow(item: row.value, actions: source.actions(on: row.ref.host), now: Date(), context: place(row.ref.host, row.value.projectId))
                        .environment(\.hostViewContext, HostViewContext(host: row.ref.host, hosts: hosts))
                    HairlineDivider()
                }
                capNote(shown: section.rows.count, total: section.total)
            }
        }
    }
    @ViewBuilder private func capNote(shown: Int, total: Int) -> some View {
        if let note = UnifiedInboxPresentation.capNote(shown: shown, total: total) {
            Text(note).font(.pilot(.caption)).foregroundStyle(Theme.faintForeground).padding(.leading, 34)
        }
    }
    private func place(_ host: HostRef, _ projectId: String) -> String {
        [hosts.projects.first { $0.ref.host == host && $0.value.id == projectId }?.value.name,
         HostViewContext(host: host, hosts: hosts).name].compactMap { $0 }.joined(separator: " · ")
    }
}

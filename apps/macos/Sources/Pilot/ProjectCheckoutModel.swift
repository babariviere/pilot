import Combine
import Foundation
import PilotCore

/// One presentation/lifecycle consumer of the existing project inventory and placement bindings.
@MainActor final class ProjectCheckoutModel: ObservableObject {
    @Published private(set) var revision: UInt64 = 0
    @Published private(set) var error: String?
    private(set) var state = RepositoryAssociations()
    private(set) var projects: [Hosted<Project>] = []
    private var inventory: [HostResourceRef: Hosted<Project>] = [:]
    private var observationsSinceSave = 0
    private var available: Set<HostRef> = []
    private var generations: [HostRef: UUID] = [:]
    private var observed: [HostResourceRef: String] = [:]
    private var tasks: [HostResourceRef: Task<Void, Never>] = [:]
    private var pending: [Hosted<Project>] = []
    private let admission = HostConnectionAdmission()
    private var reads: [UUID: Task<String?, Error>] = [:]
    private var started = false
    private var stopped = false
    private let store: RepositoryAssociationStore?
    private let read: @MainActor (HostResourceRef) async throws -> String?
    private var writes: Task<Void, Never>?
    private var groupRevision: UInt64?
    private var groupCache: [HostRef?: [ProjectCheckoutGroup]] = [:]

    init(store: RepositoryAssociationStore? = nil,
         read: @escaping @MainActor (HostResourceRef) async throws -> String?) {
        self.store = store; self.read = read
    }

    func start() async {
        guard !started, !stopped else { return }
        started = true
        do { if let store { state = try await store.load() } }
        catch { self.error = "Could not read saved checkout matches. The saved file was kept." }
        revision &+= 1
        rebuildPending()
        schedule()
    }

    func update(_ values: [Hosted<Project>], available: Set<HostRef>, generations: [HostRef: UUID]) {
        let changed = Dictionary(projects.map { ($0.ref, $0.value) }, uniquingKeysWith: { first, _ in first })
            != Dictionary(values.map { ($0.ref, $0.value) }, uniquingKeysWith: { first, _ in first })
            || self.available != available || self.generations != generations
        guard changed else { return }
        let previousGenerations = self.generations
        projects = values; self.available = available; self.generations = generations
        inventory = Dictionary(values.map { ($0.ref, $0) }, uniquingKeysWith: { first, _ in first })
        for (ref, task) in tasks where !available.contains(ref.host) || previousGenerations[ref.host] != generations[ref.host]
            || !values.contains(where: { $0.ref == ref }) {
            // Keep the slot until the canceled request actually unwinds; reconnect cannot over-admit.
            task.cancel()
        }
        revision &+= 1
        rebuildPending()
        schedule()
    }

    func groups(local: HostRef?) -> [ProjectCheckoutGroup] {
        if groupRevision != revision { groupCache.removeAll(); groupRevision = revision }
        if let cached = groupCache[local] { return cached }
        let result = ProjectCheckouts.groups(projects, origins: state.origins, bindings: state.bindings, local: local)
        groupCache[local] = result
        return result
    }

    func mapped(_ source: HostResourceRef, on host: HostRef) -> Hosted<Project>? {
        let values = groups(local: nil).first { $0.checkouts.contains { $0.ref == source } }?.checkouts.filter { $0.ref.host == host } ?? []
        return values.count == 1 ? values.first : nil
    }

    func origin(_ item: Hosted<Project>) -> String? {
        state.origins.first { $0.project == item.ref && $0.path == item.value.path }?.identity
    }

    /// Explicit selection is placement consent only, not SharedContext enrollment.
    func confirm(source: HostResourceRef, target: HostResourceRef) async throws {
        guard error == nil, let a = inventory[source],
              let b = inventory[target], source.host != target.host else { throw HostRoutingError.invalidReference }
        var next = state
        for mapping in next.bindings.mappings where mapping.project == target && mapping.logicalProjectId != source.storageKey {
            next.bindings.remove(logicalProjectId: mapping.logicalProjectId, host: target.host)
        }
        _ = try next.bindings.confirm(logicalProjectId: source.storageKey, project: target, remotePath: b.value.path,
            expectedGeneration: state.bindings.mapping(logicalProjectId: source.storageKey, host: target.host)?.generation,
            sourcePath: a.value.path, sourceOrigin: origin(a), destinationOrigin: origin(b))
        state = next; revision &+= 1
        // Serialize every snapshot, including concurrent origin completions, through one writer.
        await persist()
        if let error { throw ClientError(error) }
    }

    func useAutomatic(source: HostResourceRef, host: HostRef) async {
        state.bindings.remove(logicalProjectId: source.storageKey, host: host)
        revision &+= 1; await persist()
    }

    func refreshOrigins() { observed.removeAll(); rebuildPending(); schedule() }

    /// Recheck a mapped choice before enabling Send. Shares the same two-read admission as discovery.
    func verify(_ refs: [HostResourceRef]) async throws {
        guard !stopped else { throw HostRoutingError.disconnected }
        guard started else { return } // Inert previews/fixtures never acquire endpoints implicitly.
        for ref in refs.prefix(2) {
            guard available.contains(ref.host), let generation = generations[ref.host],
                  let item = inventory[ref] else { throw HostRoutingError.disconnected }
            let identity = try await admittedRead(ref)
            guard !Task.isCancelled, !stopped, generations[ref.host] == generation, available.contains(ref.host),
                  inventory[ref]?.value.path == item.value.path else { throw HostRoutingError.staleGeneration }
            state.origins.removeAll { $0.project == ref }
            state.origins.append(CheckoutOrigin(project: ref, path: item.value.path, identity: identity))
            revision &+= 1
        }
        await persist()
    }

    private func admittedRead(_ ref: HostResourceRef) async throws -> String? {
        try await admission.acquire()
        defer { admission.release() }
        try Task.checkCancellation()
        guard !stopped else { throw HostRoutingError.disconnected }
        let id = UUID(), action = read
        let task = Task { try await action(ref) }
        reads[id] = task
        defer { reads[id] = nil }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    private func rebuildPending() {
        pending = projects.reversed().filter { item in
            guard available.contains(item.ref.host), let generation = generations[item.ref.host] else { return false }
            return observed[item.ref] != generation.uuidString + "\u{0}" + item.value.path
        }
    }

    private func schedule() {
        guard started, !stopped else { return }
        // No timer or per-stream scan. Re-read at most once per checkout and verified connection generation.
        while tasks.count < 2, let item = pending.popLast() {
            guard let generation = generations[item.ref.host] else { continue }
            let key = generation.uuidString + "\u{0}" + item.value.path
            guard tasks[item.ref] == nil, observed[item.ref] != key else { continue }
            let ref = item.ref
            observed[ref] = key
            tasks[ref] = Task { [weak self] in
                guard let self else { return }
                defer {
                    self.tasks[ref] = nil
                    if !self.stopped, let current = self.inventory[ref],
                       let currentGeneration = self.generations[ref.host], self.available.contains(ref.host),
                       self.observed[ref] != currentGeneration.uuidString + "\u{0}" + current.value.path {
                        self.pending.append(current)
                    }
                    self.schedule()
                }
                do {
                    let identity = try await self.admittedRead(ref)
                    guard !Task.isCancelled, !self.stopped, self.generations[ref.host] == generation,
                          self.available.contains(ref.host), self.inventory[ref]?.value.path == item.value.path else { return }
                    let observation = CheckoutOrigin(project: ref, path: item.value.path, identity: identity)
                    guard !self.state.origins.contains(observation) else { return }
                    self.state.origins.removeAll { $0.project == ref }
                    self.state.origins.append(observation)
                    self.revision &+= 1
                    self.observationsSinceSave += 1
                    if self.observationsSinceSave >= 50 || self.pending.isEmpty {
                        self.observationsSinceSave = 0
                        await self.persist()
                    }
                } catch { /* Offline/old endpoints keep last verified evidence; never guess a new identity. */ }
            }
        }
    }

    private func persist() async {
        guard let store, error == nil else { return }
        let snapshot = state, revision = revision, previous = writes
        let task = Task { [weak self] in
            await previous?.value
            do { try await store.save(snapshot, revision: revision) }
            catch { self?.error = "Could not save checkout matches. Your draft and original saved file were kept." }
        }
        writes = task
        await task.value
    }

    func stop() async {
        stopped = true
        let pending = Array(tasks.values)
        let activeReads = Array(reads.values)
        for task in pending { task.cancel() }
        for task in activeReads { task.cancel() }
        for task in pending { await task.value }
        for task in activeReads { _ = try? await task.value }
        if started { await persist() }
        await writes?.value
    }
}

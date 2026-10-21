import Combine
import Foundation
import PilotCore

/// One window's read-only mission registry. Cached data survives disconnect; invalidations refresh
/// verified sources with two reads at a time. No writes, authority moves, timers or polling.
@MainActor
final class MissionRegistry: ObservableObject {
    @Published private(set) var rows: [LogicalMission] = []
    @Published private(set) var total: Int?
    @Published private(set) var truncated = false
    @Published private(set) var conflicts: Set<String> = []
    @Published private(set) var provisional: Set<String> = []
    @Published private(set) var failures: Set<HostRef> = []
    private var sources: [HostRef: LogicalMissionCatalog.Source] = [:]
    private var observations: [AnyCancellable] = []
    private var listeners: [HostRef: (PilotClient, UUID)] = [:]
    private var tokens: [HostRef: HostConnectionToken] = [:]
    private var pending: [HostRef] = []
    private var running: [HostRef: (UUID, Task<Void, Never>)] = [:]
    private var revision = 0
    private var rebuilding: Task<Void, Never>?
    private var needsBuild = false
    private var reconcileTask: Task<Void, Never>?
    private weak var model: AppModel?

    func start(_ model: AppModel) {
        guard self.model == nil else { return }
        self.model = model
        observations = [
            model.hosts.$missions.sink { [weak self] _ in self?.scheduleReconcile() },
            model.hosts.$available.sink { [weak self] _ in self?.scheduleReconcile() },
            model.hosts.$offlineHosts.sink { [weak self] _ in self?.scheduleReconcile() },
            model.client.$missions.sink { [weak self] _ in self?.scheduleReconcile() },
            model.client.$connected.sink { [weak self] _ in self?.scheduleReconcile() },
            model.$localHost.sink { [weak self] _ in self?.scheduleReconcile() },
        ]
        scheduleReconcile()
    }

    func stop() {
        observations.removeAll()
        for (client, id) in listeners.values { client.stopObservingMissionCatalog(id) }
        listeners.removeAll(); tokens.removeAll(); pending.removeAll()
        for (_, task) in running.values { task.cancel() }
        reconcileTask?.cancel(); reconcileTask = nil
        needsBuild = false
        revision += 1
        model = nil
    }

    private func scheduleReconcile() {
        guard reconcileTask == nil else { return }
        reconcileTask = Task { [weak self] in
            await Task.yield()
            guard let self, !Task.isCancelled else { return }
            self.reconcileTask = nil
            self.reconcile()
        }
    }

    private func reconcile() {
        guard let model else { return }
        var hosts = Set(model.hosts.offlineHosts.keys).union(model.hosts.missions.map { $0.ref.host })
        if let local = model.localHost { hosts.insert(local) }
        sources = sources.filter { hosts.contains($0.key) }
        for host in hosts {
            let missions = host == model.localHost ? model.client.missions
                : model.hosts.missions.filter { $0.ref.host == host }.map(\.value)
            let changedMissions = sources[host]?.missions != missions
            sources[host] = LogicalMissionCatalog.Source(host: host, missions: missions, dashboard: sources[host]?.dashboard)
            let client = host == model.localHost ? model.client : model.hosts.presentationClient(host)
            let token = client.connected ? HostConnectionToken(host: host, generation: client.connectionGeneration) : nil
            if tokens[host] != token || listeners[host]?.0 !== client {
                if let (previous, id) = listeners.removeValue(forKey: host) { previous.stopObservingMissionCatalog(id) }
                running[host]?.1.cancel()
                tokens[host] = token
                if let token {
                    let id = client.observeMissionCatalog { [weak self] in
                        self?.enqueue(token.host)
                    }
                    listeners[host] = (client, id)
                    enqueue(host)
                }
            }
            if changedMissions { enqueue(host) }
        }
        for host in Array(listeners.keys) where !hosts.contains(host) {
            if let (client, id) = listeners.removeValue(forKey: host) { client.stopObservingMissionCatalog(id) }
            tokens[host] = nil; running[host]?.1.cancel()
        }
        pending.removeAll { tokens[$0] == nil }
        rebuild()
        pump()
    }

    private func enqueue(_ host: HostRef) {
        guard tokens[host] != nil, !pending.contains(host) else { return }
        pending.append(host)
        pump()
    }

    private func pump() {
        guard let model else { return }
        while running.count < 2, let index = pending.firstIndex(where: { running[$0] == nil }) {
            let host = pending.remove(at: index)
            guard let token = tokens[host] else { continue }
            let client = host == model.localHost ? model.client : model.hosts.presentationClient(host)
            let id = UUID()
            let task = Task { [weak self] in
                guard let self else { return }
                do {
                    let dashboard = try await client.missionCatalog()
                    try Task.checkCancellation()
                    guard self.tokens[host] == token, client.connected,
                          client.connectionGeneration == token.generation else { throw HostRoutingError.staleGeneration }
                    self.sources[host]?.dashboard = dashboard
                    self.failures.remove(host)
                    self.rebuild()
                } catch {
                    if self.tokens[host] == token, !(error is CancellationError) { self.failures.insert(host) }
                }
                if self.running[host]?.0 == id { self.running[host] = nil }
                self.pump()
            }
            running[host] = (id, task)
        }
    }

    private func rebuild() {
        revision += 1
        needsBuild = true
        pumpBuild()
    }

    private func pumpBuild() {
        guard rebuilding == nil, needsBuild else { return }
        needsBuild = false
        let revision = revision
        let values = Array(sources.values)
        rebuilding = Task { [weak self] in
            // Normalization/JSON compatibility work never blocks typing or list layout.
            let work = Task.detached(priority: .utility) { try LogicalMissionCatalog.normalize(values) }
            let result = await work.result
            guard let self else { return }
            self.rebuilding = nil
            if self.model != nil, self.revision == revision, case let .success(value) = result {
                if self.rows != value.rows { self.rows = value.rows }
                self.total = value.total; self.truncated = value.truncated
                self.conflicts = value.conflicts; self.provisional = value.provisional
            }
            self.pumpBuild()
        }
    }

    func row(for reference: HostResourceRef) -> LogicalMission? {
        rows.first { LogicalMissionCatalog.matches($0.mission.home, pin: reference.host) && $0.mission.missionId == reference.localId }
    }

    func destination(_ row: LogicalMission, model: AppModel) -> HostResourceRef {
        let matches = Set(model.hosts.offlineHosts.keys).union(model.hosts.missions.map { $0.ref.host })
            .union(model.localHost.map { [$0] } ?? []).filter { LogicalMissionCatalog.matches(row.mission.home, pin: $0) }
        // Unknown or ambiguous enrollment never selects an execution host as a substitute home.
        let host = matches.count == 1 ? matches.first! : row.mission.home.envelopeIdentity
        return HostResourceRef(host: host, kind: .mission, localId: row.mission.missionId)
    }
}

import Combine
import Foundation
import PilotCore

/// Unified navigation/data facade. Each endpoint keeps its own caches, subscriptions and sockets.
/// Callers hold qualified refs, never select a process-wide "current server".
@MainActor
final class HostClients: ObservableObject {
    @Published private(set) var sessions: [Hosted<SessionSummary>] = []
    @Published private(set) var projects: [Hosted<Project>] = []
    @Published private(set) var missions: [Hosted<Mission>] = []
    @Published private(set) var available: Set<HostRef> = []
    @Published var selection: HostResourceRef?
    @Published private(set) var dashboards: [HostResourceRef: ProjectDashboard] = [:]
    @Published private(set) var missionDetails: [HostResourceRef: MissionDetail] = [:]
    private struct Entry {
        let client: PilotClient
        let token: HostConnectionToken
        var observations: [AnyCancellable]
    }
    private var entries: [HostRef: Entry] = [:]
    private var tunnels: [HostRef: ManagedSSHTunnel] = [:]
    private var tunnelWatches: [HostRef: Task<Void, Never>] = [:]
    private var tunnelURLs: [HostRef: URL] = [:]
    @MainActor private final class Subscription {
        let ref: HostResourceRef
        let listener: ([JSONValue]) -> Void
        var client: PilotClient?
        var token: UUID?
        init(ref: HostResourceRef, listener: @escaping ([JSONValue]) -> Void) {
            self.ref = ref; self.listener = listener
        }
        func detach() {
            if let client, let token { client.unsubscribe(ref.localId, token: token) }
            client = nil; token = nil
        }
    }
    private var subscriptions: [UUID: Subscription] = [:]
    private var retained: [HostResourceRef: Int] = [:]
    private var pendingRefresh: Set<HostRef> = []
    private var pendingDetails: Set<HostRef> = []
    var hasPendingUpdates: Bool { !pendingRefresh.isEmpty || !pendingDetails.isEmpty }

    private func enqueueRefresh(_ host: HostRef, details: Bool = false) {
        if details {
            guard pendingDetails.insert(host).inserted else { return }
        } else {
            guard pendingRefresh.insert(host).inserted else { return }
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if details { self.pendingDetails.remove(host) } else { self.pendingRefresh.remove(host) }
            guard let entry = self.entries[host] else { return }
            if details { self.refreshDetails(host, token: entry.token) }
            else { self.refresh(host, token: entry.token) }
        }
    }
    private let operations = OperationOutbox(directory: FileManager.default.urls(
        for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Pilot/Operations"))

    /// Return the original intent with a conclusive or uncertain delivery state. No draft is cleared here.
    func deliver<Payload: Encodable & Sendable>(host: HostRef, kind: String, targetId: String?,
        payload: Payload, origin: HostRef) async throws -> (DurableOperation, OperationDelivery) {
        let client = try endpoint(host)
        let fence = try token(for: host)
        let operation = try await operations.reserve(kind: kind, targetId: targetId, payload: payload,
                                                     origin: origin, destination: host)
        do {
            // Receipt first. An unknown receipt may only be retried through this immutable endpoint.
            let known = try await client.operation(operation, lookup: true)
            try validate(fence)
            if case let .receipt(receipt) = known, receipt.state != .pending { return (operation, known) }
            let delivery = try await client.operation(operation, lookup: false)
            try validate(fence)
            return (operation, delivery)
        } catch {
            // The request may have been accepted. Keep original intent, draft and attachments.
            return (operation, .unknown)
        }
    }

    func acknowledge(_ operation: DurableOperation, receipt: OperationReceipt) async throws {
        try await operations.acknowledge(operation, receipt: receipt)
    }

    func repositoryDirectory(host: HostRef, selection: RepositorySelection,
                             offset: Int = 0) async throws -> RepositoryDirectoryPage {
        let token = try token(for: host)
        let value = try await endpoint(host).repositoryDirectory(selection, offset: offset)
        try validate(token)
        return value
    }

    func selectRepository(host: HostRef, selection: RepositorySelection) async throws -> Hosted<Project> {
        let token = try token(for: host)
        let project = try await endpoint(host).createRepositoryProject(selection)
        try validate(token)
        return Hosted(ref: HostResourceRef(host: host, kind: .project, localId: project.id), value: project)
    }

    func file(_ session: HostResourceRef, path: String) async throws -> SessionFileContent {
        try await perform(session, kind: .session) { client, id in try await client.file(id, path: path) }
    }

    func changes(_ session: HostResourceRef) async throws -> SessionChanges {
        try await perform(session, kind: .session) { client, id in try await client.changes(id) }
    }

    func install(_ client: PilotClient, host: HostRef) throws {
        try client.bind(host)
        if entries[host]?.client === client { return }
        removeConnection(host)
        let token = HostConnectionToken(host: host)
        var entry = Entry(client: client, token: token, observations: [])
        // Transcript/artifact traffic must not rebuild every host's sidebar partition.
        entry.observations.append(Publishers.CombineLatest4(
            client.$sessions, client.$projects, client.$missions, client.$connected
        ).sink { [weak self] _ in
            self?.enqueueRefresh(host)
        })
        entry.observations.append(Publishers.CombineLatest(client.$projectDashboards, client.$missionDetails)
            .sink { [weak self] _ in
                self?.enqueueRefresh(host, details: true)
            })
        entries[host] = entry
        for subscription in subscriptions.values where subscription.ref.host == host { attach(subscription) }
        for (ref, count) in retained where ref.host == host {
            for _ in 0..<count { retainOnEndpoint(ref, client: client) }
        }
        refresh(host, token: token)
        refreshDetails(host, token: token)
    }

    /// Enrollment pins an explicitly confirmed identity. No first-response TOFU during reconnect.
    func connect(host: HostRef, configuration: SSHConnectionConfiguration) async throws {
        guard host.hostId != "local" else { throw HostRoutingError.invalidReference }
        await disconnect(host)
        let tunnel = ManagedSSHTunnel(configuration: configuration) { data in
            try host.validate(JSONDecoder().decode(DaemonHello.self, from: data))
        }
        tunnels[host] = tunnel
        let states = await tunnel.states()
        tunnelWatches[host] = Task { [weak self] in
            for await state in states {
                guard !Task.isCancelled, let self, self.tunnels[host] === tunnel else { break }
                switch state {
                case let .connected(url):
                    do { try self.installTunnelEndpoint(host, url: url) }
                    catch { self.removeConnection(host) }
                default:
                    self.tunnelURLs[host] = nil
                    self.removeConnection(host)
                }
            }
        }
        do {
            let url = try await tunnel.connect()
            guard tunnels[host] === tunnel else { throw HostRoutingError.staleGeneration }
            try installTunnelEndpoint(host, url: url)
        } catch {
            if tunnels[host] === tunnel { await disconnect(host) }
            throw error
        }
    }

    private func installTunnelEndpoint(_ host: HostRef, url: URL) throws {
        if tunnelURLs[host] == url, entries[host] != nil { return }
        let client = PilotClient()
        try install(client, host: host)
        tunnelURLs[host] = url
        client.connect(to: url)
    }

    func disconnect(_ host: HostRef) async {
        tunnelWatches.removeValue(forKey: host)?.cancel()
        tunnelURLs[host] = nil
        let tunnel = tunnels.removeValue(forKey: host)
        removeConnection(host)
        await tunnel?.disconnect()
    }

    /// Quit closes only owned local forwards, never remote agents or daemon services.
    func disconnectAll() async {
        for host in Array(tunnels.keys) { await disconnect(host) }
    }

    /// Removal keeps last-known summaries. It does not invent an execution outcome.
    private func removeConnection(_ host: HostRef) {
        for subscription in subscriptions.values where subscription.ref.host == host { subscription.detach() }
        entries.removeValue(forKey: host)?.client.disconnect()
        available.remove(host)
    }

    func endpoint(_ ref: HostResourceRef, kind: HostResourceKind) throws -> PilotClient {
        guard ref.kind == kind else { throw HostRoutingError.invalidReference }
        return try endpoint(ref.host)
    }

    func endpoint(_ host: HostRef) throws -> PilotClient {
        guard let entry = entries[host], entry.client.connected else { throw HostRoutingError.disconnected }
        return entry.client
    }

    func token(for host: HostRef) throws -> HostConnectionToken {
        let client = try endpoint(host)
        return HostConnectionToken(host: host, generation: client.connectionGeneration)
    }

    func validate(_ token: HostConnectionToken) throws {
        let client = try endpoint(token.host)
        guard client.connectionGeneration == token.generation else { throw HostRoutingError.staleGeneration }
    }

    /// All endpoint-specific APIs (history, changes, models, commands, dashboards, memory, etc.)
    /// can use this fence without exposing a mutable global endpoint selection.
    func perform<Value>(_ ref: HostResourceRef, kind: HostResourceKind,
                        _ operation: (PilotClient, String) async throws -> Value) async throws -> Value {
        let client = try endpoint(ref, kind: kind)
        let token = try token(for: ref.host)
        let value = try await operation(client, ref.localId)
        try validate(token)
        return value
    }

    func send(_ session: HostResourceRef, message: String, mode: DeliveryMode) async throws {
        let client = try endpoint(session, kind: .session)
        let token = try token(for: session.host)
        try await client.send(session.localId, message: message, mode: mode)
        try validate(token)
    }

    func subscribe(_ session: HostResourceRef, listener: @escaping ([JSONValue]) -> Void) throws -> () -> Void {
        guard session.kind == .session, subscriptions.count < 256 else { throw HostRoutingError.invalidReference }
        let id = UUID()
        let subscription = Subscription(ref: session, listener: listener)
        subscriptions[id] = subscription
        attach(subscription)
        return { [weak self] in self?.subscriptions.removeValue(forKey: id)?.detach() }
    }

    private func attach(_ subscription: Subscription) {
        subscription.detach()
        guard let entry = entries[subscription.ref.host] else { return }
        let endpointToken = entry.token
        subscription.client = entry.client
        subscription.token = entry.client.subscribe(subscription.ref.localId) { [weak self, weak subscription] events in
            guard let self, let subscription, self.entries[subscription.ref.host]?.token == endpointToken else { return }
            subscription.listener(events)
        }
    }

    func retain(_ ref: HostResourceRef) throws -> () -> Void {
        guard ref.kind == .project || ref.kind == .mission, retained.count < 32 || retained[ref] != nil,
              retained[ref, default: 0] < 64 else {
            throw HostRoutingError.invalidReference
        }
        retained[ref, default: 0] += 1
        if let client = entries[ref.host]?.client { retainOnEndpoint(ref, client: client) }
        var released = false
        return { [weak self] in
            guard !released, let self, let count = self.retained[ref] else { return }
            released = true
            if count == 1 { self.retained[ref] = nil } else { self.retained[ref] = count - 1 }
            if let client = self.entries[ref.host]?.client {
                if ref.kind == .project { client.releaseDashboard(ref.localId) }
                else { client.releaseMission(ref.localId) }
            }
        }
    }

    private func retainOnEndpoint(_ ref: HostResourceRef, client: PilotClient) {
        if ref.kind == .project { client.retainDashboard(ref.localId) }
        else { client.retainMission(ref.localId) }
    }

    private func refreshDetails(_ host: HostRef, token: HostConnectionToken) {
        guard let entry = entries[host], entry.token == token else { return }
        for (id, value) in entry.client.projectDashboards {
            let key = HostResourceRef(host: host, kind: .project, localId: id)
            if dashboards[key] == nil, dashboards.count >= 32 {
                if let victim = dashboards.keys.first(where: { retained[$0] == nil }) { dashboards[victim] = nil }
                else { continue }
            }
            dashboards[key] = value
        }
        for (id, value) in entry.client.missionDetails {
            let key = HostResourceRef(host: host, kind: .mission, localId: id)
            if missionDetails[key] == nil, missionDetails.count >= 32 {
                if let victim = missionDetails.keys.first(where: { retained[$0] == nil }) { missionDetails[victim] = nil }
                else { continue }
            }
            missionDetails[key] = value
        }
    }

    func artifact(_ reference: HostedArtifactReference) async throws -> ArtifactRevision {
        let token = try token(for: reference.host)
        let value = try await endpoint(reference.host).artifact(reference.artifact)
        try validate(token)
        return value
    }

    private func refresh(_ host: HostRef, token: HostConnectionToken) {
        guard let entry = entries[host], entry.token == token else { return }
        if entry.client.connected { available.insert(host) } else { available.remove(host) }
        // A temporary empty endpoint before its first authoritative list must not erase offline data.
        guard entry.client.hasProjectSnapshot else { return }
        sessions = sessions.filter { $0.ref.host != host } + entry.client.sessions.map {
            Hosted(ref: HostResourceRef(host: host, kind: .session, localId: $0.id), value: $0)
        }
        projects = projects.filter { $0.ref.host != host } + entry.client.projects.map {
            Hosted(ref: HostResourceRef(host: host, kind: .project, localId: $0.id), value: $0)
        }
        missions = missions.filter { $0.ref.host != host } + entry.client.missions.map {
            Hosted(ref: HostResourceRef(host: host, kind: .mission, localId: $0.id), value: $0)
        }
    }
}

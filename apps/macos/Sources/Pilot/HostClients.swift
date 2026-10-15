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
    private struct Entry {
        let client: PilotClient
        let token: HostConnectionToken
        var observations: [AnyCancellable]
    }
    private var entries: [HostRef: Entry] = [:]
    private var tunnels: [HostRef: ManagedSSHTunnel] = [:]

    func install(_ client: PilotClient, host: HostRef) {
        if entries[host]?.client === client { return }
        removeConnection(host)
        let token = HostConnectionToken(host: host)
        var entry = Entry(client: client, token: token, observations: [])
        // Transcript/artifact traffic must not rebuild every host's sidebar partition.
        entry.observations.append(Publishers.CombineLatest4(
            client.$sessions, client.$projects, client.$missions, client.$connected
        ).sink { [weak self] _ in
            Task { @MainActor in self?.refresh(host, token: token) }
        })
        entries[host] = entry
        refresh(host, token: token)
    }

    /// Enrollment pins an explicitly confirmed identity. No first-response TOFU during reconnect.
    func connect(host: HostRef, configuration: SSHConnectionConfiguration) async throws {
        let tunnel = ManagedSSHTunnel(configuration: configuration) { data in
            try host.validate(JSONDecoder().decode(DaemonHello.self, from: data))
        }
        tunnels[host] = tunnel
        let url = try await tunnel.connect()
        guard tunnels[host] === tunnel else { await tunnel.disconnect(); throw HostRoutingError.staleGeneration }
        let client = PilotClient()
        install(client, host: host)
        client.connect(to: url)
    }

    func disconnect(_ host: HostRef) async {
        let tunnel = tunnels.removeValue(forKey: host)
        removeConnection(host)
        await tunnel?.disconnect()
    }

    /// Removal keeps last-known summaries. It does not invent an execution outcome.
    private func removeConnection(_ host: HostRef) {
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
        let client = try endpoint(session, kind: .session)
        let token = entries[session.host]!.token
        let subscription = client.subscribe(session.localId) { [weak self] events in
            guard let self, self.entries[session.host]?.token == token else { return }
            listener(events)
        }
        // Capture the owning client, not a lookup that could unsubscribe a replacement endpoint.
        return { client.unsubscribe(session.localId, token: subscription) }
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

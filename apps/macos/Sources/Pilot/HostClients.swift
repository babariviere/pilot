import Combine
import Foundation
import PilotCore
import PilotTelemetry

/// The only lifecycle operations exposed to the app are on owned local forwards.
protocol HostTunnel: AnyObject, Sendable {
    func states() async -> AsyncStream<SSHTunnelState>
    func connect() async throws -> URL
    func disconnect() async
}
extension ManagedSSHTunnel: HostTunnel {}

enum HostedHistoryAvailability: Equatable {
    case online, cached, requiresReconnect
    var explanation: String? {
        self == .requiresReconnect ? "This history is not cached. Reconnect to load it." : nil
    }
}

/// Unified navigation/data facade. Each endpoint keeps its own caches, subscriptions and sockets.
/// Callers hold qualified refs, never select a process-wide "current server".
@MainActor
final class HostClients: ObservableObject {
    private var checkoutObservation: AnyCancellable?
    private let checkoutDirectory: URL
    private(set) lazy var projectCheckouts: ProjectCheckoutModel = {
        let file = checkoutDirectory.appendingPathComponent("project-checkouts.json")
        let model = ProjectCheckoutModel(store: RepositoryAssociationStore(file: file)) { [weak self] ref in
            guard let self else { throw HostRoutingError.disconnected }
            return try await self.perform(ref, kind: .project) { try await $0.projectOrigin($1).identity }
        }
        checkoutObservation = model.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        return model
    }()

    private func refreshProjectCheckouts() {
        projectCheckouts.update(projects, available: available,
            generations: entries.mapValues { $0.client.connectionGeneration })
    }
    let machineInformationStore = DevboxMachineStore()
    var onOperationDeliveryChanged: ((DurableOperation, OperationDelivery) -> Void)?
    var onRemoteSessionsChanged: ((HostRef, [SessionSummary], Bool) -> Void)?
    @Published private(set) var sessions: [Hosted<SessionSummary>] = []
    @Published private(set) var projects: [Hosted<Project>] = []
    @Published private(set) var missions: [Hosted<Mission>] = []
    @Published private(set) var available: Set<HostRef> = []
    @Published private(set) var connectionStates: [HostRef: SSHTunnelState] = [:]
    @Published private(set) var offlineHosts: [HostRef: OfflineHostSnapshot] = [:]
    @Published private(set) var persistenceError: String?
    /// Receipts remain here until the owning composer adopts them durably. Unknown is not rejection.
    @Published private(set) var pendingOperations: [String: DurableOperation] = [:]
    @Published private(set) var operationDeliveries: [String: OperationDelivery] = [:]
    @Published var selection: HostResourceRef?
    @Published private(set) var dashboards: [HostResourceRef: ProjectDashboard] = [:]
    @Published private(set) var missionDetails: [HostResourceRef: MissionDetail] = [:]
    // A presentation client may be offline, but is never redirected to another host.
    private var presentationClients: [HostRef: PilotClient] = [:]
    func presentationClient(_ host: HostRef) -> PilotClient {
        if let client = entries[host]?.client { return client }
        if let client = presentationClients[host] { return client }
        let client = PilotClient()
        try? client.bind(host)
        if let snapshot = offlineHosts[host] {
            client.restoreOfflinePresentation(snapshot)
        }
        client.disconnect()
        presentationClients[host] = client
        return client
    }

    private struct Entry {
        let client: PilotClient
        let token: HostConnectionToken
        var observations: [AnyCancellable]
    }
    private var entries: [HostRef: Entry] = [:]
    private var diagnosticReads: [String: Task<Void, Never>] = [:]
    private let readNativeCapability: @MainActor (HostRef, SSHConnectionConfiguration?) async throws -> String
    @Published private(set) var sharedRevision = 0
    let sharedContextCourier = SharedContextCourier()
    private var sharedContextGenerations: [HostRef: UUID] = [:]

    /// Explicit UI enrollment/edit reconciliation. Never queues an arbitrary chat mutation.
    func reconcileSharedContexts() { sharedRevision &+= 1; sharedContextCourier.trigger() }

    private func refreshSharedContextEndpoints() {
        guard !shuttingDown else { return }
        sharedContextCourier.update(entries.filter {
            $0.value.client.connected && $0.value.client.sharedContextTransportEnabled
        }.mapValues {
            SharedContextCourier.Endpoint(client: $0.client, host: $0.token.host)
        })
    }
    @MainActor private final class TerminalRegistration {
        let ref: HostResourceRef
        let intent: WorkspaceTerminalIntent
        var attachment: PilotClient.TerminalAttachment
        var client: PilotClient?
        init(ref: HostResourceRef, restart: Bool, attachment: PilotClient.TerminalAttachment) {
            self.ref = ref; self.intent = WorkspaceTerminalIntent(restart: restart); self.attachment = attachment
        }
        func detach() { client?.detachTerminal(ref.localId); client = nil }
    }
    private var terminalRegistrations: [HostResourceRef: TerminalRegistration] = [:]

    /// Retain intent, not a tunnel URL. Replacement verified clients reattach the same shell/key.
    func attachTerminal(_ ref: HostResourceRef, restart: Bool = false,
                        attachment: PilotClient.TerminalAttachment) throws {
        guard ref.kind == .session, terminalRegistrations[ref] != nil || terminalRegistrations.count < 16 else {
            throw HostRoutingError.invalidReference
        }
        terminalRegistrations.removeValue(forKey: ref)?.detach()
        let registration = TerminalRegistration(ref: ref, restart: restart, attachment: attachment)
        terminalRegistrations[ref] = registration
        attachTerminalRegistration(registration)
    }

    private func attachTerminalRegistration(_ registration: TerminalRegistration) {
        registration.detach()
        let ref = registration.ref
        guard let entry = entries[ref.host] else { registration.attachment.onStatus(.disconnected); return }
        registration.client = entry.client
        let token = entry.token
        var attachment = registration.attachment
        attachment.onData = { [weak self, weak registration] data in
            guard let self, let registration, self.entries[ref.host]?.token == token,
                  self.terminalRegistrations[ref] === registration else { return }
            registration.attachment.onData(data)
        }
        attachment.onExit = { [weak self, weak registration] code in
            guard let self, let registration, self.entries[ref.host]?.token == token,
                  self.terminalRegistrations[ref] === registration else { return }
            registration.attachment.onExit(code)
        }
        attachment.onReplay = { [weak self, weak registration] in
            guard let self, let registration, self.entries[ref.host]?.token == token,
                  self.terminalRegistrations[ref] === registration else { return }
            registration.attachment.onReplay()
        }
        attachment.onStatus = { [weak self, weak registration] status in
            guard let self, let registration, self.entries[ref.host]?.token == token,
                  self.terminalRegistrations[ref] === registration else { return }
            registration.attachment.onStatus(status)
        }
        entry.client.attachTerminal(ref.localId, cols: attachment.cols, rows: attachment.rows,
                                    intent: registration.intent, attachment)
    }

    func detachTerminal(_ ref: HostResourceRef) { terminalRegistrations.removeValue(forKey: ref)?.detach() }
    func reconnectTerminal(_ ref: HostResourceRef) throws {
        _ = try endpoint(ref, kind: .session)
        guard let registration = terminalRegistrations[ref] else { throw HostRoutingError.invalidReference }
        attachTerminalRegistration(registration)
    }
    @discardableResult func terminalInput(_ ref: HostResourceRef, data: Data) -> Bool {
        guard let client = try? endpoint(ref, kind: .session), terminalRegistrations[ref]?.client === client else { return false }
        return client.terminalInput(ref.localId, data)
    }
    func terminalResize(_ ref: HostResourceRef, cols: Int, rows: Int) {
        guard let registration = terminalRegistrations[ref] else { return }
        registration.attachment.cols = cols; registration.attachment.rows = rows
        guard let client = try? endpoint(ref, kind: .session), registration.client === client else { return }
        client.terminalResize(ref.localId, cols: cols, rows: rows)
    }
    @discardableResult func closeTerminal(_ ref: HostResourceRef) -> Bool {
        guard let client = try? endpoint(ref, kind: .session), terminalRegistrations[ref]?.client === client else { return false }
        return client.closeTerminal(ref.localId)
    }
    func terminalReadPaused(_ ref: HostResourceRef, _ paused: Bool) {
        terminalRegistrations[ref]?.client?.terminalReadPaused(ref.localId, paused)
    }
    private var tunnels: [HostRef: any HostTunnel] = [:]
    private var tunnelWatches: [HostRef: Task<Void, Never>] = [:]
    private var tunnelURLs: [HostRef: URL] = [:]
    private var connectionAttempts: [HostRef: UUID] = [:]
    private struct ConnectionJob {
        let id: UUID
        let configuration: SSHConnectionConfiguration
        let task: Task<Void, Error>
    }
    private var connectionJobs: [HostRef: ConnectionJob] = [:]
    private var tunnelConfigurations: [HostRef: SSHConnectionConfiguration] = [:]
    private var connectionCleanup: [HostRef: (UUID, Task<Void, Never>)] = [:]
    private let savedStartup = SavedDevboxStartup()
    private let connectionAdmission = HostConnectionAdmission()
    /// Read-only, generation-fenced hello/version evidence for lifecycle consumers outside Settings.
    let remoteRuntimes = VerifiedRemoteRuntimes()
    /// One owner for live lifecycle fan-out and Settings. Construction performs no I/O.
    let scopedModels: ScopedModelsSync
    private let readScopedModelCapability: @MainActor (HostRef, SSHConnectionConfiguration?) async throws -> String
    private var scopedModelsStarted = false
    private let automaticUpdateConfiguration: DevboxAutomaticUpdateConfiguration
    private let devboxUpdateStore: DevboxUpdateIntentStore
    /// One model per pinned host, reused by Settings and the automatic lifecycle consumer.
    private(set) lazy var devboxUpdates = AutomaticDevboxUpdates(runtimes: remoteRuntimes,
        targetVersion: automaticUpdateConfiguration.targetVersion,
        loadPackage: automaticUpdateConfiguration.loadPackage,
        actions: automaticUpdateConfiguration.actions ?? .live(self), store: devboxUpdateStore,
        validate: { [weak self] token in
            guard let self, !self.shuttingDown else { return false }
            return (try? self.validate(token)) != nil
        })
    private var liveConnectionsStarted = false
    private var enrollingHosts: Set<HostRef> = []
    var startupConnectionsIdle: Bool {
        savedStartup.isIdle && connectionJobs.isEmpty && connectionCleanup.isEmpty && remoteRuntimes.isIdle && scopedModels.isIdle && devboxUpdates.isIdle
    }
    private let makeTunnel: (SSHConnectionConfiguration, HostRef) -> any HostTunnel
    private let makeClient: @MainActor () -> PilotClient
    private let connectClient: @MainActor (PilotClient, URL) -> Void
    private let readRuntimeHello: @MainActor (PilotClient, HostRef) async throws -> DaemonHello
    private var offlineStore: OfflineHostStore?
    private var offlineReady = false
    private var saveTask: Task<Void, Never>?
    private var saveRevision: UInt64 = 0
    private var reconciliationTasks: [HostRef: Task<Void, Never>] = [:]
    private var reconciliationGenerations: [HostRef: UUID] = [:]
    private var shuttingDown = false

    init(operationDirectory: URL? = nil,
         makeTunnel: @escaping (SSHConnectionConfiguration, HostRef) -> any HostTunnel = { configuration, host in
             ManagedSSHTunnel(configuration: configuration) { data in
                 try host.validate(JSONDecoder().decode(DaemonHello.self, from: data))
             }
         }, makeClient: @escaping @MainActor () -> PilotClient = {
             let configuration = URLSessionConfiguration.ephemeral
             configuration.timeoutIntervalForRequest = 15
             configuration.timeoutIntervalForResource = 30
             return PilotClient(commandConfiguration: configuration)
         },
         connectClient: @escaping @MainActor (PilotClient, URL) -> Void = { $0.connect(to: $1) },
         scopedModelsStore: ScopedModelsStore? = nil,
         readScopedModelCapability: @escaping @MainActor (HostRef, SSHConnectionConfiguration?) async throws -> String = {
             try await GitHubNativeAccess.read(host: $0, configuration: $1)
         },
         readNativeCapability: @escaping @MainActor (HostRef, SSHConnectionConfiguration?) async throws -> String = {
             try await GitHubNativeAccess.read(host: $0, configuration: $1)
         },
         automaticUpdates: DevboxAutomaticUpdateConfiguration? = nil,
         readRuntimeHello: @escaping @MainActor (PilotClient, HostRef) async throws -> DaemonHello = { client, _ in
             try await client.hello()
         }) {
        self.makeTunnel = makeTunnel; self.makeClient = makeClient
        self.connectClient = connectClient
        self.readRuntimeHello = readRuntimeHello
        self.readScopedModelCapability = readScopedModelCapability
        self.readNativeCapability = readNativeCapability
        scopedModels = ScopedModelsSync(store: scopedModelsStore ?? ScopedModelsStore(directory:
            operationDirectory?.appendingPathComponent("scoped-models", isDirectory: true) ??
                FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("Pilot/ScopedModels", isDirectory: true)))
        automaticUpdateConfiguration = automaticUpdates ?? DevboxAutomaticUpdateConfiguration()
        devboxUpdateStore = automaticUpdates?.store ?? operationDirectory.map {
            DevboxUpdateIntentStore(directory: $0.appendingPathComponent("devbox-updates", isDirectory: true))
        } ?? .shared
        // The outbox decodes every top-level JSON file as an operation. Keep checkout metadata separate.
        checkoutDirectory = operationDirectory?.appendingPathComponent("project-checkouts", isDirectory: true) ?? FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Pilot")
        operations = OperationOutbox(directory: operationDirectory ?? FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Pilot/Operations"))
    }

    /// Startup reads local metadata only. No SSH, mutation replay, outcome notifications or failover.
    func restoreOffline(from store: OfflineHostStore) async throws {
        guard offlineStore == nil else { return }
        offlineStore = store
        do {
            let snapshots = try await store.load()
            for snapshot in snapshots where entries[snapshot.host] == nil {
                offlineHosts[snapshot.host] = snapshot
                connectionStates[snapshot.host] = .disconnected
                replaceSummaries(snapshot.host, sessions: snapshot.sessions, projects: snapshot.projects,
                                 missions: snapshot.missions)
            }
            for operation in try await operations.pending() {
                pendingOperations[operation.operationId] = operation
                operationDeliveries[operation.operationId] = .unknown
            }
            offlineReady = true
        } catch { persistenceError = "Could not read saved host metadata. The original data was kept."; throw error }
    }

    /// Explicit user-confirmed enrollment. A changed daemon/lineage requires a separate repair flow.
    func enroll(_ host: HostRef, configuration: SSHConnectionConfiguration) async throws {
        guard !shuttingDown, offlineReady, !enrollingHosts.contains(host), host.hostId != "local", !host.hostId.isEmpty,
              !host.daemonId.isEmpty, !host.lineageId.isEmpty,
              !offlineHosts.keys.contains(where: { $0.hostId == host.hostId && $0 != host }),
              offlineHosts[host] != nil || offlineHosts.count < 32 else { throw HostRoutingError.identityChanged }
        if offlineHosts[host]?.configuration == configuration { return }
        enrollingHosts.insert(host)
        defer { enrollingHosts.remove(host) }
        if let previous = offlineHosts[host], previous.configuration != configuration {
            // A queued/held launch attempt may not use superseded connection coordinates.
            await disconnect(host)
        }
        let previous = offlineHosts[host]
        if let existing = previous {
            offlineHosts[host] = OfflineHostSnapshot(host: host, configuration: configuration,
                receivedAt: existing.receivedAt, sessions: existing.sessions, projects: existing.projects,
                missions: existing.missions, stopRequests: existing.stopRequests)
        } else { offlineHosts[host] = OfflineHostSnapshot(host: host, configuration: configuration) }
        do { try await flushOffline() }
        catch { offlineHosts[host] = previous; throw error }
    }

    func reconnect(_ host: HostRef) async throws {
        guard let configuration = offlineHosts[host]?.configuration else { throw HostRoutingError.invalidReference }
        try await connect(host: host, configuration: configuration)
    }

    /// Explicit live-app admission, separate from pure offline restoration and preview construction.
    func startSavedConnections() {
        guard offlineReady, !shuttingDown else { return }
        liveConnectionsStarted = true
        refreshRuntimeEndpoints()
        savedStartup.start(offlineHosts.values.map {
            SavedDevboxStartup.Request(host: $0.host, configuration: $0.configuration)
        }) { [weak self] request in
            guard let self else { throw HostRoutingError.disconnected }
            try Task.checkCancellation()
            try await self.connect(host: request.host, configuration: request.configuration)
        }
    }

    /// Explicit live admission only. restoreOffline, init and Settings rendering remain inert.
    func startScopedModels() {
        guard !shuttingDown else { return }
        scopedModelsStarted = true
        refreshScopedModelEndpoints()
    }

    private func refreshScopedModelEndpoints() {
        guard scopedModelsStarted, !shuttingDown else { return }
        scopedModels.update(entries.filter { $0.value.client.connected }.mapValues { entry in
            let client = entry.client, host = entry.token.host
            let token = HostConnectionToken(host: host, generation: client.connectionGeneration)
            return ScopedModelsTransport(client: client, token: token, validate: { [weak self, weak client] in
                guard let self, let client, !self.shuttingDown, self.entries[host]?.client === client,
                      client.hostIdentity == host else { throw HostRoutingError.staleGeneration }
                try self.validate(token)
            }, capability: { [weak self] in
                guard let self else { throw HostRoutingError.disconnected }
                try self.validate(token)
                let configuration = self.offlineHosts[host]?.configuration
                guard host.hostId == "local" || configuration != nil else { throw HostRoutingError.invalidReference }
                let value = try await self.readScopedModelCapability(host, configuration)
                try self.validate(token)
                return value
            }).endpoint()
        })
    }

    private func refreshRuntimeEndpoints() {
        guard liveConnectionsStarted, !shuttingDown else { return }
        remoteRuntimes.update(entries.filter { $0.key.hostId != "local" && $0.value.client.connected }.mapValues { entry in
            let client = entry.client, host = entry.token.host, generation = client.connectionGeneration
            return VerifiedRemoteRuntimes.Endpoint(token: HostConnectionToken(host: host, generation: generation),
                isCurrent: { [weak self, weak client] in
                    guard let self, let client else { return false }
                    return !self.shuttingDown && self.entries[host]?.client === client && client.connected
                        && client.connectionGeneration == generation && client.hostIdentity == host
                }, hello: { [weak self, weak client] in
                    guard let self, let client else { throw HostRoutingError.disconnected }
                    return try await self.readRuntimeHello(client, host)
                })
        })
        devboxUpdates.retainSavedHosts(Set(offlineHosts.keys))
        devboxUpdates.targetChanged()
    }

    func startAutomaticDevboxUpdates() {
        guard !shuttingDown else { return }
        devboxUpdates.start()
    }

    func historyAvailability(_ ref: HostResourceRef, cached: Bool) -> HostedHistoryAvailability {
        available.contains(ref.host) ? .online : cached ? .cached : .requiresReconnect
    }

    private func scheduleSave() {
        guard offlineStore != nil else { return }
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(500)); try await self?.flushOffline() }
            catch {}
        }
    }

    func flushOffline() async throws {
        saveTask?.cancel(); saveTask = nil
        // Quit may race the initial actor read. Never flush a not-yet-restored empty partition.
        guard offlineReady, let offlineStore else { return }
        // Actor scheduling need not be FIFO. An older in-flight save cannot replace the quit flush.
        saveRevision += 1
        let revision = saveRevision
        do {
            try await offlineStore.save(Array(offlineHosts.values), revision: revision)
            if saveRevision == revision { persistenceError = nil }
        } catch {
            if saveRevision == revision { persistenceError = "Could not save offline host metadata." }
            throw error
        }
    }
    @MainActor private final class Subscription {
        let ref: HostResourceRef
        let listener: ([JSONValue]) -> Void
        var trace: PilotTraceCarrier?
        var client: PilotClient?
        var token: UUID?
        init(ref: HostResourceRef, trace: PilotTraceCarrier?, listener: @escaping ([JSONValue]) -> Void) {
            self.ref = ref; self.trace = trace; self.listener = listener
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
    private var activeUploads = 0

    func upload(_ image: PastedImage, host: HostRef, origin: HostRef) async throws -> HostedAttachment {
        let client = try endpoint(host)
        let fence = try token(for: host)
        guard activeUploads < 2 else { throw ClientError("Image uploads are busy") }
        activeUploads += 1
        defer { activeUploads -= 1 }
        // Keep the local copy through unknown operation delivery and durable-history ownership.
        try image.retainForHistory()
        let metadata = try await AttachmentTransfer.prepare(file: image.url, ownedDirectory: ImageAttachments.directory,
                                                            uploadId: image.id.uuidString, origin: origin)
        let attachment = try await client.upload(metadata, file: image.url)
        try validate(fence)
        return HostedAttachment(host: host, attachment: attachment)
    }
    private let operations: OperationOutbox

    /// Return the original intent with a conclusive or uncertain delivery state. No draft is cleared here.
    func deliver<Payload: Encodable & Sendable>(host: HostRef, kind: String, targetId: String?,
        payload: Payload, origin: HostRef) async throws -> (DurableOperation, OperationDelivery) {
        let client = try endpoint(host)
        let fence = try token(for: host)
        let operation = try await operations.reserve(kind: kind, targetId: targetId, payload: payload,
                                                     origin: origin, destination: host)
        pendingOperations[operation.operationId] = operation
        do {
            try validate(fence)
            // Receipt first. An unknown receipt may only be retried through this immutable endpoint.
            let known = try await client.operation(operation, lookup: true)
            try validate(fence)
            // Pending already has a durable owner. Never POST it again from the app.
            if case .receipt = known {
                recordDelivery(known, operation: operation)
                return (operation, known)
            }
            let delivery = try await submitOperation(operation, client: client)
            try validate(fence)
            recordDelivery(delivery, operation: operation)
            return (operation, delivery)
        } catch {
            // The request may have been accepted. Keep original intent, draft and attachments.
            recordDelivery(.unknown, operation: operation)
            return (operation, .unknown)
        }
    }

    /// Explicit user retry only. Original immutable intent and destination survive every lookup.
    func retryOperation(_ operation: DurableOperation) async throws {
        guard try await operations.contains(operation) else { throw HostRoutingError.invalidReference }
        let client = try endpoint(operation.destination), fence = try token(for: operation.destination)
        do {
            let known = try await client.operation(operation, lookup: true)
            try validate(fence)
            if case .receipt = known { recordDelivery(known, operation: operation); return }
            let result = try await submitOperation(operation, client: client)
            try validate(fence)
            recordDelivery(result, operation: operation)
        } catch { recordDelivery(.unknown, operation: operation); throw error }
    }

    func acknowledge(_ operation: DurableOperation, receipt: OperationReceipt) async throws {
        try await operations.acknowledge(operation, receipt: receipt)
        pendingOperations[operation.operationId] = nil
        operationDeliveries[operation.operationId] = nil
    }

    private func submitOperation(_ operation: DurableOperation, client: PilotClient) async throws -> OperationDelivery {
        guard operation.kind == "repair-create" else { return try await client.operation(operation, lookup: false) }
        let fence = try token(for: operation.destination)
        let capability = try await readNativeCapability(operation.destination, offlineHosts[operation.destination]?.configuration)
        try validate(fence)
        return try await client.operation(operation, lookup: false, nativeCapability: capability)
    }

    private func recordDelivery(_ delivery: OperationDelivery, operation: DurableOperation) {
        guard pendingOperations[operation.operationId] != nil else { return }
        // Concurrent lookup and delivery may finish out of order. Durable ownership/conclusive
        // receipts never regress to unknown because a stale lookup or socket failed later.
        if let known = operationDeliveries[operation.operationId], case let .receipt(existing) = known {
            if existing.state != .pending { return }
            if case .unknown = delivery { return }
        }
        operationDeliveries[operation.operationId] = delivery
        onOperationDeliveryChanged?(operation, delivery)
    }

    /// A user Check reads only this immutable intent. Keep one connection fence for the whole
    /// bounded check, including waits. Pending/unknown never authorize a POST or imply failure.
    func checkOperation(_ operation: DurableOperation, attempts: Int = 3,
                        delay: Duration = .milliseconds(500)) async throws -> OperationDelivery {
        guard (1...3).contains(attempts), try await operations.contains(operation) else {
            throw HostRoutingError.invalidReference
        }
        let client = try endpoint(operation.destination), fence = try token(for: operation.destination)
        for attempt in 0..<attempts {
            try Task.checkCancellation()
            try validate(fence)
            if case let .receipt(receipt)? = operationDeliveries[operation.operationId], receipt.state != .pending {
                return .receipt(receipt)
            }
            do {
                let delivery = try await client.operation(operation, lookup: true)
                try validate(fence)
                guard try await operations.contains(operation) else { throw HostRoutingError.invalidReference }
                try validate(fence)
                recordDelivery(delivery, operation: operation)
            } catch {
                recordDelivery(.unknown, operation: operation)
                throw error
            }
            if case let .receipt(receipt)? = operationDeliveries[operation.operationId], receipt.state != .pending {
                return .receipt(receipt)
            }
            if attempt + 1 < attempts { try await Task.sleep(for: delay) }
        }
        return operationDeliveries[operation.operationId] ?? .unknown
    }

    func createdSession(_ operation: DurableOperation) async throws {
        let host = operation.destination
        let client = try endpoint(host), fence = try token(for: host)
        let session = try await client.createdSession(operation.targetId)
        try validate(fence)
        guard session.id == operation.targetId, let entry = entries[host] else { throw HostRoutingError.invalidReference }
        // Publish synchronously before navigation, not on the next coalesced list refresh.
        refresh(host, token: entry.token)
    }

    /// Reconnect performs bounded receipt reads only. No timers, POST retry, adoption or draft clearing.
    func reconcileOperations(_ host: HostRef) async throws {
        let client = try endpoint(host)
        let fence = try token(for: host)
        for operation in try await operations.pending(destination: host) {
            try Task.checkCancellation()
            try validate(fence)
            guard try await operations.contains(operation) else { continue }
            pendingOperations[operation.operationId] = operation
            do {
                let delivery = try await client.operation(operation, lookup: true)
                try validate(fence)
                if try await operations.contains(operation) { recordDelivery(delivery, operation: operation) }
            } catch {
                recordDelivery(.unknown, operation: operation)
                try validate(fence)
            }
        }
    }

    /// No offline stop queue. An ambiguous response stays requested across relaunch; neither an
    /// idle snapshot nor loss of contact acknowledges cancellation, releases a grant or allows failover.
    func requestStop(_ ref: HostResourceRef) async throws -> String? {
        let client = try endpoint(ref, kind: .session)
        let fence = try token(for: ref.host)
        guard offlineHosts[ref.host] != nil else { throw HostRoutingError.invalidReference }
        offlineHosts[ref.host]?.stopRequests[ref.localId] = .requested
        try await flushOffline()
        try validate(fence)
        let draft = try await client.stop(ref.localId)
        try validate(fence)
        offlineHosts[ref.host]?.stopRequests[ref.localId] = .acknowledged
        try await flushOffline()
        return draft
    }

    func deliverAttached<Request: Codable & Sendable>(host: HostRef, kind: String, targetId: String?,
        request: Request, attachments: [HostedAttachment], origin: HostRef) async throws -> (DurableOperation, OperationDelivery) {
        guard attachments.count <= 8, attachments.allSatisfy({ $0.host == host }),
              kind == "chat-create-attached" || kind == "chat-send-attached" else {
            throw HostRoutingError.invalidReference
        }
        return try await deliver(host: host, kind: kind, targetId: targetId,
            payload: AttachmentChatPayload(request: request, attachments: attachments.map(\.attachment)), origin: origin)
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

    func importedProject(on host: HostRef, id: String) async throws -> Hosted<Project> {
        let client = try endpoint(host), fence = try token(for: host)
        let project = try await client.importedProject(id)
        try validate(fence)
        guard project.id == id, let entry = entries[host] else { throw HostRoutingError.invalidReference }
        refresh(host, token: entry.token)
        return Hosted(ref: HostResourceRef(host: host, kind: .project, localId: id), value: project)
    }

    func file(_ session: HostResourceRef, path: String) async throws -> SessionFileContent {
        try await perform(session, kind: .session) { client, id in try await client.file(id, path: path) }
    }

    func changes(_ session: HostResourceRef) async throws -> SessionChanges {
        try await perform(session, kind: .session) { client, id in try await client.changes(id) }
    }

    func install(_ client: PilotClient, host: HostRef) throws {
        guard !shuttingDown,
              !offlineHosts.keys.contains(where: { $0.hostId == host.hostId && $0 != host }) else {
            throw HostRoutingError.identityChanged
        }
        try client.bind(host)
        presentationClients[host] = client
        if host.hostId != "local" {
            client.onSessionsChanged = { [weak self] values, snapshot in self?.onRemoteSessionsChanged?(host, values, snapshot) }
        }
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
        entry.observations.append(Publishers.CombineLatest3(
            client.$hasProjectSnapshot, client.$hasSessionSnapshot, client.$hasMissionSnapshot
        ).sink { [weak self] _ in self?.enqueueRefresh(host) })
        entries[host] = entry
        client.onDiagnosticRead = { [weak self, weak client] dispatch in
            guard let self, let client, self.entries[host]?.token == token,
                  self.entries[host]?.client === client, client.connected, !self.shuttingDown else { return }
            self.routeDiagnosticRead(dispatch, source: host, token: token)
        }
        client.onSharedContextsChanged = { [weak self, weak client] in
            guard let self, let client, self.entries[host]?.token == token, client.connected,
                  self.entries[host]?.client === client, !self.shuttingDown else { return }
            self.reconcileSharedContexts()
        }
        for registration in terminalRegistrations.values where registration.ref.host == host {
            attachTerminalRegistration(registration)
        }
        for subscription in subscriptions.values where subscription.ref.host == host { attach(subscription) }
        for (ref, count) in retained where ref.host == host {
            for _ in 0..<count { retainOnEndpoint(ref, client: client) }
        }
        refresh(host, token: token)
        refreshDetails(host, token: token)
    }

    /// Enrollment pins an explicitly confirmed identity. No first-response TOFU during reconnect.
    func connect(host: HostRef, configuration: SSHConnectionConfiguration) async throws {
        try Task.checkCancellation()
        guard !shuttingDown, offlineReady, !enrollingHosts.contains(host), host.hostId != "local",
              offlineHosts[host]?.configuration == configuration,
              !offlineHosts.keys.contains(where: { $0.hostId == host.hostId && $0 != host }) else {
            throw HostRoutingError.invalidReference
        }
        if let job = connectionJobs[host], job.configuration == configuration {
            try await job.task.value
            return
        }
        if tunnelConfigurations[host] == configuration, tunnels[host] != nil {
            switch connectionStates[host] {
            case .connected, .connecting: return // Includes a verified forward whose client is still opening.
            default: break
            }
        }
        let attempt = UUID()
        connectionAttempts[host] = attempt
        connectionJobs[host]?.task.cancel()
        let task = Task { [weak self] in
            guard let self else { throw HostRoutingError.disconnected }
            try Task.checkCancellation()
            try self.validateConnection(host, configuration: configuration, attempt: attempt)
            try await self.connectionAdmission.acquire()
            defer { self.connectionAdmission.release() }
            try Task.checkCancellation()
            try self.validateConnection(host, configuration: configuration, attempt: attempt)
            await self.closeConnection(host)
            try Task.checkCancellation()
            try self.validateConnection(host, configuration: configuration, attempt: attempt)
            let tunnel = self.makeTunnel(configuration, host)
            try await self.attachTunnel(tunnel, host: host, configuration: configuration, attempt: attempt)
        }
        connectionJobs[host] = ConnectionJob(id: attempt, configuration: configuration, task: task)
        defer { if connectionJobs[host]?.id == attempt { connectionJobs[host] = nil } }
        try await task.value
    }

    private func validateConnection(_ host: HostRef, configuration: SSHConnectionConfiguration, attempt: UUID) throws {
        guard !shuttingDown, !enrollingHosts.contains(host), connectionAttempts[host] == attempt,
              offlineHosts[host]?.configuration == configuration else { throw HostRoutingError.staleGeneration }
    }

    /// Adopt only after enrollment was explicitly confirmed and durably persisted. Bootstrap has
    /// already validated this owned forward. Keep its state stream, never just its first URL.
    func adopt(_ connection: LinuxBootstrapConnection, configuration: SSHConnectionConfiguration) async throws {
        guard offlineReady, offlineHosts[connection.host]?.configuration == configuration, !shuttingDown else {
            throw HostRoutingError.invalidReference
        }
        let attempt = UUID()
        savedStartup.suppress(connection.host)
        connectionJobs.removeValue(forKey: connection.host)?.task.cancel()
        connectionAttempts[connection.host] = attempt
        await closeConnection(connection.host)
        try Task.checkCancellation()
        try validateConnection(connection.host, configuration: configuration, attempt: attempt)
        try await attachTunnel(connection.tunnel, host: connection.host, configuration: configuration, attempt: attempt)
    }

    private func attachTunnel(_ tunnel: any HostTunnel, host: HostRef,
                              configuration: SSHConnectionConfiguration, attempt: UUID) async throws {
        try validateConnection(host, configuration: configuration, attempt: attempt)
        tunnels[host] = tunnel
        tunnelConfigurations[host] = configuration
        let states = await tunnel.states()
        guard !Task.isCancelled, !shuttingDown, connectionAttempts[host] == attempt,
              offlineHosts[host]?.configuration == configuration, tunnels[host] === tunnel else {
            await tunnel.disconnect()
            throw HostRoutingError.staleGeneration
        }
        tunnelWatches[host] = Task { [weak self] in
            for await state in states {
                guard !Task.isCancelled, let self, self.tunnels[host] === tunnel,
                      (try? self.validateConnection(host, configuration: configuration, attempt: attempt)) != nil else { break }
                self.connectionStates[host] = state
                switch state {
                case let .connected(url):
                    do { try self.installTunnelEndpoint(host, url: url, configuration: configuration, attempt: attempt) }
                    catch { self.removeConnection(host) }
                default:
                    self.tunnelURLs[host] = nil
                    self.removeConnection(host)
                }
            }
        }
        do {
            let url = try await tunnel.connect()
            try Task.checkCancellation()
            try validateConnection(host, configuration: configuration, attempt: attempt)
            guard tunnels[host] === tunnel else { throw HostRoutingError.staleGeneration }
            try installTunnelEndpoint(host, url: url, configuration: configuration, attempt: attempt)
        } catch {
            if tunnels[host] === tunnel, connectionAttempts[host] == attempt {
                connectionAttempts[host] = nil
                await closeConnection(host)
                if let failure = error as? SSHTunnelError { connectionStates[host] = .failed(failure) }
            }
            throw error
        }
    }

    private func installTunnelEndpoint(_ host: HostRef, url: URL,
                                       configuration: SSHConnectionConfiguration, attempt: UUID) throws {
        try validateConnection(host, configuration: configuration, attempt: attempt)
        if tunnelURLs[host] == url, entries[host] != nil { return }
        let client = makeClient()
        try install(client, host: host)
        tunnelURLs[host] = url
        connectClient(client, url)
    }

    func disconnect(_ host: HostRef) async {
        savedStartup.suppress(host)
        connectionAttempts[host] = nil
        connectionJobs.removeValue(forKey: host)?.task.cancel()
        await closeConnection(host)
    }

    private func closeConnection(_ host: HostRef) async {
        tunnelWatches.removeValue(forKey: host)?.cancel()
        tunnelURLs[host] = nil
        tunnelConfigurations[host] = nil
        let tunnel = tunnels.removeValue(forKey: host)
        removeConnection(host)
        connectionStates[host] = .disconnected
        let previous = connectionCleanup[host]?.1
        guard let tunnel else {
            await previous?.value
            return
        }
        let id = UUID()
        let cleanup = Task {
            await previous?.value
            await tunnel.disconnect()
        }
        connectionCleanup[host] = (id, cleanup)
        await cleanup.value
        if connectionCleanup[host]?.0 == id { connectionCleanup[host] = nil }
    }

    /// Quit closes only owned local forwards, never remote agents or daemon services.
    func disconnectAll() async {
        // Fence startup/reconnect completions before the first suspension. Keep Local installed;
        // no daemon stop, power command, remote service management or agent mutation is reachable.
        shuttingDown = true
        savedStartup.stop()
        remoteRuntimes.stop()
        scopedModels.stop()
        devboxUpdates.stop()
        for job in connectionJobs.values { job.task.cancel() }
        connectionJobs.removeAll()
        sharedContextCourier.stop()
        sharedContextGenerations.removeAll()
        connectionAttempts.removeAll()
        for host in tunnels.keys {
            if let entry = entries[host] { refresh(host, token: entry.token) }
        }
        for host in Set(tunnels.keys).union(connectionCleanup.keys) { await disconnect(host) }
        await scopedModels.stopAndWait()
        await devboxUpdates.stopAndWait()
        await projectCheckouts.stop()
        do { try await flushOffline() }
        catch { persistenceError = "Could not save offline host metadata before quitting." }
    }

    /// Removal keeps last-known summaries. It does not invent an execution outcome.
    private func removeConnection(_ host: HostRef) {
        defer { refreshProjectCheckouts() }
        for registration in terminalRegistrations.values where registration.ref.host == host {
            registration.detach(); registration.attachment.onStatus(.disconnected)
        }
        reconciliationTasks.removeValue(forKey: host)?.cancel()
        reconciliationGenerations[host] = nil
        for subscription in subscriptions.values where subscription.ref.host == host { subscription.detach() }
        let removed = entries.removeValue(forKey: host)
        removed?.client.onDiagnosticRead = nil
        for key in diagnosticReads.keys.filter({ $0.hasPrefix(hostKey(host) + ":") }) {
            diagnosticReads.removeValue(forKey: key)?.cancel()
        }
        removed?.client.onSharedContextsChanged = nil
        removed?.client.disconnect()
        if let removed { presentationClients[host] = removed.client }
        sharedContextGenerations[host] = nil
        refreshSharedContextEndpoints()
        available.remove(host)
        refreshRuntimeEndpoints()
        refreshScopedModelEndpoints()
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

    // Shared pages always retain the chosen host and enrollment. They never read an
    // execution project's unrelated local memory or switch to another reachable daemon.
    func sharedContexts(on host: HostRef) async throws -> [SharedContextSummary] {
        let client = try endpoint(host), fence = try token(for: host)
        let result = try await client.sharedContexts()
        try validate(fence)
        guard result.allSatisfy({ $0.binding.peers.contains(OperationHost(host)) }) else {
            throw HostRoutingError.identityChanged
        }
        return result
    }

    func sharedMission(_ binding: SharedContextBinding, on host: HostRef, missionId: String) async throws -> SharedMissionRead {
        try await withSharedBinding(binding, on: host) { try await $0.sharedMission(binding, missionId: missionId) }
    }

    func sharedMissionVersions(_ binding: SharedContextBinding, on host: HostRef, missionId: String,
                               after: Int = 0, limit: Int = 128, sequence: Int? = nil) async throws -> SharedMissionVersions {
        try await withSharedBinding(binding, on: host) {
            try await $0.sharedMissionVersions(binding, missionId: missionId, after: after, limit: limit, sequence: sequence)
        }
    }

    func sharedMissionConflicts(_ binding: SharedContextBinding, on host: HostRef) async throws -> [SharedMissionProposal] {
        try await withSharedBinding(binding, on: host) { try await $0.sharedMissionConflicts(binding) }
    }

    func sharedMemoryWake(_ binding: SharedContextBinding, on host: HostRef, lines: Int = 96) async throws -> SharedMemoryRead {
        try await withSharedBinding(binding, on: host) { try await $0.sharedMemoryWake(binding, lines: lines) }
    }

    func sharedMemoryRecall(_ binding: SharedContextBinding, on host: HostRef,
                            regex: String, lines: Int = 96) async throws -> SharedMemoryRead {
        try await withSharedBinding(binding, on: host) { try await $0.sharedMemoryRecall(binding, regex: regex, lines: lines) }
    }

    func sharedMemoryZoom(_ binding: SharedContextBinding, on host: HostRef, range: MemoryRange) async throws -> SharedMemoryRead {
        try await withSharedBinding(binding, on: host) { try await $0.sharedMemoryZoom(binding, range: range) }
    }

    func sharedMemoryTree(_ binding: SharedContextBinding, on host: HostRef, range: MemoryRange? = nil,
                          depth: Int = 2, reveal: [Int] = []) async throws -> SharedMemoryTreeRead {
        try await withSharedBinding(binding, on: host) {
            try await $0.sharedMemoryTree(binding, range: range, depth: depth, reveal: reveal)
        }
    }

    private func withSharedBinding<Value>(_ binding: SharedContextBinding, on host: HostRef,
                                          _ operation: (PilotClient) async throws -> Value) async throws -> Value {
        guard binding.peers.contains(OperationHost(host)) else { throw HostRoutingError.identityChanged }
        let client = try endpoint(host), fence = try token(for: host)
        let result = try await operation(client)
        try validate(fence)
        return result
    }

    /// Setup belongs to a verified host, not a project/chat or the global Local client.
    func runtimeUpdate(_ id: String? = nil, on host: HostRef) async throws -> RuntimeUpdateStatus? {
        let client = try endpoint(host), token = try token(for: host)
        let value = try await client.runtimeUpdate(id)
        try validate(token)
        return value
    }

    func cancelRuntimeUpdate(_ id: String, on host: HostRef) async throws -> RuntimeUpdateCancellation {
        let client = try endpoint(host), token = try token(for: host)
        let value = try await client.cancelRuntimeUpdate(id)
        try validate(token)
        return value
    }

    func setupReadiness(on host: HostRef) async throws -> SetupReadiness {
        let client = try endpoint(host), token = try token(for: host)
        let value = try await client.setupReadiness()
        try validate(token)
        return value
    }

    private func routeDiagnosticRead(_ dispatch: DiagnosticReadDispatch, source: HostRef, token: HostConnectionToken) {
        let key = hostKey(source) + ":" + dispatch.id
        guard diagnosticReads[key] == nil, diagnosticReads.count < 8,
              UUID(uuidString: dispatch.id) != nil else { return }
        diagnosticReads[key] = Task { [weak self] in
            guard let self else { return }
            defer { diagnosticReads[key] = nil }
            let result: JSONValue
            do {
                if dispatch.request.action == "hosts" {
                    let known = Set(offlineHosts.keys).union(entries.keys)
                    let rows = try known.sorted { self.hostKey($0) < self.hostKey($1) }.prefix(32).map { host in
                        let value = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(host))
                        return JSONValue.object(["host": value,
                            "availability": .string(self.available.contains(host) ? "available" : "offline"),
                            "freshness": .string(self.available.contains(host) ? "verified_connection" : "cached_identity")])
                    }
                    result = .object(["hosts": .array(rows), "truncated": .bool(known.count > rows.count),
                                      "coverage": .string("user_trusted_linked_hosts_only")])
                } else {
                    guard let destination = dispatch.request.host,
                          entries[destination] != nil || offlineHosts[destination] != nil else {
                        throw HostRoutingError.invalidReference
                    }
                    guard entries[destination] != nil, available.contains(destination) else {
                        throw HostRoutingError.disconnected
                    }
                    let response: DiagnosticContextResponse = try await githubRequest(on: destination,
                        path: "api/diagnostics/read", body: dispatch.request)
                    guard response.schemaVersion == 1, response.host == destination else {
                        throw HostRoutingError.identityChanged
                    }
                    result = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(response))
                }
            } catch {
                let reason: String
                if let routing = error as? HostRoutingError, case .disconnected = routing { reason = "offline" }
                else { reason = "read_failed" }
                result = .object(["status": .string("unavailable"), "reason": .string(reason)])
            }
            guard !Task.isCancelled, !shuttingDown, entries[source]?.token == token,
                  entries[source]?.client.connected == true else { return }
            struct Reply: Encodable { let id: String; let result: JSONValue }
            struct Accepted: Decodable { let accepted: Bool }
            let _: Accepted? = try? await githubRequest(on: source, path: "api/diagnostics/read-response",
                body: Reply(id: dispatch.id, result: result))
        }
    }

    private func hostKey(_ host: HostRef) -> String {
        HostResourceRef(host: host, kind: .session, localId: "diagnostic-read").storageKey
    }

    /// Capability acquisition and the response are both fenced to this installation and connection.
    func githubRequest<Body: Encodable, Response: Decodable>(on host: HostRef, path: String = "api/setup/github",
                                                            body: Body?, method: String = "POST") async throws -> Response {
        let client = try endpoint(host), fence = try token(for: host)
        let configuration = offlineHosts[host]?.configuration
        guard configuration != nil || host.hostId == "local" else { throw HostRoutingError.invalidReference }
        let capability = try await readNativeCapability(host, configuration)
        try validate(fence)
        let value: Response = try await client.githubRequest(path, capability: capability, body: body, method: method)
        try validate(fence)
        return value
    }

    func setupRuns(on host: HostRef) async throws -> [HostedSetupRun] {
        let client = try endpoint(host), token = try token(for: host)
        let values = try await client.setupRuns()
        try validate(token)
        return values.map { HostedSetupRun(host: host, run: $0) }
    }

    func startSetup(on host: HostRef, request: SetupStartRequest) async throws -> HostedSetupRun {
        let client = try endpoint(host), token = try token(for: host)
        let run = try await client.startSetup(request)
        try validate(token)
        return HostedSetupRun(host: host, run: run)
    }

    func cancelSetup(_ value: HostedSetupRun) async throws -> HostedSetupRun {
        let client = try endpoint(value.host), token = try token(for: value.host)
        let run = try await client.cancelSetup(value.run.id)
        try validate(token)
        return HostedSetupRun(host: value.host, run: run)
    }

    func logoutSetupProvider(_ provider: String, on host: HostRef) async throws -> SetupCredentialStatus {
        let client = try endpoint(host), token = try token(for: host)
        let value = try await client.logoutSetupProvider(provider)
        try validate(token)
        return value
    }

    func attachSetup(_ value: HostedSetupRun, receive: @escaping (SetupServerMessage) -> Void) throws -> SetupTerminalConnection {
        let client = try endpoint(value.host), token = try token(for: value.host)
        return try client.attachSetup(value.run.id) { [weak self] message in
            guard let self else { return }
            do { try self.validate(token) } catch { return }
            receive(message)
        }
    }

    func detachSetup(_ value: HostedSetupRun) { entries[value.host]?.client.detachSetup(value.run.id) }

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

    /// Remote sends must expose their durable delivery state to the owning composer, not an
    /// unreceipted success/failure that could clear a draft after an ambiguous network response.
    func send(_ session: HostResourceRef, message: String, mode: DeliveryMode,
              origin: HostRef) async throws -> (DurableOperation, OperationDelivery) {
        guard session.kind == .session else { throw HostRoutingError.invalidReference }
        return try await deliver(host: session.host, kind: "chat-send", targetId: session.localId,
                                 payload: SendRequest(message: message, mode: mode), origin: origin)
    }

    func subscribe(_ session: HostResourceRef, trace: PilotTraceCarrier? = nil,
                   listener: @escaping ([JSONValue]) -> Void) throws -> () -> Void {
        guard session.kind == .session, subscriptions.count < 256 else { throw HostRoutingError.invalidReference }
        let id = UUID()
        let subscription = Subscription(ref: session, trace: trace, listener: listener)
        subscriptions[id] = subscription
        attach(subscription)
        return { [weak self] in self?.subscriptions.removeValue(forKey: id)?.detach() }
    }

    private func attach(_ subscription: Subscription) {
        subscription.detach()
        guard let entry = entries[subscription.ref.host] else { return }
        let endpointToken = entry.token
        subscription.client = entry.client
        let trace = subscription.trace
        subscription.trace = nil
        subscription.token = entry.client.subscribe(
            subscription.ref.localId, trace: trace
        ) { [weak self, weak subscription] events in
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
        defer { refreshProjectCheckouts() }
        guard let entry = entries[host], entry.token == token else { return }
        let sharedGeneration = entry.client.connected ? entry.client.connectionGeneration : nil
        if sharedContextGenerations[host] != sharedGeneration {
            sharedContextGenerations[host] = sharedGeneration
            refreshSharedContextEndpoints()
            refreshRuntimeEndpoints()
            refreshScopedModelEndpoints()
        }
        if entry.client.connected {
            available.insert(host)
            let generation = entry.client.connectionGeneration
            if offlineReady, !shuttingDown, reconciliationGenerations[host] != generation {
                reconciliationTasks[host]?.cancel()
                reconciliationGenerations[host] = generation
                reconciliationTasks[host] = Task { [weak self] in try? await self?.reconcileOperations(host) }
            }
        } else {
            available.remove(host)
            if entry.client.connectionError != nil { connectionStates[host] = .failed(.rejectedHello) }
            reconciliationTasks.removeValue(forKey: host)?.cancel()
            reconciliationGenerations[host] = nil
        }
        // A temporary empty endpoint before its first authoritative list must not erase offline data.
        guard entry.client.connected, entry.client.hasProjectSnapshot, entry.client.hasSessionSnapshot,
              entry.client.hasMissionSnapshot else { return }
        replaceSummaries(host, sessions: entry.client.sessions, projects: entry.client.projects,
                         missions: entry.client.missions)
        if let previous = offlineHosts[host] {
            offlineHosts[host] = OfflineHostSnapshot(host: host, configuration: previous.configuration,
                receivedAt: Date(), sessions: entry.client.sessions, projects: entry.client.projects,
                missions: entry.client.missions, stopRequests: previous.stopRequests)
            scheduleSave()
        }
    }

    private func replaceSummaries(_ host: HostRef, sessions values: [SessionSummary], projects projectValues: [Project],
                                  missions missionValues: [Mission]) {
        sessions = sessions.filter { $0.ref.host != host } + values.map {
            Hosted(ref: HostResourceRef(host: host, kind: .session, localId: $0.id), value: $0)
        }
        projects = projects.filter { $0.ref.host != host } + projectValues.map {
            Hosted(ref: HostResourceRef(host: host, kind: .project, localId: $0.id), value: $0)
        }
        missions = missions.filter { $0.ref.host != host } + missionValues.map {
            Hosted(ref: HostResourceRef(host: host, kind: .mission, localId: $0.id), value: $0)
        }
        refreshProjectCheckouts()
    }
}

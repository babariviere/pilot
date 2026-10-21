import Combine
import Foundation
import PilotCore
import PilotTelemetry

enum HostedHistoryAvailability: Equatable {
    case online, cached, requiresReconnect
    var explanation: String? {
        self == .requiresReconnect ? "This history is not cached on this Mac. Remote devboxes are retired; the original data remains on its host." : nil
    }
}

/// One live Local client plus read-only legacy history. Qualified refs fence cached remote data
/// from Local mutations; there is no remote endpoint registry or connection selection.
@MainActor
final class ClientDirectory: ObservableObject {
    private var checkoutObservation: AnyCancellable?
    private let checkoutDirectory: URL
    private(set) lazy var projectCheckouts: LegacyCheckoutCatalog = {
        let file = checkoutDirectory.appendingPathComponent("project-checkouts.json")
        let model = LegacyCheckoutCatalog(store: RepositoryAssociationStore(file: file))
        checkoutObservation = model.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        return model
    }()

    private func refreshProjectCheckouts() {
        projectCheckouts.update(projects)
    }
    var onOperationDeliveryChanged: ((DurableOperation, OperationDelivery) -> Void)?
    @Published private(set) var sessions: [Hosted<SessionSummary>] = []
    @Published private(set) var projects: [Hosted<Project>] = []
    @Published private(set) var missions: [Hosted<Mission>] = []
    @Published private(set) var available: Set<HostRef> = []
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
        if let client = entry(host)?.client { return client }
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
    private var local: Entry?
    private func entry(_ host: HostRef) -> Entry? { local?.token.host == host ? local : nil }
    private var diagnosticReads: [String: Task<Void, Never>] = [:]
    private let readNativeCapability: @MainActor (HostRef) async throws -> String
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
        guard entry(ref.host) != nil else { throw HostRoutingError.disconnected }
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
        guard let entry = entry(ref.host) else { registration.attachment.onStatus(.disconnected); return }
        registration.client = entry.client
        let token = entry.token
        var attachment = registration.attachment
        attachment.onData = { [weak self, weak registration] data in
            guard let self, let registration, self.entry(ref.host)?.token == token,
                  self.terminalRegistrations[ref] === registration else { return }
            registration.attachment.onData(data)
        }
        attachment.onExit = { [weak self, weak registration] code in
            guard let self, let registration, self.entry(ref.host)?.token == token,
                  self.terminalRegistrations[ref] === registration else { return }
            registration.attachment.onExit(code)
        }
        attachment.onReplay = { [weak self, weak registration] in
            guard let self, let registration, self.entry(ref.host)?.token == token,
                  self.terminalRegistrations[ref] === registration else { return }
            registration.attachment.onReplay()
        }
        attachment.onStatus = { [weak self, weak registration] status in
            guard let self, let registration, self.entry(ref.host)?.token == token,
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
    /// One owner for live lifecycle fan-out and Settings. Construction performs no I/O.
    let scopedModels: LocalModelScope
    private var endpointGeneration: UUID?
    private let readScopedModelCapability: @MainActor (HostRef) async throws -> String
    private var scopedModelsStarted = false
    private var offlineRestoreStarted = false
    private var offlineReady = false
    private var reconciliationTask: Task<Void, Never>?
    private var reconciliationGeneration: UUID?
    private var shuttingDown = false

    init(operationDirectory: URL? = nil,
         scopedModelsStore: ScopedModelsStore? = nil,
         readScopedModelCapability: @escaping @MainActor (HostRef) async throws -> String = {
             try await GitHubNativeAccess.read(host: $0)
         },
         readNativeCapability: @escaping @MainActor (HostRef) async throws -> String = {
             try await GitHubNativeAccess.read(host: $0)
         }) {
        self.readScopedModelCapability = readScopedModelCapability
        self.readNativeCapability = readNativeCapability
        scopedModels = LocalModelScope(store: scopedModelsStore ?? ScopedModelsStore(directory:
            operationDirectory?.appendingPathComponent("scoped-models", isDirectory: true) ??
                FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("Pilot/ScopedModels", isDirectory: true)))
        // The outbox decodes every top-level JSON file as an operation. Keep checkout metadata separate.
        checkoutDirectory = operationDirectory?.appendingPathComponent("project-checkouts", isDirectory: true) ?? FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Pilot")
        operations = OperationOutbox(directory: operationDirectory ?? FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Pilot/Operations"))
    }

    /// Startup reads local metadata only. No SSH, mutation replay, outcome notifications or failover.
    func restoreLegacySnapshot(_ snapshot: OfflineHostSnapshot) {
        guard snapshot.host != localHost, offlineHosts[snapshot.host] != nil || offlineHosts.count < 32 else { return }
        offlineHosts[snapshot.host] = snapshot
        if let presentation = presentationClients[snapshot.host] { presentation.restoreOfflinePresentation(snapshot); presentation.disconnect() }
        replaceSummaries(snapshot.host, sessions: snapshot.sessions, projects: snapshot.projects, missions: snapshot.missions)
    }

    func restoreOffline(from store: OfflineHostStore) async throws {
        guard !offlineRestoreStarted else { return }
        offlineRestoreStarted = true
        do {
            let snapshots = try await store.load()
            for snapshot in snapshots where entry(snapshot.host) == nil {
                restoreLegacySnapshot(snapshot)
            }
            for operation in try await operations.pending() {
                pendingOperations[operation.operationId] = operation
                operationDeliveries[operation.operationId] = .unknown
            }
            offlineReady = true
        } catch { persistenceError = "Could not read saved host metadata. The original data was kept."; throw error }
    }

    /// Explicit live admission only. restoreOffline, init and Settings rendering remain inert.
    func startScopedModels() {
        guard !shuttingDown else { return }
        scopedModelsStarted = true
        refreshScopedModelEndpoints()
    }

    private func refreshScopedModelEndpoints() {
        guard scopedModelsStarted, !shuttingDown else { return }
        guard let entry = local, entry.client.connected else { scopedModels.update(nil); return }
        let host = entry.token.host
        scopedModels.update({
            let client = entry.client
            let token = HostConnectionToken(host: host, generation: client.connectionGeneration)
            return ScopedModelsTransport(client: client, token: token, validate: { [weak self, weak client] in
                guard let self, let client, !self.shuttingDown, self.entry(host)?.client === client,
                      client.hostIdentity == host else { throw HostRoutingError.staleGeneration }
                try self.validate(token)
            }, capability: { [weak self] in
                guard let self else { throw HostRoutingError.disconnected }
                try self.validate(token)
                let value = try await self.readScopedModelCapability(host)
                try self.validate(token)
                return value
            }).endpoint()
        }())
    }

    func historyAvailability(_ ref: HostResourceRef, cached: Bool) -> HostedHistoryAvailability {
        available.contains(ref.host) ? .online : cached ? .cached : .requiresReconnect
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
            guard !self.shuttingDown, let entry = self.entry(host) else { return }
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
        let capability = try await readNativeCapability(operation.destination)
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
        guard session.id == operation.targetId, let entry = entry(host) else { throw HostRoutingError.invalidReference }
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
        guard project.id == id, let entry = entry(host) else { throw HostRoutingError.invalidReference }
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
        guard host.hostId == "local", !shuttingDown,
              local == nil || local?.token.host == host else {
            throw HostRoutingError.identityChanged
        }
        try client.bind(host)
        presentationClients[host] = client
        if entry(host)?.client === client { return }
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
        local = entry
        client.onDiagnosticRead = { [weak self, weak client] dispatch in
            guard let self, let client, self.entry(host)?.token == token,
                  self.entry(host)?.client === client, client.connected, !self.shuttingDown else { return }
            self.routeDiagnosticRead(dispatch, source: host, token: token)
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

    /// Close local subscriptions without contacting or modifying any former devbox.
    func disconnect(_ host: HostRef) async { removeConnection(host) }

    func disconnectAll() async {
        shuttingDown = true
        scopedModels.stop()
        reconciliationTask?.cancel()
        for task in diagnosticReads.values { task.cancel() }
        await reconciliationTask?.value
        for task in diagnosticReads.values { await task.value }
        await scopedModels.stopAndWait()
    }

    /// Removal keeps last-known summaries. It does not invent an execution outcome.
    private func removeConnection(_ host: HostRef) {
        defer { refreshProjectCheckouts() }
        for registration in terminalRegistrations.values where registration.ref.host == host {
            registration.detach(); registration.attachment.onStatus(.disconnected)
        }
        reconciliationTask?.cancel(); reconciliationTask = nil
        reconciliationGeneration = nil
        for subscription in subscriptions.values where subscription.ref.host == host { subscription.detach() }
        let removed = entry(host)
        if removed != nil { local = nil }
        removed?.client.onDiagnosticRead = nil
        for key in diagnosticReads.keys.filter({ $0.hasPrefix(hostKey(host) + ":") }) {
            diagnosticReads.removeValue(forKey: key)?.cancel()
        }
        removed?.client.disconnect()
        if let removed { presentationClients[host] = removed.client }
        endpointGeneration = nil
        available.remove(host)
        refreshScopedModelEndpoints()
    }

    func endpoint(_ ref: HostResourceRef, kind: HostResourceKind) throws -> PilotClient {
        guard ref.kind == kind else { throw HostRoutingError.invalidReference }
        return try endpoint(ref.host)
    }

    func endpoint(_ host: HostRef) throws -> PilotClient {
        guard let entry = entry(host), entry.client.connected else { throw HostRoutingError.disconnected }
        return entry.client
    }

    func token(for host: HostRef) throws -> HostConnectionToken {
        let client = try endpoint(host)
        return HostConnectionToken(host: host, generation: client.connectionGeneration)
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
                    let known = Set(offlineHosts.keys).union(local.map { [$0.token.host] } ?? [])
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
                          entry(destination) != nil || offlineHosts[destination] != nil else {
                        throw HostRoutingError.invalidReference
                    }
                    guard entry(destination) != nil, available.contains(destination) else {
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
            guard !Task.isCancelled, !shuttingDown, entry(source)?.token == token,
                  entry(source)?.client.connected == true else { return }
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
        let capability = try await readNativeCapability(host)
        try validate(fence)
        let value: Response = try await client.githubRequest(path, capability: capability, body: body, method: method)
        try validate(fence)
        return value
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
        guard entry(session.host) != nil else { throw HostRoutingError.disconnected }
        guard session.kind == .session, subscriptions.count < 256 else { throw HostRoutingError.invalidReference }
        let id = UUID()
        let subscription = Subscription(ref: session, trace: trace, listener: listener)
        subscriptions[id] = subscription
        attach(subscription)
        return { [weak self] in self?.subscriptions.removeValue(forKey: id)?.detach() }
    }

    private func attach(_ subscription: Subscription) {
        subscription.detach()
        guard let entry = entry(subscription.ref.host) else { return }
        let endpointToken = entry.token
        subscription.client = entry.client
        let trace = subscription.trace
        subscription.trace = nil
        subscription.token = entry.client.subscribe(
            subscription.ref.localId, trace: trace
        ) { [weak self, weak subscription] events in
            guard let self, let subscription, self.entry(subscription.ref.host)?.token == endpointToken else { return }
            subscription.listener(events)
        }
    }

    func retain(_ ref: HostResourceRef) throws -> () -> Void {
        guard ref.kind == .project || ref.kind == .mission, retained.count < 32 || retained[ref] != nil,
              retained[ref, default: 0] < 64 else {
            throw HostRoutingError.invalidReference
        }
        retained[ref, default: 0] += 1
        if let client = entry(ref.host)?.client { retainOnEndpoint(ref, client: client) }
        var released = false
        return { [weak self] in
            guard !released, let self, let count = self.retained[ref] else { return }
            released = true
            if count == 1 { self.retained[ref] = nil } else { self.retained[ref] = count - 1 }
            if let client = self.entry(ref.host)?.client {
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
        guard let entry = entry(host), entry.token == token else { return }
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
        guard let entry = entry(host), entry.token == token else { return }
        let sharedGeneration = entry.client.connected ? entry.client.connectionGeneration : nil
        if endpointGeneration != sharedGeneration {
            endpointGeneration = sharedGeneration
            refreshScopedModelEndpoints()
        }
        if entry.client.connected {
            available.insert(host)
            let generation = entry.client.connectionGeneration
            if offlineReady, !shuttingDown, reconciliationGeneration != generation {
                reconciliationTask?.cancel()
                reconciliationGeneration = generation
                reconciliationTask = Task { [weak self] in try? await self?.reconcileOperations(host) }
            }
        } else {
            available.remove(host)
            reconciliationTask?.cancel(); reconciliationTask = nil
            reconciliationGeneration = nil
        }
        // A temporary empty endpoint before its first authoritative list must not erase offline data.
        guard entry.client.connected, entry.client.hasProjectSnapshot, entry.client.hasSessionSnapshot,
              entry.client.hasMissionSnapshot else { return }
        replaceSummaries(host, sessions: entry.client.sessions, projects: entry.client.projects,
                         missions: entry.client.missions)

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

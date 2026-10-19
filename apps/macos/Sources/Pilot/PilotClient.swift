import AppKit
import Foundation
import PilotCore
import PilotTelemetry

/// pilotd client: REST commands, one reconnecting control WebSocket for lists, dashboards and missions, and one
/// reconnecting WebSocket per open chat, terminal and subagent transcript.
@MainActor
final class PilotClient: ObservableObject {
    @Published private(set) var sessions: [SessionSummary] = []
    @Published private(set) var projects: [Project] = []
    @Published private(set) var powerStatus: PowerStatus?
    @Published private(set) var schedules: [ScheduledItem] = []
    @Published private(set) var trackingSources: [TrackingSource] = []
    /// Browser sign-ins per tracking server. A separate object, so only sign-in controls observe it.
    let sourceSignIns = SourceSignInStore()
    /// pi MCP server status from pilotd. A separate object, so only connection views observe it.
    let mcp = McpStatusStore()
    /// Invalidation only, per project. Inbox views refresh a bounded page; project pages already get
    /// dashboard updates. Observers register with observeTrackedItems.
    private var trackedObservers: [UUID: (String) -> Void] = [:]
    /// Control-chat details invalidations (watches or audit). Installed only while those details are shown.
    private var controlObservers: [UUID: (ControlDetailsChange) -> Void] = [:]
    /// Snapshot fixtures for tracked items and the settings pickers. Never set in the live app.
    var fixtureTracking: TrackingFixture?
    @Published private(set) var hasProjectSnapshot = false
    @Published private(set) var hasSessionSnapshot = false
    @Published private(set) var hasMissionSnapshot = false
    @Published private(set) var artifacts: [String: [ArtifactSummary]] = [:]
    private var artifactVersions: [String: Int] = [:]
    /// Every mission, including done and archived ones.
    @Published private(set) var missions: [Mission] = []
    /// Details of subscribed missions only.
    @Published private(set) var missionDetails: [String: MissionDetail] = [:]
    /// Subscription reference counts for views displaying mission detail.
    private var missionRefs: [String: Int] = [:]
    /// Dashboards of subscribed projects only. Updates arrive over the socket, never by polling.
    @Published private(set) var projectDashboards: [String: ProjectDashboard] = [:]
    /// Working and needs-you counts per project, for the sidebar scope switcher.
    @Published private(set) var projectCounts = ProjectDashboardCounts()
    /// When each subscribed dashboard last arrived, to say how old shown data is after a failed refresh.
    @Published private(set) var dashboardReceivedAt: [String: Date] = [:]
    /// The last failed explicit refresh per subscribed project. Cleared by the next dashboard.
    @Published private(set) var dashboardErrors: [String: String] = [:]
    private var dashboardRefs: [String: Int] = [:]
    private var fixtureDashboards = false
    private var fixtureMissions = false
    private var fixtureSessions = false
    /// Native tests bypass durable HTTP admission while retaining the same AppModel validation.
    var usesSessionFixtures: Bool { fixtureSessions }
    private(set) var fixtureSpawnRequests: [SpawnRequest] = []
    private(set) var fixtureSendRequests: [(sessionId: String, message: String, mode: DeliveryMode)] = []
    var fixtureDiagnostics: [String: SessionDiagnostics] = [:]
    var fixtureRepairProject: DiagnosticRepairProjectStatus?
    var fixtureProjectOrigins: [String: ProjectOrigin] = [:]
    var fixtureAppDiagnosticEvidence: AppDiagnosticEvidence?
    /// Static previews/test snapshots do not start background network reconciliation.
    var sharedContextTransportEnabled: Bool { !fixtureSessions }
    @Published private(set) var connected = false
    private(set) var connectionError: HostRoutingError?

    /// Includes full snapshots on initial connection and reconnect, not just deltas.
    var onSessionsChanged: (([SessionSummary], Bool) -> Void)?
    var onSchedulesChanged: (([ScheduledItem]) -> Void)?
    var onConnected: (() -> Void)?
    var onDiagnosticRead: ((DiagnosticReadDispatch) -> Void)?
    /// Invalidation only. The courier fetches bounded daemon-owned exchange pages.
    var onSharedContextsChanged: (() -> Void)?

    // The WebSocket includes ALL sessions, including archives, for readable subscriptions.
    var activeSessions: [SessionSummary] { sessions.unarchivedSessions }
    var archivedSessions: [SessionSummary] { sessions.archivedSessions }
    var workingCount: Int { activeSessions.filter(\.isWorking).count }

    private var baseURL: URL?
    private(set) var hostIdentity: HostRef?
    func bind(_ host: HostRef) throws {
        guard hostIdentity == nil || hostIdentity == host else { throw HostRoutingError.identityChanged }
        hostIdentity = host
    }
    private(set) var connectionGeneration = UUID()
    private var disconnected = false
    private let artifactSession: URLSession
    /// Explicit per-client transport injection, including URLProtocol fixtures. Never a global override.
    private let commandConfiguration: URLSessionConfiguration
    private var activeReads = 0
    private let repositoryRequests = RepositoryRequestLimiter(limit: 4)
    private let summaryCache = AsyncReadCache<String, SessionChangeSummary>(ttl: 10)
    private let branchCache = AsyncReadCache<String, SessionBranch>(ttl: 10)
    private let changesCache = AsyncReadCache<String, SessionChanges>(ttl: 1, limit: 8)
    init(baseURL: URL? = nil, artifactSession: URLSession = .shared,
         commandConfiguration: URLSessionConfiguration = .ephemeral) {
        self.baseURL = baseURL
        self.artifactSession = artifactSession
        self.commandConfiguration = commandConfiguration
        // Returning to the app refreshes the PR state of open chats. The daemon skips recently checked ones.
        activationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.postFocus() }
        }
    }
    private var activationObserver: NSObjectProtocol?
    deinit {
        if let activationObserver { NotificationCenter.default.removeObserver(activationObserver) }
    }
    private var control: SocketReader?
    private var retry = 0
    private var awaitingList: [String: SessionSummary] = [:]
    private var listeners: [String: [UUID: ([JSONValue]) -> Void]] = [:]
    private var chats: [String: ChatStream] = [:]
    private var subagentListeners: [SubagentKey: [UUID: SubagentListener]] = [:]
    private var subagentSockets: [SubagentKey: StreamSocket] = [:]
    private var terminals: [String: TerminalAttachment] = [:]
    private var terminalSockets: [String: StreamSocket] = [:]
    private(set) var terminalIntents: [String: WorkspaceTerminalIntent] = [:]
    private var terminalReady: Set<String> = []
    private var workspaceTerminalProtocol: Int?
    private var setupSockets: [String: SetupTerminalConnection] = [:]

    /// One open chat's socket and where to resume its stream after a disconnect.
    private final class ChatStream {
        var socket: StreamSocket?
        var streamId: String?
        /// Last batch handed to listeners.
        var seq = 0
    }

    /// One app-side terminal attached to a daemon-owned shell.
    struct TerminalAttachment {
        var cols: Int
        var rows: Int
        var onData: (String) -> Void
        var onExit: (Int) -> Void
        /// Called before the daemon replays scrollback on (re)attach, so the surface can reset.
        var onReplay: () -> Void
        var onStatus: (TerminalConnectionState) -> Void = { _ in }
    }

    func connect(to baseURL: URL) {
        // Endpoint clients are installation-scoped. A new tunnel port needs a new client.
        guard self.baseURL == nil || self.baseURL == baseURL else { return }
        disconnected = false
        connectionError = nil
        connectionGeneration = UUID()
        fixtureSessions = false
        self.baseURL = baseURL
        open()
        for chat in chats.values { chat.socket?.connect() }
        for socket in terminalSockets.values { socket.connect() }
        for socket in subagentSockets.values { socket.connect() }
    }

    func disconnect() {
        closeSetupAttachments()
        disconnected = true
        connectionGeneration = UUID()
        connected = false
        control?.cancel()
        control = nil
        for chat in chats.values { chat.socket?.close() }
        for socket in terminalSockets.values { socket.close() }
        for socket in subagentSockets.values { socket.close() }
    }

    func hello() async throws -> DaemonHello {
        let generation = connectionGeneration
        let hello: DaemonHello = try await call("api/hello", method: "GET")
        if generation == connectionGeneration { workspaceTerminalProtocol = hello.capabilities.workspaceTerminalProtocol ?? 0 }
        return hello
    }

    func operation(_ operation: DurableOperation, lookup: Bool, nativeCapability: String? = nil) async throws -> OperationDelivery {
        guard let baseURL else { throw HostRoutingError.disconnected }
        var request = URLRequest(url: baseURL.appending(path: lookup ? "api/operations/receipt" : "api/operations"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let nativeCapability { request.setValue(nativeCapability, forHTTPHeaderField: "X-Pilot-GitHub-Capability") }
        request.httpBody = try JSONEncoder().encode(operation)
        // Receipt reads are small and should leave Check usable even if the endpoint stalls.
        // The mutation keeps its normal command timeout; a timeout is never proof of failure.
        if lookup { request.timeoutInterval = 5 }
        let response: JSONValue = try await call(request, maximumDuration: lookup ? 5 : nil)
        if response["state"]?.string == "unknown" { return .unknown }
        let receipt = try response.decode(OperationReceipt.self)
        try receipt.validate(operation)
        return .receipt(receipt)
    }

    func telemetrySettings() async throws -> TelemetrySettings {
        try await call("api/telemetry", method: "GET")
    }

    func updateTelemetrySettings(_ settings: TelemetrySettingsPatch) async throws -> TelemetrySettings {
        try await call("api/telemetry", method: "PUT", body: settings)
    }

    func clearDiagnostics() async throws {
        let _: TelemetryClearResponse = try await call("api/diagnostics", method: "DELETE")
    }

    func replaceNativeDiagnostics(_ batch: NativeDiagnosticsBatch) async throws {
        struct Response: Decodable { let accepted: Bool }
        let response: Response = try await call("api/diagnostics/native", method: "PUT", body: batch)
        guard response.accepted else { throw ClientError("Native diagnostics were not accepted") }
    }

    // MARK: Shared context. No app outbox or new operation IDs are created here.

    func sharedContexts() async throws -> [SharedContextSummary] {
        let values: [SharedContextSummary] = try await sharedContextRequest([])
        guard values.count <= SharedContextCourier.bindingBudget else { throw HostRoutingError.invalidReference }
        return values
    }

    /// Explicit user-confirmed enrollment, never inferred from names, paths or repository URLs.
    func enrollSharedContext(_ binding: SharedContextBinding) async throws {
        let _: Ack = try await sharedContextRequest([], method: "POST",
            body: JSONEncoder().encode(binding))
        onSharedContextsChanged?()
    }

    func sharedContextExchange(_ bindingId: String, peer: OperationHost) async throws -> SharedExchangeBatch {
        struct Request: Encodable { let peer: OperationHost }
        let batch: SharedExchangeBatch = try await sharedContextRequest([bindingId, "exchange"], method: "POST",
            body: JSONEncoder().encode(Request(peer: peer)))
        guard batch.bindingId == bindingId, batch.operations.count <= 16 else { throw HostRoutingError.invalidReference }
        return batch
    }

    func acknowledgeSharedContext(_ bindingId: String, _ acknowledgment: SharedExchangeAcknowledgment) async throws {
        try acknowledgment.receipt.validate(acknowledgment.operation)
        guard acknowledgment.operation.bindingId == bindingId, acknowledgment.receipt.state != .pending else {
            throw HostRoutingError.invalidReference
        }
        let _: Ack = try await sharedContextRequest([bindingId, "ack"], method: "POST",
            body: JSONEncoder().encode(acknowledgment))
    }

    func sharedMission(_ binding: SharedContextBinding, missionId: String) async throws -> SharedMissionRead {
        try validateSharedRead(binding, missionId: missionId)
        let result: SharedMissionRead = try await sharedRead(binding, path: ["missions", missionId])
        try validateSharedMissionIdentity(binding, bindingId: result.bindingId, generation: result.generation,
                                          authority: result.authority, source: result.source)
        guard result.snapshot.missionId == missionId, result.snapshot.detail.mission.id == missionId,
              result.snapshot.sequence >= 0, result.proposals.count <= 256,
              result.proposals.allSatisfy({ $0.missionId == missionId }) else { throw HostRoutingError.invalidReference }
        return result
    }

    /// Read one page. A later page must retain the first page's sequence; a 409 requires
    /// starting again, not combining task versions from different reads.
    func sharedMissionVersions(_ binding: SharedContextBinding, missionId: String, after: Int = 0,
                               limit: Int = 128, sequence: Int? = nil) async throws -> SharedMissionVersions {
        try validateSharedRead(binding, missionId: missionId)
        guard (1...128).contains(limit), after >= 0, after <= 9_007_199_254_740_991 - limit,
              sequence.map({ $0 >= 0 && $0 <= 9_007_199_254_740_991 }) ?? true,
              after == 0 || sequence != nil else { throw HostRoutingError.invalidReference }
        var query = [URLQueryItem(name: "after", value: String(after)), URLQueryItem(name: "limit", value: String(limit))]
        if let sequence { query.append(URLQueryItem(name: "sequence", value: String(sequence))) }
        let result: SharedMissionVersions = try await sharedRead(binding, path: ["missions", missionId, "versions"], query: query)
        try validateSharedMissionIdentity(binding, bindingId: result.bindingId, generation: result.generation,
                                          authority: result.authority, source: result.source)
        guard result.complete, result.missionId == missionId, result.sequence >= 0,
              sequence == nil || sequence == result.sequence, result.entities.count <= limit,
              result.next == nil || (result.next == after + result.entities.count && result.entities.count == limit),
              Set(result.entities.map { [$0.kind.rawValue, $0.id] }).count == result.entities.count,
              result.entities.allSatisfy({ !$0.id.isEmpty && $0.revision >= 0
                  && ($0.definitionRevision.map { $0 >= 0 } ?? true) }) else {
            throw HostRoutingError.invalidReference
        }
        return result
    }

    func sharedMissionConflicts(_ binding: SharedContextBinding) async throws -> [SharedMissionProposal] {
        let result: [SharedMissionProposal] = try await sharedRead(binding, path: ["conflicts"])
        guard result.count <= 128, result.allSatisfy({ binding.missionIds.contains($0.missionId) }) else {
            throw HostRoutingError.invalidReference
        }
        return result
    }

    func sharedMemoryWake(_ binding: SharedContextBinding, lines: Int = 96) async throws -> SharedMemoryRead {
        guard (1...256).contains(lines) else { throw HostRoutingError.invalidReference }
        let result = try await sharedMemoryRead(binding, action: "wake", query: [URLQueryItem(name: "lines", value: String(lines))])
        guard case .view = result.value else { throw HostRoutingError.invalidReference }
        return result
    }

    func sharedMemoryRecall(_ binding: SharedContextBinding, regex: String, lines: Int = 96) async throws -> SharedMemoryRead {
        guard (1...256).contains(lines), regex.utf16.count <= 512 else { throw HostRoutingError.invalidReference }
        let result = try await sharedMemoryRead(binding, action: "recall", query: [
            URLQueryItem(name: "regex", value: regex), URLQueryItem(name: "lines", value: String(lines)),
        ])
        guard case .recall = result.value else { throw HostRoutingError.invalidReference }
        return result
    }

    func sharedMemoryZoom(_ binding: SharedContextBinding, range: MemoryRange) async throws -> SharedMemoryRead {
        let result = try await sharedMemoryRead(binding, action: "zoom", query: sharedMemoryRange(range))
        guard case .nodes = result.value else { throw HostRoutingError.invalidReference }
        return result
    }

    func sharedMemoryTree(_ binding: SharedContextBinding, range: MemoryRange? = nil,
                          depth: Int = 2, reveal: [Int] = []) async throws -> SharedMemoryTreeRead {
        guard binding.shareMemory, (1...64).contains(depth), reveal.count <= 64, reveal.allSatisfy({ $0 >= 0 }) else {
            throw HostRoutingError.invalidReference
        }
        var query = [URLQueryItem(name: "depth", value: String(depth))]
        if let range { query += try sharedMemoryRange(range) }
        if !reveal.isEmpty { query.append(URLQueryItem(name: "reveal", value: reveal.map(String.init).joined(separator: ","))) }
        let result: SharedMemoryTreeRead = try await sharedRead(binding, path: ["memory", "tree"], query: query)
        try validateSharedMemoryState(result.state, proposals: result.proposals)
        var nodes = result.value.nodes, visited = 0
        guard nodes.count <= 1024 else { throw HostRoutingError.invalidReference }
        while let node = nodes.popLast() {
            visited += 1
            let children = node.children ?? []
            guard visited + nodes.count + children.count <= 1024 else { throw HostRoutingError.invalidReference }
            nodes.append(contentsOf: children)
        }
        return result
    }

    private func sharedMemoryRange(_ range: MemoryRange) throws -> [URLQueryItem] {
        guard range.lo >= 0, range.hi >= range.lo else { throw HostRoutingError.invalidReference }
        return [URLQueryItem(name: "lo", value: String(range.lo)), URLQueryItem(name: "hi", value: String(range.hi))]
    }

    private func sharedMemoryRead(_ binding: SharedContextBinding, action: String,
                                  query: [URLQueryItem]) async throws -> SharedMemoryRead {
        guard binding.shareMemory else { throw HostRoutingError.invalidReference }
        let result: SharedMemoryRead = try await sharedRead(binding, path: ["memory", action], query: query)
        try validateSharedMemoryState(result.state, proposals: result.proposals)
        return result
    }

    private func validateSharedMemoryState(_ state: SharedMemoryReplicaState, proposals: [SharedMemoryProposal]) throws {
        guard state.complete, state.sequence >= 0, state.pendingCount >= 0, state.conflictCount >= 0,
              proposals.count <= 256 else { throw HostRoutingError.invalidReference }
    }

    private func validateSharedRead(_ binding: SharedContextBinding, missionId: String? = nil) throws {
        guard let hostIdentity, binding.schemaVersion == 1, binding.generation > 0, binding.state == .active,
              binding.peers.contains(OperationHost(hostIdentity)),
              missionId.map({ binding.missionIds.contains($0) }) ?? true else { throw HostRoutingError.invalidReference }
    }

    private func validateSharedMissionIdentity(_ binding: SharedContextBinding, bindingId: String, generation: UInt64,
                                               authority: OperationHost, source: SharedReadSource) throws {
        guard let hostIdentity, bindingId == binding.bindingId, generation == binding.generation,
              authority == binding.missionHome,
              (source == .canonical) == authority.matches(hostIdentity) else { throw HostRoutingError.identityChanged }
    }

    private func sharedRead<Response: Decodable & Sendable>(
        _ binding: SharedContextBinding, path: [String], query: [URLQueryItem] = []
    ) async throws -> Response {
        try validateSharedRead(binding)
        let value: Response = try await sharedContextRequest([binding.bindingId] + path, query: query, maximumBytes: 1024 * 1024)
        try validateSharedRead(binding)
        return value
    }

    private var activeSharedRequests = 0

    private func sharedContextRequest<Response: Decodable & Sendable>(
        _ path: [String], method: String = "GET", body: Data? = nil,
        query: [URLQueryItem] = [], maximumBytes: Int = 2 * 1024 * 1024
    ) async throws -> Response {
        guard connected, !disconnected else { throw HostRoutingError.disconnected }
        guard (body?.count ?? 0) <= 128 * 1024 else { throw HostRoutingError.invalidReference }
        guard activeSharedRequests < 2 else { throw ClientError("Shared notes and tasks are busy. Try again.") }
        activeSharedRequests += 1
        defer { activeSharedRequests -= 1 }
        let generation = connectionGeneration
        var request = URLRequest(url: try missionURL(["shared-contexts"] + path, query: query))
        request.httpMethod = method; request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "content-type") }
        PilotTraceContext.injectCurrent(into: &request)
        let (data, response) = try await BoundedHTTPData.read(request, maximumBytes: maximumBytes,
                                                            configuration: commandConfiguration)
        guard connected, !disconnected, generation == connectionGeneration else { throw HostRoutingError.staleGeneration }
        guard (200 ..< 300).contains(response.statusCode) else {
            // Do not include exported prose or raw daemon diagnostics in UI errors.
            throw ClientError("Shared notes and tasks are unavailable.", status: response.statusCode)
        }
        let value = try await Task.detached(priority: .utility) { try JSONDecoder().decode(Response.self, from: data) }.value
        guard connected, !disconnected, generation == connectionGeneration else { throw HostRoutingError.staleGeneration }
        try Task.checkCancellation()
        return value
    }

    /// Bounded resource transport for typed native adapters. Never accepts a host URL.
    func resourceRequest<Response: Decodable & Sendable>(_ path: [String], method: String = "GET",
        body: Data? = nil, query: [URLQueryItem] = [], maximumBytes: Int = 1024 * 1024) async throws -> Response {
        guard connected, !disconnected else { throw HostRoutingError.disconnected }
        guard !path.isEmpty, path.count <= 12, path.allSatisfy({ !$0.isEmpty }),
              (body?.count ?? 0) <= 128 * 1024, maximumBytes > 0, maximumBytes <= 2 * 1024 * 1024,
              activeSharedRequests < 2 else { throw HostRoutingError.invalidReference }
        activeSharedRequests += 1
        defer { activeSharedRequests -= 1 }
        let fence = connectionGeneration
        var request = URLRequest(url: try missionURL(path, query: query))
        request.httpMethod = method; request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "content-type") }
        PilotTraceContext.injectCurrent(into: &request)
        let (data, response) = try await BoundedHTTPData.read(request, maximumBytes: maximumBytes, configuration: commandConfiguration)
        guard connected, !disconnected, connectionGeneration == fence else { throw HostRoutingError.staleGeneration }
        guard (200..<300).contains(response.statusCode) else {
            throw ClientError(response.statusCode == 409 ? "This changed elsewhere. Refresh and try again." : "This action could not finish. Your changes have been kept.", status: response.statusCode)
        }
        let value = try await Task.detached(priority: .utility) { try JSONDecoder().decode(Response.self, from: data) }.value
        guard connected, !disconnected, connectionGeneration == fence else { throw HostRoutingError.staleGeneration }
        try Task.checkCancellation()
        return value
    }

    func upload(_ metadata: AttachmentUpload, file: URL) async throws -> StagedAttachmentRef {
        guard !disconnected else { throw HostRoutingError.disconnected }
        let generation = connectionGeneration
        var request = URLRequest(url: try artifactURL(["attachments", metadata.uploadId]))
        request.httpMethod = "PUT"
        request.setValue("image/png", forHTTPHeaderField: "Content-Type")
        request.setValue(String(metadata.bytes), forHTTPHeaderField: "Content-Length")
        request.setValue(try JSONEncoder().encode(metadata).base64EncodedString(), forHTTPHeaderField: "X-Pilot-Attachment")
        PilotTraceContext.injectCurrent(into: &request)
        let (data, response) = try await BoundedHTTPData.read(request, maximumBytes: 4096,
                                                            configuration: commandConfiguration, uploadFile: file)
        guard !disconnected, generation == connectionGeneration else { throw HostRoutingError.staleGeneration }
        guard response.statusCode == 201 else {
            throw ClientError("Attachment upload was not accepted")
        }
        let result = try JSONDecoder().decode(StagedAttachmentRef.self, from: data)
        guard result.uploadId == metadata.uploadId, result.sha256 == metadata.sha256, result.bytes == metadata.bytes else {
            throw HostRoutingError.invalidReference
        }
        return result
    }

    func session(_ id: String) -> SessionSummary? {
        sessions.first { $0.id == id }
    }

    func project(_ id: String?) -> Project? {
        id.flatMap { id in projects.first { $0.id == id } }
    }

    func mission(_ id: String?) -> Mission? {
        id.flatMap { id in missions.first { $0.id == id } }
    }

    /// Static data for snapshots and previews.
    func loadFixture(projects: [Project], sessions: [SessionSummary]) {
        workspaceTerminalProtocol = 2
        fixtureSessions = true
        self.projects = projects
        hasProjectSnapshot = true
        hasSessionSnapshot = true
        hasMissionSnapshot = true
        self.sessions = sessions.sorted(by: SessionSummary.listPrecedes)
        connected = true
    }

    /// Private offline metadata is presentation only, never a fixture or a live endpoint.
    func restoreOfflinePresentation(_ snapshot: OfflineHostSnapshot) {
        guard !connected, baseURL == nil else { return }
        projects = snapshot.projects
        sessions = snapshot.sessions.sorted(by: SessionSummary.listPrecedes)
        missions = snapshot.missions
        hasProjectSnapshot = true; hasSessionSnapshot = true; hasMissionSnapshot = true
        disconnected = true
    }

    /// Static missions for snapshots and previews. Details are served without subscriptions.
    func loadMissionFixture(_ details: [MissionDetail]) {
        fixtureMissions = true
        missions = details.map(\.mission)
        missionDetails = Dictionary(uniqueKeysWithValues: details.map { ($0.mission.id, $0) })
    }

    /// Static project dashboards for snapshots and previews, served without subscriptions.
    func loadDashboardFixture(_ dashboards: [ProjectDashboard], receivedAt: Date = Date(),
                              errors: [String: String] = [:]) {
        fixtureDashboards = true
        projectDashboards = Dictionary(uniqueKeysWithValues: dashboards.map { ($0.projectId, $0) })
        dashboardReceivedAt = projectDashboards.mapValues { _ in receivedAt }
        dashboardErrors = errors
    }

    /// Static sidebar counts for snapshots and previews.
    func loadCountsFixture(_ counts: ProjectDashboardCounts) {
        projectCounts = counts
    }

    // MARK: Commands

    func repositoryDirectory(_ selection: RepositorySelection, offset: Int = 0) async throws -> RepositoryDirectoryPage {
        guard let baseURL else { throw HostRoutingError.disconnected }
        var url = URLComponents(url: baseURL.appending(path: "api/repositories/directories"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "rootId", value: selection.rootId),
                          URLQueryItem(name: "path", value: selection.path),
                          URLQueryItem(name: "offset", value: String(offset))]
        return try await get(url.url!)
    }

    func createRepositoryProject(_ selection: RepositorySelection) async throws -> Project {
        struct Request: Encodable { let selection: RepositorySelection }
        let project: Project = try await call("api/repositories/projects", body: Request(selection: selection))
        upsert(project)
        return project
    }

    func file(_ sessionId: String, path: String) async throws -> SessionFileContent {
        guard let baseURL else { throw HostRoutingError.disconnected }
        var url = URLComponents(url: baseURL.appending(path: "api/sessions/\(sessionId)/files"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "path", value: path)]
        let value: SessionFileContent = try await get(url.url!)
        guard value.path == path else { throw HostRoutingError.invalidReference }
        return value
    }

    /// The daemon updates project dashboards and sidebar counts over the existing WebSocket.
    func review(_ request: ReviewRequest) async throws {
        guard request.marks.count <= ReviewRequest.maxMarks else { throw ClientError("Too many review marks") }
        let _: Ack = try await call("api/reviews", body: request)
    }

    /// A bounded, cancellable request on filter changes. Live updates still come from the list stream.
    func archivedSessions(filter: ArchiveFilter) async throws -> [SessionSummary] {
        if fixtureSessions { return filter.apply(to: sessions) }
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        var components = URLComponents(url: baseURL.appending(path: "api/sessions"), resolvingAgainstBaseURL: false)!
        components.queryItems = filter.queryItems
        return try await get(components.url!)
    }

    func spawn(_ request: SpawnRequest) async throws -> SessionSummary {
        if fixtureSessions {
            fixtureSpawnRequests.append(request)
            let now = Date().timeIntervalSince1970 * 1_000
            let session = SessionSummary(
                id: "fixture-spawn-\(fixtureSpawnRequests.count)", title: request.title ?? "New chat",
                cwd: request.cwd ?? project(request.projectId)?.path ?? "/tmp", projectId: request.projectId,
                createdAt: now, updatedAt: now, state: "working", mode: request.mode, role: request.role,
                diagnosticScope: request.diagnosticScope,
                diagnosticTargetId: request.diagnosticTarget?.sessionId, diagnosticTarget: request.diagnosticTarget
            )
            update(session)
            return session
        }
        let session: SessionSummary = try await call("api/sessions", body: request)
        // REST can win the race with the list stream. Navigation needs the session immediately,
        // but must not overwrite a newer state already received over the WebSocket.
        if self.session(session.id) == nil {
            awaitingList[session.id] = session
            update(session)
        }
        return session
    }

    /// A receipt may arrive before the session-list stream, including after reconnect.
    /// Read the exact existing chat, never create a replacement to make navigation work.
    func createdSession(_ id: String) async throws -> SessionSummary {
        if let existing = session(id) { return existing }
        let value: SessionSummary = try await call("api/sessions/\(id)", method: "GET")
        guard value.id == id else { throw HostRoutingError.invalidReference }
        if let existing = session(id) { return existing }
        awaitingList[id] = value
        update(value)
        return value
    }

    func createSchedule(_ request: ScheduleRequest) async throws -> ScheduledItem {
        try await call("api/schedules", body: request)
    }

    func updateSchedule(_ id: String, _ request: SchedulePatch) async throws -> ScheduledItem {
        try await call("api/schedules/\(id)", method: "PATCH", body: request)
    }

    func deleteSchedule(_ id: String) async throws {
        let _: Ack = try await call("api/schedules/\(id)", method: "DELETE")
    }

    func send(_ sessionId: String, message: String, mode: DeliveryMode) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat before sending messages.") }
        try ensureNotContinued(sessionId)
        if fixtureSessions { fixtureSendRequests.append((sessionId, message, mode)); return }
        let _: Ack = try await call("api/sessions/\(sessionId)/messages", body: SendRequest(message: message, mode: mode))
    }

    /// Answers a db access request. pilotd records the decision and tells the agent, so no message is sent here.
    func decideDatabaseAccess(_ sessionId: String, requestId: String, allow: Bool) async throws {
        let _: Ack = try await call(
            "api/sessions/\(sessionId)/database-access", body: DatabaseAccessDecision(id: requestId, allow: allow)
        )
    }

    /// Stops current work. Returns the user's queued messages that Stop withdrew, which belong in the composer.
    func stop(_ sessionId: String) async throws -> String? {
        let response: StopResponse = try await call("api/sessions/\(sessionId)/stop", body: [String: String]())
        return response.draft
    }

    /// Reloads a failed startup using its original queued messages, without creating a new attempt.
    func retryStartup(_ sessionId: String) async throws {
        let session: SessionSummary = try await call(
            "api/sessions/\(sessionId)/retry-startup", body: [String: String]()
        )
        update(session)
    }

    /// Prompt templates and skills the session's kernel expands. Reopens a parked chat only when pilotd has no list yet.
    func commands(_ sessionId: String) async throws -> [SessionCommand] {
        let response: SessionCommandsResponse = try await call("api/sessions/\(sessionId)/commands", method: "GET")
        return response.commands
    }

    /// Reads content-free evidence without opening or subscribing to the target chat.
    func appDiagnosticEvidence() async throws -> AppDiagnosticEvidence {
        if let fixtureAppDiagnosticEvidence { return fixtureAppDiagnosticEvidence }
        guard let baseURL, let host = hostIdentity,
              var components = URLComponents(url: baseURL.appending(path: "api/diagnostics/app"), resolvingAgainstBaseURL: false)
        else { throw HostRoutingError.disconnected }
        components.queryItems = [URLQueryItem(name: "hostId", value: host.hostId),
                                 URLQueryItem(name: "daemonId", value: host.daemonId),
                                 URLQueryItem(name: "lineageId", value: host.lineageId)]
        guard let url = components.url else { throw HostRoutingError.invalidReference }
        return try await call(URLRequest(url: url))
    }

    /// Reads content-free evidence without opening or subscribing to the target chat.
    func diagnostics(_ sessionId: String, limit: Int = 128) async throws -> SessionDiagnostics {
        guard (1 ... 128).contains(limit) else { throw ClientError("Diagnostic limit must be between 1 and 128") }
        if let fixture = fixtureDiagnostics[sessionId] { return fixture }
        guard let baseURL, let host = hostIdentity,
              var components = URLComponents(
                  url: baseURL.appending(path: "api/sessions/\(sessionId)/diagnostics"),
                  resolvingAgainstBaseURL: false
              ) else { throw HostRoutingError.disconnected }
        components.queryItems = [
            URLQueryItem(name: "hostId", value: host.hostId),
            URLQueryItem(name: "daemonId", value: host.daemonId),
            URLQueryItem(name: "lineageId", value: host.lineageId),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = components.url else { throw HostRoutingError.invalidReference }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        return try await call(request)
    }

    /// Prepares bounded evidence for a separate repair chat. This call never starts or changes a chat.
    func diagnosticsHandoff(_ specialistId: String,
                            request body: DiagnosticsHandoffRequest) async throws -> DiagnosticsHandoff {
        guard let baseURL, let host = hostIdentity,
              var components = URLComponents(
                  url: baseURL.appending(path: "api/sessions/\(specialistId)/diagnostics/handoff"),
                  resolvingAgainstBaseURL: false
              ) else { throw HostRoutingError.disconnected }
        components.queryItems = [
            URLQueryItem(name: "hostId", value: host.hostId),
            URLQueryItem(name: "daemonId", value: host.daemonId),
            URLQueryItem(name: "lineageId", value: host.lineageId),
        ]
        guard let url = components.url else { throw HostRoutingError.invalidReference }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await call(request)
    }

    /// Stops one running job. The session summary drops it once the worker reports its jobs again.
    func stopJob(_ sessionId: String, jobId: String) async throws {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        guard let job = jobId.addingPercentEncoding(withAllowedCharacters: allowed),
              var components = URLComponents(url: baseURL.appending(path: "api/sessions/\(sessionId)/jobs"),
                                             resolvingAgainstBaseURL: false) else {
            throw ClientError("Invalid job id")
        }
        // One path segment, even when the id holds a slash.
        components.percentEncodedPath += "/\(job)/stop"
        guard let url = components.url else { throw ClientError("Invalid job id") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let _: Ack = try await call(request)
    }

    /// Starts a manual compaction; returns once it is queued, not when the summary is placed.
    func compact(_ sessionId: String, instructions: String?) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat before compacting it.") }
        try ensureNotContinued(sessionId)
        let _: Ack = try await call("api/sessions/\(sessionId)/compact", body: CompactRequest(instructions: instructions))
    }

    /// Stops current work and continues from an earlier point in a new attempt. Workspace files are not reverted.
    /// Returns the edited message's text for `.edit`, which belongs in the composer.
    func rewind(_ sessionId: String, action: RewindAction, entryId: Int) async throws -> String? {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat first.") }
        try ensureNotContinued(sessionId)
        let response: RewindResponse = try await call(
            "api/sessions/\(sessionId)/rewind", body: RewindRequest(action: action, entryId: entryId)
        )
        update(response.session)
        return response.draft
    }

    /// Stops current work and continues another attempt of the chat.
    func activateAttempt(_ sessionId: String, attemptId: String) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat first.") }
        try ensureNotContinued(sessionId)
        let session: SessionSummary = try await call(
            "api/sessions/\(sessionId)/attempts/\(attemptId)/activate", body: [String: String]()
        )
        update(session)
    }

    /// One page of entries hidden from the transcript by compaction or reset (`SessionHistoryPage`), decoded off the
    /// main actor. Never wakes a parked chat.
    func history(_ sessionId: String, before: Int, limit: Int = 100) async throws -> JSONValue {
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        var components = URLComponents(url: baseURL.appending(path: "api/sessions/\(sessionId)/history"),
                                       resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "before", value: String(before)),
                                 URLQueryItem(name: "limit", value: String(limit))]
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            let error = (try? JSONDecoder().decode(APIError.self, from: data))?.error
            // An older running pilotd has no history route; restarting it would interrupt active agents.
            if status == 404, error == "Not found" {
                throw ClientError("Once agents are idle, restart pilotd from the Pilot menu to show earlier messages.", status: status)
            }
            throw ClientError(error ?? "HTTP \(status)", status: status)
        }
        return try await Task.detached(priority: .userInitiated) { try JSONValue.decode(data) }.value
    }

    // MARK: Subagents

    /// Static transcripts for snapshots and previews, keyed by subagent name.
    var fixtureSubagentTranscripts: [String: [JSONValue]]?

    /// Receives a subagent transcript stream: a snapshot (or empty list) replaces it, appended entries extend it.
    struct SubagentListener {
        let events: ([JSONValue]) -> Void
        let error: (String) -> Void
    }

    /// Live, read-only transcript of a subagent. One daemon subscription per subagent, however many views.
    /// Never wakes a parked session. The first batch after (re)subscribing is always a full replacement.
    func subscribeSubagent(_ key: SubagentKey, _ listener: SubagentListener) -> UUID {
        let token = UUID()
        let first = subagentListeners[key]?.isEmpty ?? true
        subagentListeners[key, default: [:]][token] = listener
        if let fixtureSubagentTranscripts {
            let events = fixtureSubagentTranscripts[key.name] ?? []
            Task { @MainActor in self.subagentListeners[key]?[token]?.events(events) }
        } else if first {
            openSubagent(key)
        }
        return token
    }

    func unsubscribeSubagent(_ key: SubagentKey, token: UUID) {
        subagentListeners[key]?[token] = nil
        guard subagentListeners[key]?.isEmpty ?? false else { return }
        subagentListeners[key] = nil
        subagentSockets.removeValue(forKey: key)?.close()
    }

    private func openSubagent(_ key: SubagentKey) {
        let socket = StreamSocket(
            url: { [weak self] in
                self?.socketURL("/api/sessions/\(Self.pathSegment(key.sessionId))/subagents/\(Self.pathSegment(key.name))/ws")
            },
            receive: { [weak self] updates in
                guard let self else { return }
                for update in updates {
                    switch update {
                    case let .subagentEvents(id, name, _) where id == key.sessionId && name == key.name: self.handle(update)
                    case let .error(id, name, _) where id == key.sessionId && name == key.name: self.handle(update)
                    default: break
                    }
                }
            }
        )
        subagentSockets[key] = socket
        socket.connect()
    }

    /// Steers current work by default; `followUp` queues after it.
    func sendToSubagent(_ sessionId: String, name: String, message: String, mode: DeliveryMode = .steer) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat before messaging subagents.") }
        try ensureNotContinued(sessionId)
        let _: Ack = try await call(
            url: subagentURL(sessionId, name: name, action: "messages"),
            body: SubagentMessageRequest(message: message, mode: mode)
        )
    }

    func stopSubagent(_ sessionId: String, name: String) async throws {
        let _: Ack = try await call(url: subagentURL(sessionId, name: name, action: "stop"), body: [String: String]())
    }

    /// Names are arbitrary text, so encode them as one opaque path segment.
    private func subagentURL(_ sessionId: String, name: String, action: String) throws -> URL {
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        var unreserved = CharacterSet.alphanumerics
        unreserved.insert(charactersIn: "-._~")
        guard !name.isEmpty, let encoded = name.addingPercentEncoding(withAllowedCharacters: unreserved),
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        else { throw ClientError("Invalid subagent name") }
        let base = components.percentEncodedPath.hasSuffix("/") ? components.percentEncodedPath : components.percentEncodedPath + "/"
        components.percentEncodedPath = base + "api/sessions/\(sessionId)/subagents/\(encoded)/\(action)"
        guard let url = components.url else { throw ClientError("Invalid subagent name") }
        return url
    }

    @discardableResult
    func changeModel(_ sessionId: String, model: String, thinking: String? = nil) async throws -> SessionSummary {
        let session: SessionSummary = try await call(
            "api/sessions/\(sessionId)/model", body: ChangeModelRequest(model: model, thinking: thinking)
        )
        update(session)
        return session
    }

    /// Works past (true) or pauses again at (false) the subscription usage limit.
    @discardableResult
    func forceSubscription(_ sessionId: String, force: Bool) async throws -> SessionSummary {
        let session: SessionSummary = try await call(
            "api/sessions/\(sessionId)/subscription-force", body: SubscriptionForceRequest(force: force)
        )
        update(session)
        return session
    }

    /// Continues the chat's work with another model. Returns this chat for the same provider, or the new chat that
    /// took over for another provider (the original then reports `continuedTo`).
    @discardableResult
    func continueModel(_ sessionId: String, model: String, thinking: String? = nil) async throws -> SessionSummary {
        guard session(sessionId)?.isReadOnlyHistory != true else {
            throw ClientError("This chat is read-only and cannot continue with another model.")
        }
        let session: SessionSummary = try await call(
            "api/sessions/\(sessionId)/continue-model", body: ContinueModelRequest(model: model, thinking: thinking)
        )
        update(session)
        return session
    }

    func editQueuedMessage(_ sessionId: String, submissionId: Int, message: String, mode: DeliveryMode? = nil) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat before editing queued messages.") }
        try ensureNotContinued(sessionId)
        let _: Ack = try await call(
            "api/sessions/\(sessionId)/queue/\(submissionId)",
            method: "PATCH",
            body: EditQueuedMessageRequest(message: message, mode: mode)
        )
    }

    func removeQueuedMessage(_ sessionId: String, submissionId: Int) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat before removing queued messages.") }
        try ensureNotContinued(sessionId)
        let _: RemoveQueuedMessageResponse = try await call(
            "api/sessions/\(sessionId)/queue/\(submissionId)", method: "DELETE", body: [String: String]()
        )
    }

    func sendHeldMessages(_ sessionId: String) async throws {
        let _: HeldMessagesResponse = try await call("api/sessions/\(sessionId)/held/send")
    }

    func discardHeldMessages(_ sessionId: String, submissionId: Int? = nil) async throws {
        let suffix = submissionId.map { "/\($0)" } ?? ""
        let _: HeldMessagesResponse = try await call("api/sessions/\(sessionId)/held\(suffix)", method: "DELETE", body: [String: String]())
    }

    @discardableResult
    func pin(_ sessionId: String) async throws -> SessionSummary {
        let session: SessionSummary = try await call("api/sessions/\(sessionId)/pin")
        update(session)
        return session
    }

    @discardableResult
    func unpin(_ sessionId: String) async throws -> SessionSummary {
        let session: SessionSummary = try await call("api/sessions/\(sessionId)/unpin")
        update(session)
        return session
    }

    @discardableResult
    func rename(_ sessionId: String, title: String) async throws -> SessionSummary {
        let session: SessionSummary = try await call(
            "api/sessions/\(sessionId)/title", body: RenameSessionRequest(title: title)
        )
        update(session)
        return session
    }

    @discardableResult
    func archive(_ sessionId: String) async throws -> SessionSummary {
        guard session(sessionId)?.isWorking != true else { throw ClientError("Stop this session before archiving it.") }
        let session: SessionSummary = try await call("api/sessions/\(sessionId)/archive", body: [String: String]())
        update(session)
        return session
    }

    @discardableResult
    func restore(_ sessionId: String) async throws -> SessionSummary {
        let session: SessionSummary = try await call("api/sessions/\(sessionId)/restore", body: [String: String]())
        update(session)
        return session
    }

    /// Binds a GitHub PR to the chat, moving it from any chat that owns it. pilotd validates the link and the
    /// project repository; in a mission chat `taskId` picks the task to link (default: the chat's claim).
    @discardableResult
    func bindPullRequest(_ sessionId: String, url: String, taskId: String? = nil) async throws -> SessionSummary {
        let session: SessionSummary = try await call(
            "api/sessions/\(sessionId)/pull-requests", body: BindPullRequestRequest(url: url, taskId: taskId)
        )
        update(session)
        return session
    }

    /// Detaches a PR from the chat: no tracking, follow-ups or rediscovery, and its mission task link is removed.
    @discardableResult
    func unbindPullRequest(_ sessionId: String, url: String) async throws -> SessionSummary {
        let session: SessionSummary = try await call(
            "api/sessions/\(sessionId)/pull-requests", method: "DELETE", body: UnbindPullRequestRequest(url: url)
        )
        update(session)
        return session
    }

    /// Stops tracking a branch without a PR. The branch stays in the repository, and pilotd never adopts it again
    /// in this chat.
    @discardableResult
    func detachBranch(_ sessionId: String, branch: String) async throws -> SessionSummary {
        let session: SessionSummary = try await call(
            "api/sessions/\(sessionId)/branches", method: "DELETE", body: DetachBranchRequest(branch: branch)
        )
        update(session)
        return session
    }

    func previewPullRequestMerge(_ sessionId: String, url: String) async throws -> PullRequestMergePreview {
        try await call("api/sessions/\(sessionId)/pull-requests/merge-preview", body: ["url": url])
    }

    func mergePullRequest(_ sessionId: String, preview: PullRequestMergePreview,
                          method: PullRequestMergeMethod) async throws {
        struct Result: Decodable { let merged: Bool }
        let result: Result = try await call("api/sessions/\(sessionId)/pull-requests/merge",
                                            body: MergePullRequestRequest(preview: preview, method: method))
        guard result.merged else { throw ClientError("GitHub did not merge the pull request.") }
    }

    func createProject(_ request: ProjectRequest) async throws -> Project {
        let project: Project = try await call("api/projects", body: request)
        upsert(project)
        return project
    }

    func importedProject(_ id: String) async throws -> Project {
        let project: Project = try await missionRequest(["projects", id])
        upsert(project)
        return project
    }

    func updateProject(_ id: String, _ request: ProjectRequest) async throws -> Project {
        let project: Project = try await call("api/projects/\(id)", method: "PATCH", body: request)
        upsert(project)
        return project
    }

    func deleteProject(_ id: String) async throws {
        let _: Ack = try await call("api/projects/\(id)", method: "DELETE", body: [String: String]())
        projects.removeAll { $0.id == id }
    }

    func sources(projectId: String? = nil) async throws -> [TrackingSource] {
        try await missionRequest(["sources"], query: projectId.map { [URLQueryItem(name: "projectId", value: $0)] } ?? [])
    }

    func pollSource(_ id: String) async throws -> TrackingSource {
        try await call(url: missionURL(["sources", id, "poll"]), body: [String: String]())
    }

    func source(projectId: String, kind: TrackedKind) -> TrackingSource? {
        trackingSources.first { $0.projectId == projectId && $0.kind == kind }
    }

    /// pilotd runs pi's MCP OAuth login for the kind's server and opens the browser. Progress arrives with
    /// the sources list; a source resyncs once sign-in is done. A failed request shows as a failed sign-in.
    func startSourceSignIn(_ kind: TrackedKind, again: Bool = false) async {
        do {
            let state: SourceSignIn
            if fixtureTracking != nil {
                let now = Date().timeIntervalSince1970 * 1000
                state = SourceSignIn(kind: kind, state: .waiting, again: again, startedAt: now,
                                     expiresAt: now + 300_000)
            } else {
                state = try await missionRequest(["tracking", kind.rawValue, "sign-in"],
                                                 body: SourceSignInRequest(again: again))
            }
            sourceSignIns.record(state)
        } catch {
            let now = Date().timeIntervalSince1970 * 1000
            sourceSignIns.record(SourceSignIn(kind: kind, state: .failed, again: again, startedAt: now,
                                              expiresAt: now, finishedAt: now,
                                              error: "Couldn't start sign-in. \(error.localizedDescription)"))
        }
    }

    func cancelSourceSignIn(_ kind: TrackedKind) async {
        guard let current = sourceSignIns[kind], current.state == .waiting else { return }
        let cancelled = SourceSignIn(kind: kind, state: .cancelled, again: current.again,
                                     startedAt: current.startedAt, expiresAt: current.expiresAt,
                                     finishedAt: Date().timeIntervalSince1970 * 1000)
        if fixtureTracking != nil { return sourceSignIns.record(cancelled) }
        do {
            sourceSignIns.record(try await missionRequest(["tracking", kind.rawValue, "sign-in"], method: "DELETE"))
        } catch {
            // Already finished or pilotd restarted: either way nothing waits anymore.
            sourceSignIns.record(cancelled)
        }
    }
    /// Linear teams for the project settings picker. Sign-in and errors come back as states.
    func linearTeams(query: String? = nil) async throws -> TrackingLookup<LinearTeamOption> {
        if let fixture = fixtureTracking { return fixture.teams }
        return try await missionRequest(["tracking", "linear", "teams"],
                                        query: query.map { [URLQueryItem(name: "query", value: $0)] } ?? [])
    }

    func linearStates(team: String) async throws -> TrackingLookup<LinearWorkflowStateOption> {
        if fixtureTracking != nil {
            return TrackingLookup(status: .ok, items: [
                LinearWorkflowStateOption(id: "todo", name: "Todo", type: "unstarted"),
                LinearWorkflowStateOption(id: "in-progress", name: "In progress", type: "started"),
                LinearWorkflowStateOption(id: "in-review", name: "In review", type: "started"),
                LinearWorkflowStateOption(id: "merged", name: "Merged", type: "completed"),
                LinearWorkflowStateOption(id: "deployed", name: "Deployed", type: "completed"),
            ])
        }
        return try await missionRequest(["tracking", "linear", "states"],
                                        query: [URLQueryItem(name: "team", value: team)])
    }

    /// Slack channels matching a query, or the channels I'm in when the query is nil.
    func slackChannelOptions(query: String? = nil) async throws -> TrackingLookup<SlackChannelOption> {
        if let fixture = fixtureTracking {
            guard let query, !query.isEmpty else { return fixture.myChannels }
            return TrackingLookup(status: .ok, items: fixture.searchChannels.items.filter {
                $0.name.localizedCaseInsensitiveContains(query.trimmingCharacters(in: CharacterSet(charactersIn: "# ")))
            })
        }
        return try await missionRequest(["tracking", "slack", "channels"],
                                        query: query.map { [URLQueryItem(name: "query", value: $0)] } ?? [])
    }

    func observeTrackedItems(_ handler: @escaping (String) -> Void) -> UUID {
        let id = UUID()
        trackedObservers[id] = handler
        return id
    }

    func stopObservingTrackedItems(_ id: UUID) {
        trackedObservers[id] = nil
    }

    // MARK: Control chat details

    /// The same bounded daemon-memory snapshot as pilot status. Never starts a worker.
    func controlDashboard(projectId: String? = nil, missionId: String? = nil) async throws -> ControlDashboardResponse {
        guard let baseURL else { throw HostRoutingError.disconnected }
        var url = URLComponents(url: baseURL.appending(path: "api/control-chat/dashboard"), resolvingAgainstBaseURL: false)!
        url.queryItems = (projectId.map { [URLQueryItem(name: "projectId", value: $0)] } ?? [])
            + (missionId.map { [URLQueryItem(name: "missionId", value: $0)] } ?? [])
        return try await get(url.url!)
    }

    /// One bounded page of active watches, in ID order. `after` is the previous page's `next`.
    func controlWatches(after: String? = nil, limit: Int = 40) async throws -> WatchesResponse {
        guard let baseURL else { throw HostRoutingError.disconnected }
        var url = URLComponents(url: baseURL.appending(path: "api/control-chat/watches"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
            + (after.map { [URLQueryItem(name: "after", value: $0)] } ?? [])
        return try await get(url.url!)
    }

    /// Idempotent: false when the watch already fired, expired or was cancelled.
    func cancelWatch(_ id: String) async throws -> Bool {
        // One path segment; pilotd's IDs never need escaping.
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.:"))
        guard !id.isEmpty, id.unicodeScalars.allSatisfy(allowed.contains) else { throw HostRoutingError.invalidReference }
        let response: CancelWatchResponse = try await call("api/control-chat/watches/\(id)", method: "DELETE")
        return response.removed
    }

    /// One bounded page of the control audit, newest first. `before` is the oldest loaded sequence.
    func controlAudit(before: Int? = nil, limit: Int = 50) async throws -> ControlAuditResponse {
        guard let baseURL else { throw HostRoutingError.disconnected }
        var url = URLComponents(url: baseURL.appending(path: "api/control-chat/audit"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
            + (before.map { [URLQueryItem(name: "before", value: String($0))] } ?? [])
        return try await get(url.url!)
    }

    /// The control chat's current memory view, oldest first. Read-only.
    func controlMemoryView() async throws -> ControlMemoryViewResponse {
        guard let baseURL else { throw HostRoutingError.disconnected }
        return try await get(baseURL.appending(path: "api/control-chat/memory/view"))
    }

    /// A summary's two halves (n > 1), or one page of a whole message (n == 1, paged by `offset`).
    func controlMemoryNode(start: Int, n: Int, offset: Int? = nil) async throws -> ControlMemoryNodeResponse {
        guard let baseURL else { throw HostRoutingError.disconnected }
        var url = URLComponents(
            url: baseURL.appending(path: "api/control-chat/memory/nodes/\(start)/\(n)"), resolvingAgainstBaseURL: false
        )!
        if let offset { url.queryItems = [URLQueryItem(name: "offset", value: String(offset))] }
        return try await get(url.url!)
    }

    /// One page of the logged messages, newest first. `before` is the previous page's `next`.
    func controlMemoryMessages(before: Int? = nil, limit: Int = 50, query: String? = nil) async throws
        -> ControlMemoryMessagesResponse
    {
        guard let baseURL else { throw HostRoutingError.disconnected }
        var url = URLComponents(
            url: baseURL.appending(path: "api/control-chat/memory/messages"), resolvingAgainstBaseURL: false
        )!
        url.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
            + (before.map { [URLQueryItem(name: "before", value: String($0))] } ?? [])
            + (query.map { [URLQueryItem(name: "q", value: $0)] } ?? [])
        // URLComponents leaves "+" alone, which pilotd's form decoding would read as a space.
        url.percentEncodedQuery = url.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return try await get(url.url!)
    }

    func controlMemoryStats() async throws -> ControlMemoryStats {
        guard let baseURL else { throw HostRoutingError.disconnected }
        return try await get(baseURL.appending(path: "api/control-chat/memory/stats"))
    }

    func observeControlDetails(_ handler: @escaping (ControlDetailsChange) -> Void) -> UUID {
        let id = UUID()
        controlObservers[id] = handler
        return id
    }

    func stopObservingControlDetails(_ id: UUID) {
        controlObservers[id] = nil
    }

    func loadTrackingFixture(_ fixture: TrackingFixture) {
        fixtureTracking = fixture
        trackingSources = fixture.sources
        sourceSignIns.reset()
        for source in fixture.sources { if let state = source.signIn { sourceSignIns.record(state) } }
    }

    /// sessionId: only items whose latest chat is this one, dismissed or not (dismissed and closedByLabel are ignored).
    func trackedItems(projectId: String, kind: TrackedKind? = nil, dismissed: Bool = false,
                      limit: Int = 100, offset: Int = 0, closedByLabel: Bool = false,
                      sessionId: String? = nil) async throws -> TrackedItemList {
        if let fixture = fixtureTracking {
            let items = fixture.items.filter { item in
                guard item.projectId == projectId, kind == nil || item.kind == kind else { return false }
                if let sessionId { return item.sessionId == sessionId }
                return item.dismissed == (dismissed || closedByLabel) && (!closedByLabel || item.slack?.closedByLabel != nil)
            }
            return TrackedItemList(items: Array(items.dropFirst(offset).prefix(limit)), total: items.count)
        }
        var query = [URLQueryItem(name: "projectId", value: projectId),
                     URLQueryItem(name: "dismissed", value: String(dismissed)),
                     URLQueryItem(name: "limit", value: String(limit)), URLQueryItem(name: "offset", value: String(offset))]
        if let kind { query.append(URLQueryItem(name: "kind", value: kind.rawValue)) }
        if closedByLabel { query.append(URLQueryItem(name: "closedByLabel", value: "true")) }
        if let sessionId { query.append(URLQueryItem(name: "sessionId", value: sessionId)) }
        return try await missionRequest(["tracked-items"], query: query)
    }

    func updateTrackedItem(_ id: String, _ patch: TrackedItemPatch) async throws -> TrackedItem {
        try await call(url: missionURL(["tracked-items", id]), method: "PATCH", body: patch)
    }

    func trackedItemPrefill(_ id: String) async throws -> TrackedItemPrefill {
        try await missionRequest(["tracked-items", id, "prefill"])
    }

    /// One triage item, as a chat's source chip opens it in triage.
    func trackedItem(_ id: String) async throws -> TrackedItem {
        if let fixture = fixtureTracking {
            guard let item = fixture.items.first(where: { $0.id == id }) else { throw URLError(.fileDoesNotExist) }
            return item
        }
        return try await missionRequest(["tracked-items", id])
    }

    /// The Slack message behind a triage item, read from Slack on demand and never stored.
    func slackExcerpt(_ id: String) async throws -> SlackExcerpt {
        try await missionRequest(["tracked-items", id, "excerpt"])
    }

    /// Adds a Slack message from a pasted link to a project's triage. pilotd reads and classifies it, which can take
    /// a few seconds, and returns the stored item (the existing one when the message is already in triage).
    func addSlackMessage(projectId: String, url: String) async throws -> TrackedItem {
        try await missionRequest(["tracking", "slack", "messages"],
                                 body: SlackMessageAddRequest(projectId: projectId, url: url))
    }

    /// Slack messages in triage whose title, channel or thread text contain every word of the query, or the thread
    /// of a pasted Slack link. Latest first, with done and dismissed ones, so a search shows whether it was resolved.
    func searchSlack(_ query: String, projectId: String? = nil, limit: Int = 20) async throws -> TrackedItemList {
        var items = [URLQueryItem(name: "query", value: query), URLQueryItem(name: "limit", value: String(limit))]
        if let projectId { items.append(URLQueryItem(name: "projectId", value: projectId)) }
        return try await missionRequest(["tracking", "slack", "search"], query: items)
    }

    /// The project's Slack triage corrections, newest first (pilotd keeps the latest 500). The triage guide is built
    /// from them, and the classifier also reads the newest five as examples.
    func slackCorrections(projectId: String) async throws -> [SlackCorrection] {
        if let fixture = fixtureTracking { return fixture.corrections }
        return try await missionRequest(["tracking", "slack", "corrections"],
                                        query: [URLQueryItem(name: "projectId", value: projectId)])
    }

    /// The project's Linear size corrections, newest first (pilotd keeps the latest 500). They build the Linear
    /// triage guide, and the size estimator also reads the newest five.
    func linearSizeCorrections(projectId: String) async throws -> [LinearSizeCorrection] {
        if let fixture = fixtureTracking { return fixture.linearCorrections }
        return try await missionRequest(["tracking", "linear", "corrections"],
                                        query: [URLQueryItem(name: "projectId", value: projectId)])
    }

    /// A source's triage guide for the project: short rules pilotd's grooming model writes from the corrections.
    /// Untrusted text, shown read-only. An empty text with updatedAt 0 means no guide yet.
    func triageGuide(projectId: String, kind: TrackedKind) async throws -> TriageGuide {
        if let fixture = fixtureTracking { return fixture.guide(kind) }
        return try await missionRequest(["tracking", kind.rawValue, "guide"],
                                        query: [URLQueryItem(name: "projectId", value: projectId)])
    }

    /// Queues a rebuild (202) and returns the guide as it was. Saving the rebuilt guide sends tracked.changed for the
    /// project, so callers reload then instead of polling.
    func rebuildTriageGuide(projectId: String, kind: TrackedKind) async throws -> TriageGuide {
        if let fixture = fixtureTracking { return fixture.guide(kind) }
        return try await missionRequest(["tracking", kind.rawValue, "guide"], method: "POST",
                                        query: [URLQueryItem(name: "projectId", value: projectId)])
    }

    /// The project's common Slack cases: recurring bug reports from the last 30 days, by count then recency.
    func slackCases(projectId: String) async throws -> SlackCommonCaseList {
        if let fixture = fixtureTracking { return fixture.cases }
        return try await missionRequest(["tracking", "slack", "cases"],
                                        query: [URLQueryItem(name: "projectId", value: projectId)])
    }

    /// Renames, merges or splits a common case. pilotd keeps the edit as a correction and returns the new list.
    func editSlackCase(projectId: String, id: String, _ edit: SlackCaseEdit) async throws -> SlackCommonCaseList {
        if let fixture = fixtureTracking { return fixture.cases }
        return try await call(url: missionURL(["tracking", "slack", "cases", id],
                                              query: [URLQueryItem(name: "projectId", value: projectId)]),
                              method: "PATCH", body: edit)
    }

    /// Snapshot data for the Inbox page. Never used by the live app.
    var fixtureInbox: Inbox?

    /// What waits on the user in one project, or across every project. Bounded per section by pilotd.
    func inbox(projectId: String?) async throws -> Inbox {
        if let fixtureInbox { return fixtureInbox }
        return try await missionRequest(["inbox"], query: projectId.map { [URLQueryItem(name: "projectId", value: $0)] } ?? [])
    }

    private func upsert(_ project: Project) {
        projects.removeAll { $0.id == project.id }
        projects.append(project)
        projects.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// The pi model scope for a project (or folder), with pi's default model.
    func models(projectId: String?, cwd: String?, taskStart: Bool = false) async throws -> ModelList {
        if let fixtureModels { return fixtureModels }
        guard let baseURL, var components = URLComponents(url: baseURL.appending(path: "api/models"), resolvingAgainstBaseURL: false)
        else { throw ClientError("pilotd is not connected") }
        if let projectId { components.queryItems = [URLQueryItem(name: "projectId", value: projectId)] }
        else if let cwd, !cwd.isEmpty { components.queryItems = [URLQueryItem(name: "cwd", value: cwd)] }
        if taskStart {
            components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "purpose", value: "task-start")]
        }
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            throw ClientError((try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "HTTP \(status)")
        }
        let list = try JSONDecoder().decode(ModelList.self, from: data)
        if !taskStart { modelCache.store(list, for: ModelListCache.key(projectId: projectId, cwd: cwd)) }
        return list
    }

    /// The last list fetched for this scope, if any. Callers show it at once and then revalidate.
    func cachedModels(projectId: String?, cwd: String?) -> ModelList? {
        if let fixtureModels { return fixtureModels }
        return modelCache.list(for: ModelListCache.key(projectId: projectId, cwd: cwd))
    }

    /// Not published: a cache write must never re-render views on its own.
    private var modelCache = ModelListCache()
    var fixtureModels: ModelList?
    var fixtureBranches: RemoteBranchList?

    func remoteBranches(_ projectId: String, mode: ChatMode = .build, workspace: WorkspaceMode? = nil) async throws -> RemoteBranchList {
        if let fixtureBranches { return fixtureBranches }
        var url = try artifactURL(["projects", projectId, "branches"])
        if mode == .ask || workspace == .clone {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            components.queryItems = mode == .ask
                ? [URLQueryItem(name: "mode", value: "ask")]
                : [URLQueryItem(name: "workspace", value: "clone")]
            url = components.url!
        }
        return try await get(url)
    }

    func projectGitHubURL(_ projectId: String) async throws -> URL {
        let repository: ProjectGitHubRepository = try await call(URLRequest(url: artifactURL(["projects", projectId, "github"])))
        guard let url = repository.browserURL else { throw ClientError("Invalid GitHub repository link") }
        return url
    }

    func projectOrigin(_ projectId: String) async throws -> ProjectOrigin {
        if let fixture = fixtureProjectOrigins[projectId] { return fixture }
        return try await call(URLRequest(url: artifactURL(["projects", projectId, "origin"])))
    }

    /// Read-only discovery from the project's checkout on its host. Requires hello.capabilities.environmentSetup.
    func environmentDiscovery(_ projectId: String) async throws -> EnvironmentDiscovery {
        try await call(URLRequest(url: artifactURL(["projects", projectId, "environment", "discovery"])))
    }

    /// The host's install plan preview for the saved profile. Probing changes nothing on the host.
    func environmentPlan(_ projectId: String) async throws -> EnvironmentPlan {
        try await call(URLRequest(url: artifactURL(["projects", projectId, "environment", "plan"])))
    }

    /// Tool names from the host's mise registry, for adding tools to a profile.
    func environmentTools() async throws -> EnvironmentToolCatalog {
        try await call(URLRequest(url: artifactURL(["environment", "tools"])))
    }

    /// Replace the profile. The daemon refuses a stale revision with 409.
    func updateEnvironment(_ projectId: String, _ request: ProjectEnvironmentUpdateRequest) async throws -> ProjectEnvironment {
        try await call("api/projects/\(projectId)/environment", method: "PUT", body: request)
    }

    var fixtureChanges: SessionChanges?
    var fixtureChangeSummaries: [String: SessionChangeSummary] = [:]

    func refreshRepositoryCaches() {
        branchCache.clearValues()
        summaryCache.clearValues()
        changesCache.clearValues()
    }

    /// Regular row refreshes read only the branch; line counts are requested on hover.
    func repositoryBranch(_ sessionId: String) async throws -> SessionBranch {
        if let fixture = fixtureChangeSummaries[sessionId] { return SessionBranch(branch: fixture.branch) }
        return try await branchCache.value(for: sessionId) { [self] in
            try await fetchRepositoryMetadata(sessionId, kind: "branch")
        }
    }

    /// Tooltip metadata only, without computing or transferring full diffs.
    func changeSummary(_ sessionId: String) async throws -> SessionChangeSummary {
        if let fixture = fixtureChangeSummaries[sessionId] { return fixture }
        return try await summaryCache.value(for: sessionId) { [self] in
            try await fetchRepositoryMetadata(sessionId, kind: "summary")
        }
    }

    private func fetchRepositoryMetadata<Value: Decodable & Sendable>(_ sessionId: String, kind: String) async throws -> Value {
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        let url = baseURL.appending(path: "api/sessions/\(sessionId)/changes/\(kind)")
        let (data, response) = try await repositoryRequests.perform {
            try await artifactSession.data(from: url)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            throw ClientError((try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "HTTP \(status)")
        }
        return try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(Value.self, from: data)
        }.value
    }

    /// The session's working copy against the point it branched from.
    func changes(_ sessionId: String) async throws -> SessionChanges {
        if let fixtureChanges { return fixtureChanges }
        return try await changesCache.value(for: sessionId) { [self] in
            try await fetchChanges(sessionId)
        }
    }

    private func fetchChanges(_ sessionId: String) async throws -> SessionChanges {
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        let (data, response) = try await repositoryRequests.perform {
            try await artifactSession.data(from: baseURL.appending(path: "api/sessions/\(sessionId)/changes"))
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            throw ClientError((try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "HTTP \(status)")
        }
        return try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(SessionChanges.self, from: data)
        }.value
    }

    func sessionArtifacts(_ sessionId: String) async throws -> [ArtifactSummary] {
        let version = artifactVersions[sessionId, default: 0]
        let list: [ArtifactSummary] = try await get(artifactURL(["sessions", sessionId, "artifacts"]))
        guard list.allSatisfy({ $0.sessionId == sessionId }) else { throw ClientError("Invalid artifact list") }
        // A WS update received while GET was pending is newer than that response.
        if artifactVersions[sessionId, default: 0] == version { artifacts[sessionId] = list }
        return artifacts[sessionId] ?? list
    }

    func projectArtifacts(_ projectId: String) async throws -> [ArtifactSummary] {
        try await get(artifactURL(["projects", projectId, "artifacts"]))
    }

    func resolveArtifact(_ link: ArtifactLink) async throws -> ArtifactReference {
        let result: ArtifactSummary = try await get(artifactURL(["artifacts", link.id]))
        guard result.id == link.id, !result.sessionId.isEmpty, result.revision > 0 else {
            throw ClientError("Invalid artifact reference")
        }
        return result.reference
    }

    func artifact(_ reference: ArtifactReference, latest: Bool = false) async throws -> ArtifactRevision {
        var components = URLComponents(url: try artifactURL(["sessions", reference.sessionId, "artifacts", reference.id]),
                                       resolvingAgainstBaseURL: false)!
        if !latest { components.queryItems = [URLQueryItem(name: "revision", value: String(reference.revision))] }
        let result: ArtifactRevision = try await get(components.url!)
        guard result.id == reference.id, result.sessionId == reference.sessionId,
              latest || result.revision == reference.revision else { throw ClientError("Invalid artifact revision") }
        return result
    }

    /// Called only by the allowlisted scheme handler, never with a web-supplied path.
    func artifactLibraryURL(_ library: ArtifactLibrary) throws -> URL {
        guard !disconnected else { throw HostRoutingError.disconnected }
        return try artifactURL(["artifact-libraries", library.rawValue])
    }

    private func artifactURL(_ components: [String]) throws -> URL {
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        var url = baseURL.appendingPathComponent("api")
        for component in components {
            guard !component.isEmpty, component != ".", component != "..",
                  component.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\?#%")) == nil
            else { throw ClientError("Invalid artifact identifier") }
            url.appendPathComponent(component)
        }
        return url
    }

    private func get<Response: Decodable & Sendable>(_ url: URL) async throws -> Response {
        guard !disconnected else { throw HostRoutingError.disconnected }
        guard activeReads < 4 else { throw ClientError("Host reads are busy") }
        activeReads += 1
        defer { activeReads -= 1 }
        let generation = connectionGeneration
        var request = URLRequest(url: url)
        PilotTraceContext.injectCurrent(into: &request)
        let (data, response) = try await BoundedHTTPData.read(request, maximumBytes: 48 * 1024 * 1024,
                                                            configuration: artifactSession.configuration)
        guard generation == connectionGeneration, !disconnected else { throw HostRoutingError.staleGeneration }
        let status = response.statusCode
        guard (200 ..< 300).contains(status) else {
            let error = (try? JSONDecoder().decode(APIError.self, from: data))?.error
            // Older running daemons can serve chats but have no artifact routes. Do not
            // restart them automatically: that would interrupt active agents.
            if status == 404, error == "Not found" {
                throw ClientError("This pilotd does not support artifacts. Once agents are idle, restart pilotd from the Pilot menu to load the current runtime.")
            }
            throw ClientError(error ?? "HTTP \(status)")
        }
        let value = try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(Response.self, from: data)
        }.value
        guard generation == connectionGeneration, !disconnected else { throw HostRoutingError.staleGeneration }
        return value
    }

    private struct Ack: Decodable, Sendable {}
    private struct APIError: Decodable { let error: String }

    private func call<Response: Decodable>(_ path: String, method: String = "POST") async throws -> Response {
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        return try await call(request)
    }

    private func call<Body: Encodable, Response: Decodable>(
        _ path: String,
        method: String = "POST",
        body: Body
    ) async throws -> Response {
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        return try await call(url: baseURL.appending(path: path), method: method, body: body)
    }

    private func call<Body: Encodable, Response: Decodable>(
        url: URL,
        method: String = "POST",
        body: Body
    ) async throws -> Response {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await call(request)
    }

    private func call<Response: Decodable>(_ originalRequest: URLRequest, maximumDuration: TimeInterval? = nil) async throws -> Response {
        guard !disconnected else { throw HostRoutingError.disconnected }
        let generation = connectionGeneration
        var request = originalRequest
        PilotTraceContext.injectCurrent(into: &request)
        let configuration: URLSessionConfiguration
        if let maximumDuration, let bounded = commandConfiguration.copy() as? URLSessionConfiguration {
            bounded.timeoutIntervalForRequest = maximumDuration
            bounded.timeoutIntervalForResource = maximumDuration
            configuration = bounded
        } else { configuration = commandConfiguration }
        let (data, response) = try await BoundedHTTPData.read(request, maximumBytes: 4 * 1024 * 1024,
                                                            configuration: configuration)
        guard generation == connectionGeneration, !disconnected else { throw HostRoutingError.staleGeneration }
        let status = response.statusCode
        guard (200 ..< 300).contains(status) else {
            throw ClientError((try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "HTTP \(status)", status: status)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    func loadPowerStatus() async throws {
        powerStatus = try await call("api/power", method: "GET")
    }

    func updatePowerSettings(_ settings: PowerSettings) async throws {
        powerStatus = try await call("api/power", method: "PATCH", body: settings)
    }

    // MARK: MCP servers

    // MARK: Pre-chat host setup. Explicit mutations are never queued/retried or sent to Local as fallback.

    func githubRequest<Body: Encodable, Response: Decodable>(_ path: String, capability: String,
                                                            body: Body?, method: String = "POST") async throws -> Response {
        guard let baseURL else { throw HostRoutingError.disconnected }
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue(capability, forHTTPHeaderField: "X-Pilot-GitHub-Capability")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        return try await call(request)
    }

    func runtimeUpdate(_ id: String? = nil) async throws -> RuntimeUpdateStatus? {
        try await missionRequest(["runtime-update"], query: id.map { [URLQueryItem(name: "id", value: $0)] } ?? [])
    }

    func cancelRuntimeUpdate(_ id: String) async throws -> RuntimeUpdateCancellation {
        try await missionRequest(["runtime-update", "cancel"], body: ["id": id])
    }

    func setupReadiness() async throws -> SetupReadiness {
        try await missionRequest(["setup"])
    }

    func machineInformation() async throws -> MachineInformation {
        try await missionRequest(["machine"])
    }

    func setupRuns() async throws -> [SetupRun] {
        try await missionRequest(["setup", "runs"])
    }

    func startSetup(_ request: SetupStartRequest) async throws -> SetupRun {
        try await missionRequest(["setup", "runs"], body: request)
    }

    func setupRun(_ id: String) async throws -> SetupRun {
        try await missionRequest(["setup", "runs", id])
    }

    func cancelSetup(_ id: String) async throws -> SetupRun {
        try await missionRequest(["setup", "runs", id], method: "DELETE")
    }

    func logoutSetupProvider(_ provider: String) async throws -> SetupCredentialStatus {
        try await missionRequest(["setup", "providers", provider, "credential"], method: "DELETE")
    }

    func attachSetup(_ id: String, receive: @escaping (SetupServerMessage) -> Void) throws -> SetupTerminalConnection {
        guard connected, !disconnected, let url = socketURL("/api/setup/runs/\(Self.pathSegment(id))/terminal/ws"),
              setupSockets[id] != nil || setupSockets.count < 4 else { throw HostRoutingError.disconnected }
        setupSockets.removeValue(forKey: id)?.close()
        let generation = connectionGeneration
        let connection = SetupTerminalConnection(url: url, configuration: commandConfiguration,
            isCurrent: { [weak self] in self?.connectionGeneration == generation && self?.connected == true && self?.disconnected == false },
            receive: receive, onClose: { [weak self] in _ = self?.setupSockets.removeValue(forKey: id) })
        setupSockets[id] = connection
        return connection
    }

    func detachSetup(_ id: String) { setupSockets.removeValue(forKey: id)?.close() }

    private func closeSetupAttachments() {
        let connections = Array(setupSockets.values)
        setupSockets.removeAll()
        for connection in connections { connection.close() }
    }

    /// Recheck every server, or one. Results arrive over the control socket.
    func checkMcp(server: String? = nil) async {
        if mcp.fixture { return }
        do {
            mcp.record(try await missionRequest(["mcp", "check"], body: McpCheckRequest(server: server)))
        } catch {
            mcp.actionError = "Couldn't check MCP servers. \(error.localizedDescription)"
        }
    }

    /// pilotd runs pi's MCP OAuth login for the server and opens the browser. Progress arrives with the status.
    func startMcpSignIn(_ name: String, again: Bool = false) async {
        let now = Date().timeIntervalSince1970 * 1000
        if mcp.fixture {
            return mcp.recordSignIn(name, McpSignInState(state: .waiting, again: again, startedAt: now,
                                                         expiresAt: now + 300_000))
        }
        do {
            let state: McpSignInState = try await missionRequest(["mcp", "servers", name, "sign-in"],
                                                                 body: McpSignInRequest(again: again))
            mcp.recordSignIn(name, state)
        } catch {
            mcp.recordSignIn(name, McpSignInState(state: .failed, again: again, startedAt: now, expiresAt: now,
                                                  finishedAt: now,
                                                  error: "Couldn't start sign-in. \(error.localizedDescription)"))
        }
    }

    func cancelMcpSignIn(_ name: String) async {
        guard let current = mcp.status?.server(named: name)?.signIn, current.state == .waiting else { return }
        let cancelled = McpSignInState(state: .cancelled, again: current.again, startedAt: current.startedAt,
                                       expiresAt: current.expiresAt, finishedAt: Date().timeIntervalSince1970 * 1000)
        if mcp.fixture { return mcp.recordSignIn(name, cancelled) }
        do {
            let state: McpSignInState? = try await missionRequest(["mcp", "servers", name, "sign-in"], method: "DELETE")
            mcp.recordSignIn(name, state ?? cancelled)
        } catch {
            // Already finished or pilotd restarted: either way nothing waits anymore.
            mcp.recordSignIn(name, cancelled)
        }
    }

    // MARK: Missions

    /// Keeps a project's dashboard live while a view shows it. Balance with `releaseDashboard`.
    func retainDashboard(_ projectId: String) {
        dashboardRefs[projectId, default: 0] += 1
        if dashboardRefs[projectId] == 1, !fixtureDashboards {
            post(["type": .string("dashboard.subscribe"), "projectId": .string(projectId)])
        }
    }

    func releaseDashboard(_ projectId: String) {
        guard let count = dashboardRefs[projectId] else { return }
        if count > 1 { dashboardRefs[projectId] = count - 1; return }
        dashboardRefs[projectId] = nil
        guard !fixtureDashboards else { return }
        projectDashboards[projectId] = nil
        dashboardReceivedAt[projectId] = nil
        dashboardErrors[projectId] = nil
        post(["type": .string("dashboard.unsubscribe"), "projectId": .string(projectId)])
    }

    /// One explicit read of a subscribed dashboard, for Retry. Live updates still come over the socket.
    func refreshDashboard(_ projectId: String) async {
        guard dashboardRefs[projectId] != nil, !fixtureDashboards else { return }
        do {
            let url = try missionURL(["projects", projectId, "dashboard"])
            let dashboard: ProjectDashboard = try await call(URLRequest(url: url))
            guard dashboardRefs[projectId] != nil else { return }
            receive(dashboard)
        } catch {
            guard dashboardRefs[projectId] != nil else { return }
            dashboardErrors[projectId] = error.localizedDescription
        }
    }

    /// A one-time bounded read for a project section's full-list destination. Live updates remain on WS.
    func fullProjectDashboard(_ projectId: String) async throws -> ProjectDashboard {
        let url = try missionURL(["projects", projectId, "dashboard"])
        var request = URLRequest(url: url)
        request.url?.append(queryItems: [URLQueryItem(name: "limit", value: "100")])
        return try await call(request)
    }

    /// A bounded slice of the memory tree: the top-level blocks (or one range's children) to `depth` levels, or only
    /// the paths to `reveal`ed notes.
    func memoryTree(_ projectId: String, range: MemoryRange?, depth: Int, reveal: [Int]) async throws -> MemoryTree {
        var query = [URLQueryItem(name: "depth", value: String(depth))]
        if let range {
            query += [URLQueryItem(name: "lo", value: String(range.lo)), URLQueryItem(name: "hi", value: String(range.hi))]
        }
        if !reveal.isEmpty {
            query.append(URLQueryItem(name: "reveal", value: reveal.map(String.init).joined(separator: ",")))
        }
        return try await missionRequest(["projects", projectId, "memory", "tree"], query: query)
    }

    func memoryRecall(_ projectId: String, regex: String) async throws -> MemoryRecall {
        try await missionRequest(["projects", projectId, "memory", "recall"], query: [
            URLQueryItem(name: "regex", value: regex), URLQueryItem(name: "lines", value: "96"),
        ])
    }

    func forgetMemory(_ projectId: String, lo: Int, hi: Int) async throws {
        let _: Ack = try await missionRequest(["projects", projectId, "memory", "forget"], method: "POST",
                                               body: MemoryRange(lo: lo, hi: hi))
    }

    private func receive(_ dashboard: ProjectDashboard) {
        projectDashboards[dashboard.projectId] = dashboard
        dashboardReceivedAt[dashboard.projectId] = Date()
        dashboardErrors[dashboard.projectId] = nil
    }

    /// Keeps a mission's detail live while a view shows it. Balance with `releaseMission`.
    func retainMission(_ id: String) {
        missionRefs[id, default: 0] += 1
        if missionRefs[id] == 1, !fixtureMissions {
            post(["type": .string("mission.subscribe"), "missionId": .string(id)])
        }
    }

    func releaseMission(_ id: String) {
        guard let count = missionRefs[id] else { return }
        if count > 1 { missionRefs[id] = count - 1; return }
        missionRefs[id] = nil
        guard !fixtureMissions else { return }
        missionDetails[id] = nil
        post(["type": .string("mission.unsubscribe"), "missionId": .string(id)])
    }

    private func applyMissions(_ list: [Mission]) {
        missions = list
        let known = Set(list.map(\.id))
        for id in missionDetails.keys where !known.contains(id) { missionDetails[id] = nil }
    }

    private func upsert(_ mission: Mission) {
        if let index = missions.firstIndex(where: { $0.id == mission.id }) { missions[index] = mission }
        else { missions.append(mission) }
    }

    private func missionURL(_ components: [String], query: [URLQueryItem] = []) throws -> URL {
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        var url = baseURL.appendingPathComponent("api")
        for component in components {
            guard !component.isEmpty, component != ".", component != "..",
                  component.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\?#%")) == nil
            else { throw ClientError("Invalid mission identifier") }
            url.appendPathComponent(component)
        }
        guard !query.isEmpty, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        parts.queryItems = query
        return parts.url ?? url
    }

    private func missionRequest<Response: Decodable>(_ components: [String], method: String = "GET",
                                                     query: [URLQueryItem] = []) async throws -> Response {
        var request = URLRequest(url: try missionURL(components, query: query))
        request.httpMethod = method
        return try await call(request)
    }

    private func missionRequest<Body: Encodable, Response: Decodable>(
        _ components: [String], method: String = "POST", body: Body
    ) async throws -> Response {
        try await call(url: missionURL(components), method: method, body: body)
    }

    func missionList(projectId: String? = nil) async throws -> [Mission] {
        try await missionRequest(["missions"], query: projectId.map { [URLQueryItem(name: "projectId", value: $0)] } ?? [])
    }

    func createMission(_ request: CreateMissionRequest) async throws -> MissionDetail {
        let detail: MissionDetail = try await missionRequest(["missions"], body: request)
        upsert(detail.mission)
        if let id = detail.mission.coordinatorSessionId, request.startCoordinator == true {
            let session: SessionSummary = try await call("api/sessions/\(id)", method: "GET")
            awaitingList[id] = session
            update(session)
        }
        if missionRefs[detail.mission.id] != nil { missionDetails[detail.mission.id] = detail }
        return detail
    }

    func missionDetail(_ id: String) async throws -> MissionDetail {
        if fixtureMissions, let detail = missionDetails[id] { return detail }
        return try await missionRequest(["missions", id])
    }

    @discardableResult
    func updateMission(_ id: String, _ request: UpdateMissionRequest) async throws -> Mission {
        let mission: Mission = try await missionRequest(["missions", id], method: "PATCH", body: request)
        upsert(mission)
        return mission
    }

    func deleteMission(_ id: String) async throws {
        let _: Ack = try await missionRequest(["missions", id], method: "DELETE")
        missions.removeAll { $0.id == id }
        missionDetails[id] = nil
    }

    /// Nil before the first save.
    func missionBrief(_ id: String, revision: Int? = nil) async throws -> MissionBrief? {
        do {
            return try await missionRequest(["missions", id, "brief"],
                                            query: revision.map { [URLQueryItem(name: "revision", value: String($0))] } ?? [])
        } catch let error as ClientError where error.status == 404 {
            return nil
        }
    }

    /// Throws a ClientError with status 409 when the expected revision is stale.
    func saveMissionBrief(_ id: String, _ write: MissionBriefWrite) async throws -> MissionBrief {
        try await missionRequest(["missions", id, "brief"], method: "PUT", body: write)
    }

    func missionBriefRevisions(_ id: String) async throws -> [MissionBriefRevision] {
        try await missionRequest(["missions", id, "brief", "revisions"])
    }

    @discardableResult
    func createMissionTask(_ id: String, _ write: MissionTaskWrite) async throws -> MissionTask {
        try await missionRequest(["missions", id, "tasks"], body: write)
    }

    @discardableResult
    func updateMissionTask(_ id: String, taskId: String, _ write: MissionTaskWrite) async throws -> MissionTask {
        try await missionRequest(["missions", id, "tasks", taskId], method: "PATCH", body: write)
    }

    func deleteMissionTask(_ id: String, taskId: String) async throws {
        let _: Ack = try await missionRequest(["missions", id, "tasks", taskId], method: "DELETE")
    }

    @discardableResult
    func createMissionPhase(_ id: String, _ write: MissionPhaseWrite) async throws -> MissionPhase {
        try await missionRequest(["missions", id, "phases"], body: write)
    }

    @discardableResult
    func updateMissionPhase(_ id: String, phaseId: String, _ write: MissionPhaseWrite) async throws -> MissionPhase {
        try await missionRequest(["missions", id, "phases", phaseId], method: "PATCH", body: write)
    }

    /// The phase's tasks move to no phase.
    func deleteMissionPhase(_ id: String, phaseId: String) async throws {
        let _: Ack = try await missionRequest(["missions", id, "phases", phaseId], method: "DELETE")
    }

    func startMissionCoordinator(_ id: String, _ request: StartMissionCoordinatorRequest) async throws -> SessionSummary {
        let session: SessionSummary = try await missionRequest(["missions", id, "coordinator", "start"], body: request)
        awaitingList[session.id] = session
        update(session)
        return session
    }

    /// A new chat in the mission's project that joins the mission and claims the task.
    func startMissionTask(_ id: String, taskId: String,
                          _ request: StartMissionTaskRequest = StartMissionTaskRequest()) async throws -> SessionSummary {
        let session: SessionSummary = try await missionRequest(["missions", id, "tasks", taskId, "start"], body: request)
        if self.session(session.id) == nil {
            awaitingList[session.id] = session
            update(session)
        }
        return session
    }

    @discardableResult
    func addMissionDecision(_ id: String, text: String,
                            audience: MissionDecisionAudience = .reference) async throws -> MissionDecision {
        try await missionRequest(["missions", id, "decisions"], body: MissionDecisionWrite(text: text, audience: audience))
    }

    @discardableResult
    func updateMissionDecision(_ id: String, decisionId: String, text: String? = nil,
                               audience: MissionDecisionAudience? = nil) async throws -> MissionDecision {
        try await missionRequest(["missions", id, "decisions", decisionId], method: "PATCH",
                                 body: MissionDecisionWrite(text: text, audience: audience))
    }

    @discardableResult
    func resolveMissionDecisionProposal(_ id: String, proposalId: String, accept: Bool,
                                        text: String? = nil) async throws -> MissionDecisionProposal {
        try await missionRequest(["missions", id, "decision-proposals", proposalId, accept ? "accept" : "reject"],
                                 body: MissionDecisionWrite(text: text))
    }

    func deleteMissionDecision(_ id: String, decisionId: String) async throws {
        let _: Ack = try await missionRequest(["missions", id, "decisions", decisionId], method: "DELETE")
    }

    @discardableResult
    func addMissionComment(_ id: String, _ write: MissionCommentWrite) async throws -> MissionComment {
        try await missionRequest(["missions", id, "comments"], body: write)
    }

    @discardableResult
    func resolveMissionComment(_ id: String, commentId: String) async throws -> MissionComment {
        try await missionRequest(["missions", id, "comments", commentId, "resolve"], body: [String: String]())
    }

    func deleteMissionComment(_ id: String, commentId: String) async throws {
        let _: Ack = try await missionRequest(["missions", id, "comments", commentId], method: "DELETE")
    }

    @discardableResult
    func addMissionResource(_ id: String, _ write: MissionResourceWrite) async throws -> MissionResource {
        try await missionRequest(["missions", id, "resources"], body: write)
    }

    func deleteMissionResource(_ id: String, resourceId: String) async throws {
        let _: Ack = try await missionRequest(["missions", id, "resources", resourceId], method: "DELETE")
    }

    /// Explicitly changes a Linear link's role: manage a ticket, count a task toward it, or make it a reference.
    @discardableResult
    func updateMissionResource(_ id: String, resourceId: String, _ write: MissionResourceUpdate) async throws
        -> MissionResource {
        try await missionRequest(["missions", id, "resources", resourceId], method: "PATCH", body: write)
    }

    /// Pauses or resumes Pilot's Linear updates for a managed ticket. Resuming accepts the ticket's current tasks
    /// and Linear status, and retries a failed update.
    @discardableResult
    func setMissionLinearSync(_ id: String, resourceId: String, action: MissionLinearSyncAction) async throws
        -> MissionResource {
        try await missionRequest(["missions", id, "resources", resourceId, "linear-sync"],
                                 body: MissionLinearSyncWrite(action: action.rawValue))
    }

    @discardableResult
    func linkMissionArtifact(_ id: String, _ write: MissionArtifactLinkWrite) async throws -> MissionArtifactLink {
        try await missionRequest(["missions", id, "artifacts"], body: write)
    }

    func unlinkMissionArtifact(_ id: String, artifactId: String, taskId: String? = nil) async throws {
        let _: Ack = try await missionRequest(["missions", id, "artifacts", artifactId], method: "DELETE",
                                               query: taskId.map { [URLQueryItem(name: "taskId", value: $0)] } ?? [])
    }

    /// Newest first.
    func missionEvents(_ id: String, before: Int? = nil) async throws -> [MissionEvent] {
        try await missionRequest(["missions", id, "events"],
                                 query: before.map { [URLQueryItem(name: "before", value: String($0))] } ?? [])
    }

    @discardableResult
    func postMissionEvent(_ id: String, _ write: MissionEventWrite) async throws -> MissionEvent {
        try await missionRequest(["missions", id, "events"], body: write)
    }

    @discardableResult
    func joinMission(_ sessionId: String, _ request: JoinMissionRequest) async throws -> SessionSummary {
        let session: SessionSummary = try await missionRequest(["sessions", sessionId, "mission"], method: "PUT", body: request)
        update(session)
        return session
    }

    @discardableResult
    func leaveMission(_ sessionId: String) async throws -> SessionSummary {
        let session: SessionSummary = try await missionRequest(["sessions", sessionId, "mission"], method: "DELETE")
        update(session)
        return session
    }

    // MARK: Event streams

    /// The first batch delivered is always a snapshot, including after reconnects. Each subscribed chat has
    /// its own socket, so a large or slow chat never delays another.
    func subscribe(_ sessionId: String, trace: PilotTraceCarrier? = nil,
                   _ listener: @escaping ([JSONValue]) -> Void) -> UUID {
        let token = UUID()
        let first = listeners[sessionId]?.isEmpty ?? true
        listeners[sessionId, default: [:]][token] = listener
        if first { openChat(sessionId, trace: trace) }
        return token
    }

    func unsubscribe(_ sessionId: String, token: UUID) {
        listeners[sessionId]?[token] = nil
        if listeners[sessionId]?.isEmpty ?? false {
            listeners[sessionId] = nil
            closeChat(sessionId)
        }
    }

    private func openChat(_ sessionId: String, trace: PilotTraceCarrier? = nil) {
        guard chats[sessionId] == nil else { return }
        let chat = ChatStream()
        chat.socket = StreamSocket(
            url: { [weak self, weak chat] in
                guard let self, let chat else { return nil }
                var query: [URLQueryItem] = []
                // Resume where the last connection stopped. pilotd falls back to a snapshot if it cannot.
                if let stream = chat.streamId, chat.seq > 0 {
                    query = [URLQueryItem(name: "stream", value: stream), URLQueryItem(name: "after", value: String(chat.seq))]
                }
                return self.socketURL("/api/sessions/\(Self.pathSegment(sessionId))/ws", query: query)
            }, traceparent: trace?.traceparent,
            receive: { [weak self, weak chat] updates in
                guard let self, let chat, self.chats[sessionId] === chat else { return }
                // Only this chat's stream and artifact index travel on its socket.
                for update in updates {
                    switch update {
                    case let .chatStream(id, stream, resumed) where id == sessionId:
                        chat.streamId = stream
                        if !resumed { chat.seq = 0 }
                    case let .events(id, _, seq) where id == sessionId:
                        if let seq { chat.seq = seq }
                        self.handle(update)
                    case let .artifacts(message) where message.sessionId == sessionId:
                        self.handle(update)
                    default: break
                    }
                }
            }
        )
        chats[sessionId] = chat
        chat.socket?.connect()
    }

    private func closeChat(_ sessionId: String) {
        chats.removeValue(forKey: sessionId)?.socket?.close()
    }

    /// One opaque path segment: IDs and subagent names may contain any text, including slashes.
    private static func pathSegment(_ value: String) -> String {
        var unreserved = CharacterSet.alphanumerics
        unreserved.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    private func socketURL(_ percentEncodedPath: String, query: [URLQueryItem] = [], controlSocket: Bool = false) -> URL? {
        // Remote streams wait for the control connection's freshly pinned hello on every reconnect.
        if let host = hostIdentity, host.hostId != "local", !controlSocket, !connected { return nil }
        guard let baseURL, var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.percentEncodedPath = percentEncodedPath
        components.queryItems = query.isEmpty ? nil : query
        return components.url
    }
    /// Ask the daemon to recheck pull requests of the chats currently open in the app.
    private func postFocus() {
        let ids = listeners.keys.prefix(50).map(JSONValue.string)
        guard !ids.isEmpty else { return }
        post(["type": .string("focus"), "sessionIds": .array(ids)])
    }

    // MARK: Terminals (daemon-owned PTYs)

    /// Attach on the terminal's own socket. Reconnects reattach without restarting, replaying the scrollback.
    func attachTerminal(_ sessionId: String, cols: Int, rows: Int, restart: Bool = false,
                        intent: WorkspaceTerminalIntent? = nil, _ attachment: TerminalAttachment) {
        guard terminals[sessionId] != nil || terminals.count < 16 else {
            attachment.onStatus(.unavailable("Too many attached shells")); return
        }
        let intent = intent ?? WorkspaceTerminalIntent(restart: restart)
        terminalIntents[sessionId] = intent
        terminals[sessionId] = attachment
        terminalSockets.removeValue(forKey: sessionId)?.close()
        let socket = StreamSocket(
            url: { [weak self] in
                guard let self, let attachment = self.terminals[sessionId] else { return nil }
                guard self.workspaceTerminalProtocol == 2 else {
                    if self.workspaceTerminalProtocol != nil {
                        attachment.onStatus(.unavailable("Update this host runtime to use instance-safe workspace shells."))
                    }
                    return nil
                }
                let query = [
                    URLQueryItem(name: "protocol", value: "2"),
                    URLQueryItem(name: "cols", value: String(attachment.cols)),
                    URLQueryItem(name: "rows", value: String(attachment.rows)),
                ]
                return self.socketURL("/api/sessions/\(Self.pathSegment(sessionId))/terminal/ws", query: query)
            },
            willConnect: { [weak self] in
                self?.terminalReady.remove(sessionId)
                self?.terminals[sessionId]?.onStatus(.connecting)
            },
            terminalBudget: true,
            unavailable: { [weak self] in
                self?.terminalReady.remove(sessionId)
                self?.terminals[sessionId]?.onStatus(.disconnected)
            },
            receive: { [weak self] updates in
                guard let self else { return }
                for update in updates {
                    switch update {
                    case let .terminalHello(id, bootId, currentId) where id == sessionId:
                        guard intent.bootId == nil || intent.bootId == bootId else {
                            self.terminals[id]?.onStatus(.unavailable("The daemon restarted. Open a new shell explicitly."))
                            self.terminalSockets[id]?.close()
                            continue
                        }
                        if intent.bootId == nil { intent.terminalId = currentId }
                        intent.bootId = bootId
                        var open: [String: JSONValue] = ["type": .string("terminal.open"),
                            "bootId": .string(bootId), "requestId": .string(intent.requestId), "restart": .bool(intent.restart)]
                        if let terminalId = intent.terminalId { open["terminalId"] = .string(terminalId) }
                        self.terminalSockets[id]?.send(open)
                    case let .terminalReady(id, terminalId) where id == sessionId:
                        intent.terminalId = terminalId
                        self.terminalReady.insert(id)
                        self.terminals[id]?.onReplay()
                        self.terminals[id]?.onStatus(.connected)
                    case let .terminalData(id, _) where id == sessionId: self.handle(update)
                    case let .terminalExit(id, _) where id == sessionId:
                        self.terminalReady.remove(id)
                        self.handle(update)
                    case let .error(id?, _, message) where id == sessionId:
                        self.terminalReady.remove(id)
                        self.terminals[id]?.onStatus(.unavailable(message))
                    default: break
                    }
                }
            }
        )
        terminalSockets[sessionId] = socket
        socket.connect()
    }

    func detachTerminal(_ sessionId: String) {
        guard terminals.removeValue(forKey: sessionId) != nil else { return }
        terminalSockets.removeValue(forKey: sessionId)?.close()
        terminalIntents[sessionId] = nil
        terminalReady.remove(sessionId)
    }

    @discardableResult func terminalInput(_ sessionId: String, _ data: Data) -> Bool {
        guard terminalReady.contains(sessionId), data.count <= 16 * 1024,
              let text = String(data: data, encoding: .utf8), let id = terminalIntents[sessionId]?.terminalId else { return false }
        return terminalSockets[sessionId]?.send(["type": .string("terminal.input"), "terminalId": .string(id),
            "data": .string(text)]) ?? false
    }

    func terminalResize(_ sessionId: String, cols: Int, rows: Int) {
        guard cols > 0, rows > 0, cols <= 1000, rows <= 1000 else { return }
        terminals[sessionId]?.cols = cols
        terminals[sessionId]?.rows = rows
        guard terminalReady.contains(sessionId), let id = terminalIntents[sessionId]?.terminalId else { return }
        terminalSockets[sessionId]?.send([
            "type": .string("terminal.resize"), "terminalId": .string(id), "cols": .number(Double(cols)), "rows": .number(Double(rows)),
        ])
    }
    @discardableResult func closeTerminal(_ sessionId: String) -> Bool {
        guard terminalReady.contains(sessionId), let id = terminalIntents[sessionId]?.terminalId else { return false }
        let sent = terminalSockets[sessionId]?.send(["type": .string("terminal.close"), "terminalId": .string(id)]) ?? false
        if sent { terminalReady.remove(sessionId); terminals[sessionId]?.onStatus(.closing) }
        return sent
    }
    func terminalReadPaused(_ sessionId: String, _ paused: Bool) {
        terminalSockets[sessionId]?.setReadPaused(paused)
    }
    private func post(_ message: [String: JSONValue]) {
        guard connected, let control, let data = try? JSONEncoder().encode(JSONValue.object(message)) else { return }
        control.task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
    }

    private func open() {
        closeSetupAttachments()
        guard !disconnected else { return }
        connectionGeneration = UUID()
        workspaceTerminalProtocol = nil
        hasProjectSnapshot = false
        hasSessionSnapshot = false
        hasMissionSnapshot = false
        control?.cancel()
        control = nil
        if let host = hostIdentity, host.hostId != "local" {
            connected = false
            suspendStreams()
            let generation = connectionGeneration
            Task { [weak self] in
                guard let self else { return }
                do {
                    let hello = try await self.hello()
                    guard self.connectionGeneration == generation, !self.disconnected else { return }
                    try host.validate(hello)
                    self.openControlSocket()
                } catch let error as HostRoutingError where error == .identityChanged || error == .incompatible {
                    guard self.connectionGeneration == generation else { return }
                    self.connectionError = error
                    self.disconnect()
                } catch {
                    guard self.connectionGeneration == generation, !self.disconnected else { return }
                    self.scheduleReconnect()
                }
            }
        } else {
            openControlSocket()
            let generation = connectionGeneration
            // Local lists remain usable independently. Terminal support is re-negotiated on
            // every connection too, so a replaced/older Local runtime cannot receive a legacy open.
            Task { [weak self] in
                guard let self else { return }
                do {
                    _ = try await self.hello()
                    guard self.connectionGeneration == generation, !self.disconnected else { return }
                    for socket in self.terminalSockets.values { socket.retryNow() }
                } catch {
                    guard self.connectionGeneration == generation, !self.disconnected else { return }
                    for attachment in self.terminals.values {
                        attachment.onStatus(.unavailable("Could not verify workspace shell support. Reconnect to try again."))
                    }
                }
            }
        }
    }

    private func suspendStreams() {
        closeSetupAttachments()
        for chat in chats.values { chat.socket?.suspend() }
        for socket in terminalSockets.values { socket.suspend() }
        for socket in subagentSockets.values { socket.suspend() }
    }

    private func openControlSocket() {
        guard !disconnected, let url = socketURL("/api/ws", controlSocket: true) else { return }
        let reader = SocketReader(
            task: StreamSocket.task(url), label: "pilot.control-socket",
            deliver: { [weak self] reader, updates in
                guard let self, self.control === reader else { return }
                if !self.connected { self.didConnect() }
                for case let update? in updates { self.handle(update) }
            },
            failed: { [weak self] reader in
                guard let self, self.control === reader else { return }
                self.connected = false
                if let host = self.hostIdentity, host.hostId != "local" { self.suspendStreams() }
                self.scheduleReconnect()
            }
        )
        control = reader
        reader.start()
    }

    private func didConnect() {
        connected = true
        retry = 0
        onConnected?()
        // The daemon sends a fresh snapshot per subscription, so reconnects resync.
        for id in missionRefs.keys { post(["type": .string("mission.subscribe"), "missionId": .string(id)]) }
        for id in dashboardRefs.keys { post(["type": .string("dashboard.subscribe"), "projectId": .string(id)]) }
        // pilotd is back: dedicated sockets waiting out a reconnect delay retry now.
        for chat in chats.values { chat.socket?.retryNow() }
        for socket in terminalSockets.values { socket.retryNow() }
        for socket in subagentSockets.values { socket.retryNow() }
    }

    private func scheduleReconnect() {
        let generation = connectionGeneration
        control?.cancel()
        control = nil
        let delay = min(10.0, 0.5 * pow(2.0, Double(retry)))
        retry += 1
        Task {
            try? await Task.sleep(for: .seconds(delay))
            if self.control == nil, !self.disconnected, self.connectionGeneration == generation { self.open() }
        }
    }

    /// A continued chat keeps its history but takes no new work; pilotd rejects it too.
    private func ensureNotContinued(_ sessionId: String) throws {
        guard session(sessionId)?.isContinued != true else {
            throw ClientError("This chat continued in another chat and is read-only.")
        }
    }

    private func update(_ session: SessionSummary) {
        let current = self.session(session.id)
        if current?.updatedAt != session.updatedAt {
            branchCache.invalidate(session.id)
            summaryCache.invalidate(session.id)
            changesCache.invalidate(session.id)
        }
        // An unchanged summary must not invalidate every view observing the session list.
        guard current != session else { return }
        // Publish once, rather than once per removal, insertion and sort.
        var next = sessions
        next.removeAll { $0.id == session.id }
        next.append(session)
        next.sort(by: SessionSummary.listPrecedes)
        sessions = next
        onSessionsChanged?([session], false)
    }

    /// Internal, not private, so tests can deliver decoded updates without a socket.
    func handle(_ message: ServerUpdate) {
        switch message {
        case let .power(status):
            if powerStatus != status { powerStatus = status }
        case let .mcp(status):
            if !mcp.fixture { mcp.record(status) }
        case let .schedules(list):
            schedules = list
            onSchedulesChanged?(list)
        case let .sources(list):
            if trackingSources != list { trackingSources = list }
            for kind in [TrackedKind.linear, .slack] {
                if let state = list.first(where: { $0.kind == kind && $0.signIn != nil })?.signIn {
                    sourceSignIns.record(state)
                }
            }
        case let .trackedChanged(projectId):
            for observer in trackedObservers.values { observer(projectId) }
        case let .diagnosticRead(dispatch):
            onDiagnosticRead?(dispatch)
        case .sharedContextsChanged:
            onSharedContextsChanged?()
        case .watchesChanged:
            for observer in controlObservers.values { observer(.watches) }
        case .controlAuditChanged:
            for observer in controlObservers.values { observer(.audit) }
        case .controlMemoryChanged:
            for observer in controlObservers.values { observer(.memory) }
        case .dashboardChanged:
            for observer in controlObservers.values { observer(.dashboard) }
        case let .projects(list):
            projects = list
            hasProjectSnapshot = true
        case let .sessions(list):
            hasSessionSnapshot = true
            for session in list { awaitingList[session.id] = nil }
            // A list captured before POST completed must not undo immediate navigation.
            sessions = (list + Array(awaitingList.values)).sorted(by: SessionSummary.listPrecedes)
            onSessionsChanged?(sessions, true)
        case let .session(session):
            awaitingList[session.id] = nil
            update(session)
        case let .events(id, events, _):
            for listener in listeners[id]?.values ?? [:].values { listener(events) }
        case .chatStream:
            break
        case let .subagentEvents(id, name, events):
            for listener in subagentListeners[SubagentKey(sessionId: id, name: name)]?.values ?? [:].values {
                listener.events(events)
            }
        case let .artifacts(update):
            artifactVersions[update.sessionId, default: 0] += 1
            artifacts[update.sessionId] = update.artifacts
        case let .missions(list):
            hasMissionSnapshot = true
            applyMissions(list)
        case let .mission(detail):
            guard missionRefs[detail.mission.id] != nil else { break }
            missionDetails[detail.mission.id] = detail
            upsert(detail.mission)
        case let .dashboard(dashboard):
            guard dashboardRefs[dashboard.projectId] != nil else { break }
            receive(dashboard)
        case let .dashboardCounts(counts):
            projectCounts = counts
        case let .terminalData(id, data):
            terminals[id]?.onData(data)
        case let .terminalExit(id, code):
            terminals[id]?.onExit(code)
        case .terminalHello, .terminalReady:
            break
        case let .error(id, name, message):
            // Others include terminal-command failures, not agent transcript events.
            guard let id, let name else { break }
            for listener in subagentListeners[SubagentKey(sessionId: id, name: name)]?.values ?? [:].values {
                listener.error(message)
            }
        }
    }
}

struct ClientError: LocalizedError {
    let message: String
    /// HTTP status, when the daemon rejected a request.
    let status: Int?
    init(_ message: String, status: Int? = nil) {
        self.message = message
        self.status = status
    }
    var errorDescription: String? { message }
}

/// Expanded sidebars should not launch an unbounded burst of Git scans in the daemon.
@MainActor
final class RepositoryRequestLimiter {
    private let limit: Int
    private var active = 0
    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Void, Error>
    }
    private var waiting: [Waiter] = []

    init(limit: Int) {
        precondition(limit > 0)
        self.limit = limit
    }

    func perform<T>(_ operation: () async throws -> T) async throws -> T {
        try await acquire()
        defer {
            if waiting.isEmpty { active -= 1 }
            else { waiting.removeFirst().continuation.resume() }
        }
        // A disappeared row may have been queued. Release its slot without starting a request.
        try Task.checkCancellation()
        return try await operation()
    }

    private func acquire() async throws {
        try Task.checkCancellation()
        if active < limit { active += 1; return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else { waiting.append(Waiter(id: id, continuation: continuation)) }
            }
        } onCancel: {
            Task { @MainActor in self.cancel(id) }
        }
    }

    private func cancel(_ id: UUID) {
        guard let index = waiting.firstIndex(where: { $0.id == id }) else { return }
        waiting.remove(at: index).continuation.resume(throwing: CancellationError())
    }
}

/// The latest browser sign-in per tracking server, from request replies and the sources list.
@MainActor
final class SourceSignInStore: ObservableObject {
    @Published private(set) var states: [TrackedKind: SourceSignIn] = [:]

    subscript(kind: TrackedKind) -> SourceSignIn? { states[kind] }

    /// Newest wins, so a list sent before a request never reverts its reply.
    func record(_ state: SourceSignIn) {
        if let current = states[state.kind], current.startedAt > state.startedAt { return }
        if states[state.kind] != state { states[state.kind] = state }
    }

    func reset() { if !states.isEmpty { states = [:] } }
}

/// pi MCP server status. Kept apart from PilotClient so status changes redraw only connection views.
@MainActor
final class McpStatusStore: ObservableObject {
    @Published private(set) var status: McpStatus?
    /// A failed check request, cleared by the next status.
    @Published var actionError: String?
    /// Snapshot fixtures: socket updates are ignored. Never set in the live app.
    private(set) var fixture = false

    var needingUser: [McpServerStatus] { status?.needingUser ?? [] }

    func record(_ next: McpStatus) {
        if actionError != nil { actionError = nil }
        if status != next { status = next }
    }

    /// A sign-in reply, before the next status repeats it. Newest wins.
    func recordSignIn(_ name: String, _ signIn: McpSignInState) {
        guard let current = status, let index = current.servers.firstIndex(where: { $0.name == name }) else { return }
        let server = current.servers[index]
        if let previous = server.signIn, previous.startedAt > signIn.startedAt { return }
        var servers = current.servers
        servers[index] = McpServerStatus(name: server.name, transport: server.transport, state: server.state,
                                         tools: server.tools, problem: server.problem, canSignIn: server.canSignIn,
                                         checkedAt: server.checkedAt, signIn: signIn)
        record(McpStatus(servers: servers, checking: current.checking, configProblems: current.configProblems))
    }

    func loadFixture(_ status: McpStatus) {
        fixture = true
        record(status)
    }
}

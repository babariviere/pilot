import AppKit
import Foundation
import PilotCore

/// pilotd client: REST commands, one reconnecting control WebSocket for lists, dashboards and missions, and one
/// reconnecting WebSocket per open chat, terminal and subagent transcript.
@MainActor
final class PilotClient: ObservableObject {
    @Published private(set) var sessions: [SessionSummary] = []
    @Published private(set) var projects: [Project] = []
    @Published private(set) var schedules: [ScheduledItem] = []
    @Published private(set) var trackingSources: [TrackingSource] = []
    /// Invalidation only, per project. Inbox views refresh a bounded page; project pages already get
    /// dashboard updates. Observers register with observeTrackedItems.
    private var trackedObservers: [UUID: (String) -> Void] = [:]
    /// Snapshot fixtures for tracked items and the settings pickers. Never set in the live app.
    var fixtureTracking: TrackingFixture?
    @Published private(set) var hasProjectSnapshot = false
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
    @Published private(set) var connected = false

    /// Includes full snapshots on initial connection and reconnect, not just deltas.
    var onSessionsChanged: (([SessionSummary], Bool) -> Void)?
    var onSchedulesChanged: (([ScheduledItem]) -> Void)?

    // The WebSocket includes ALL sessions, including archives, for readable subscriptions.
    var activeSessions: [SessionSummary] { sessions.unarchivedSessions }
    var archivedSessions: [SessionSummary] { sessions.archivedSessions }
    var workingCount: Int { activeSessions.filter(\.isWorking).count }

    private var baseURL: URL?
    private let artifactSession: URLSession
    private let repositoryRequests = RepositoryRequestLimiter(limit: 4)
    private let summaryCache = AsyncReadCache<String, SessionChangeSummary>(ttl: 10)
    private let changesCache = AsyncReadCache<String, SessionChanges>(ttl: 1, limit: 8)
    init(baseURL: URL? = nil, artifactSession: URLSession = .shared) {
        self.baseURL = baseURL
        self.artifactSession = artifactSession
        // Returning to the app refreshes the PR state of open chats. The daemon skips recently checked ones.
        activationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.postFocus() }
        }
    }
    private var activationObserver: NSObjectProtocol?
    private var control: SocketReader?
    private var retry = 0
    private var awaitingList: [String: SessionSummary] = [:]
    private var listeners: [String: [UUID: ([JSONValue]) -> Void]] = [:]
    private var chats: [String: ChatStream] = [:]
    private var subagentListeners: [SubagentKey: [UUID: SubagentListener]] = [:]
    private var subagentSockets: [SubagentKey: StreamSocket] = [:]
    private var terminals: [String: TerminalAttachment] = [:]
    private var terminalSockets: [String: StreamSocket] = [:]

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
        let onData: (String) -> Void
        let onExit: (Int) -> Void
        /// Called before the daemon replays scrollback on (re)attach, so the surface can reset.
        let onReplay: () -> Void
    }

    func connect(to baseURL: URL) {
        fixtureSessions = false
        self.baseURL = baseURL
        open()
        for chat in chats.values { chat.socket?.connect() }
        for socket in terminalSockets.values { socket.connect() }
        for socket in subagentSockets.values { socket.connect() }
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
        fixtureSessions = true
        self.projects = projects
        hasProjectSnapshot = true
        self.sessions = sessions.sorted(by: SessionSummary.listPrecedes)
        connected = true
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
        let session: SessionSummary = try await call("api/sessions", body: request)
        // REST can win the race with the list stream. Navigation needs the session immediately,
        // but must not overwrite a newer state already received over the WebSocket.
        if self.session(session.id) == nil {
            awaitingList[session.id] = session
            update(session)
        }
        return session
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
        let _: Ack = try await call("api/sessions/\(sessionId)/messages", body: SendRequest(message: message, mode: mode))
    }

    /// Stops current work. Returns the user's queued messages that Stop withdrew, which belong in the composer.
    func stop(_ sessionId: String) async throws -> String? {
        let response: StopResponse = try await call("api/sessions/\(sessionId)/stop", body: [String: String]())
        return response.draft
    }

    /// Prompt templates and skills the session's kernel expands. Reopens a parked chat only when pilotd has no list yet.
    func commands(_ sessionId: String) async throws -> [SessionCommand] {
        let response: SessionCommandsResponse = try await call("api/sessions/\(sessionId)/commands", method: "GET")
        return response.commands
    }

    /// Starts a manual compaction; returns once it is queued, not when the summary is placed.
    func compact(_ sessionId: String, instructions: String?) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat before compacting it.") }
        let _: Ack = try await call("api/sessions/\(sessionId)/compact", body: CompactRequest(instructions: instructions))
    }

    /// Stops current work and continues from an earlier point in a new attempt. Workspace files are not reverted.
    /// Returns the edited message's text for `.edit`, which belongs in the composer.
    func rewind(_ sessionId: String, action: RewindAction, entryId: Int) async throws -> String? {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat first.") }
        let response: RewindResponse = try await call(
            "api/sessions/\(sessionId)/rewind", body: RewindRequest(action: action, entryId: entryId)
        )
        update(response.session)
        return response.draft
    }

    /// Stops current work and continues another attempt of the chat.
    func activateAttempt(_ sessionId: String, attemptId: String) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat first.") }
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

    func editQueuedMessage(_ sessionId: String, submissionId: Int, message: String, mode: DeliveryMode? = nil) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat before editing queued messages.") }
        let _: Ack = try await call(
            "api/sessions/\(sessionId)/queue/\(submissionId)",
            method: "PATCH",
            body: EditQueuedMessageRequest(message: message, mode: mode)
        )
    }

    func removeQueuedMessage(_ sessionId: String, submissionId: Int) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat before removing queued messages.") }
        let _: RemoveQueuedMessageResponse = try await call(
            "api/sessions/\(sessionId)/queue/\(submissionId)", method: "DELETE", body: [String: String]()
        )
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

    func createProject(_ request: ProjectRequest) async throws -> Project {
        let project: Project = try await call("api/projects", body: request)
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

    /// Linear teams for the project settings picker. Sign-in and errors come back as states.
    func linearTeams(query: String? = nil) async throws -> TrackingLookup<LinearTeamOption> {
        if let fixture = fixtureTracking { return fixture.teams }
        return try await missionRequest(["tracking", "linear", "teams"],
                                        query: query.map { [URLQueryItem(name: "query", value: $0)] } ?? [])
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

    func loadTrackingFixture(_ fixture: TrackingFixture) {
        fixtureTracking = fixture
        trackingSources = fixture.sources
    }

    func trackedItems(projectId: String, kind: TrackedKind? = nil, dismissed: Bool = false,
                      limit: Int = 100, offset: Int = 0) async throws -> TrackedItemList {
        if let fixture = fixtureTracking {
            let items = fixture.items.filter {
                $0.projectId == projectId && $0.dismissed == dismissed && (kind == nil || $0.kind == kind)
            }
            return TrackedItemList(items: Array(items.prefix(limit)), total: items.count)
        }
        var query = [URLQueryItem(name: "projectId", value: projectId),
                     URLQueryItem(name: "dismissed", value: String(dismissed)),
                     URLQueryItem(name: "limit", value: String(limit)), URLQueryItem(name: "offset", value: String(offset))]
        if let kind { query.append(URLQueryItem(name: "kind", value: kind.rawValue)) }
        return try await missionRequest(["tracked-items"], query: query)
    }

    func updateTrackedItem(_ id: String, _ patch: TrackedItemPatch) async throws -> TrackedItem {
        try await call(url: missionURL(["tracked-items", id]), method: "PATCH", body: patch)
    }

    func trackedItemPrefill(_ id: String) async throws -> TrackedItemPrefill {
        try await missionRequest(["tracked-items", id, "prefill"])
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

    var fixtureChanges: SessionChanges?
    var fixtureChangeSummaries: [String: SessionChangeSummary] = [:]

    func refreshRepositoryCaches() {
        summaryCache.clearValues()
        changesCache.clearValues()
    }

    /// Sidebar metadata only, without computing or transferring full diffs.
    func changeSummary(_ sessionId: String) async throws -> SessionChangeSummary {
        if let fixture = fixtureChangeSummaries[sessionId] { return fixture }
        return try await summaryCache.value(for: sessionId) { [self] in
            try await fetchChangeSummary(sessionId)
        }
    }

    private func fetchChangeSummary(_ sessionId: String) async throws -> SessionChangeSummary {
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        let url = baseURL.appending(path: "api/sessions/\(sessionId)/changes/summary")
        let (data, response) = try await repositoryRequests.perform {
            try await artifactSession.data(from: url)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            throw ClientError((try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "HTTP \(status)")
        }
        return try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(SessionChangeSummary.self, from: data)
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
        try artifactURL(["artifact-libraries", library.rawValue])
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
        let (data, response) = try await artifactSession.data(from: url)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            let error = (try? JSONDecoder().decode(APIError.self, from: data))?.error
            // Older running daemons can serve chats but have no artifact routes. Do not
            // restart them automatically: that would interrupt active agents.
            if status == 404, error == "Not found" {
                throw ClientError("This pilotd does not support artifacts. Once agents are idle, restart pilotd from the Pilot menu to load the current runtime.")
            }
            throw ClientError(error ?? "HTTP \(status)")
        }
        return try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(Response.self, from: data)
        }.value
    }

    private struct Ack: Decodable {}
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

    private func call<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            throw ClientError((try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "HTTP \(status)", status: status)
        }
        return try JSONDecoder().decode(Response.self, from: data)
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

    func memoryZoom(_ projectId: String, lo: Int, hi: Int) async throws -> [MemoryNode] {
        try await missionRequest(["projects", projectId, "memory", "zoom"], query: [
            URLQueryItem(name: "lo", value: String(lo)), URLQueryItem(name: "hi", value: String(hi)),
        ])
    }

    func memoryWake(_ projectId: String) async throws -> MemoryView {
        try await missionRequest(["projects", projectId, "memory", "wake"], query: [
            URLQueryItem(name: "lines", value: "96"),
        ])
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
    func addMissionDecision(_ id: String, text: String) async throws -> MissionDecision {
        try await missionRequest(["missions", id, "decisions"], body: MissionDecisionWrite(text: text))
    }

    @discardableResult
    func updateMissionDecision(_ id: String, decisionId: String, text: String) async throws -> MissionDecision {
        try await missionRequest(["missions", id, "decisions", decisionId], method: "PATCH", body: MissionDecisionWrite(text: text))
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
    func subscribe(_ sessionId: String, _ listener: @escaping ([JSONValue]) -> Void) -> UUID {
        let token = UUID()
        let first = listeners[sessionId]?.isEmpty ?? true
        listeners[sessionId, default: [:]][token] = listener
        if first { openChat(sessionId) }
        return token
    }

    func unsubscribe(_ sessionId: String, token: UUID) {
        listeners[sessionId]?[token] = nil
        if listeners[sessionId]?.isEmpty ?? false {
            listeners[sessionId] = nil
            closeChat(sessionId)
        }
    }

    private func openChat(_ sessionId: String) {
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
            },
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

    private func socketURL(_ percentEncodedPath: String, query: [URLQueryItem] = []) -> URL? {
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
    func attachTerminal(_ sessionId: String, cols: Int, rows: Int, restart: Bool = false, _ attachment: TerminalAttachment) {
        terminals[sessionId] = attachment
        terminalSockets.removeValue(forKey: sessionId)?.close()
        var restartNext = restart
        let socket = StreamSocket(
            url: { [weak self] in
                guard let self, let attachment = self.terminals[sessionId] else { return nil }
                defer { restartNext = false }
                var query = [
                    URLQueryItem(name: "cols", value: String(attachment.cols)),
                    URLQueryItem(name: "rows", value: String(attachment.rows)),
                ]
                if restartNext { query.append(URLQueryItem(name: "restart", value: "1")) }
                return self.socketURL("/api/sessions/\(Self.pathSegment(sessionId))/terminal/ws", query: query)
            },
            willConnect: { [weak self] in self?.terminals[sessionId]?.onReplay() },
            receive: { [weak self] updates in
                guard let self else { return }
                for update in updates {
                    switch update {
                    case let .terminalData(id, _) where id == sessionId: self.handle(update)
                    case let .terminalExit(id, _) where id == sessionId: self.handle(update)
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
    }

    func terminalInput(_ sessionId: String, _ data: Data) {
        terminalSockets[sessionId]?.send(["type": .string("terminal.input"), "data": .string(String(decoding: data, as: UTF8.self))])
    }

    func terminalResize(_ sessionId: String, cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        terminals[sessionId]?.cols = cols
        terminals[sessionId]?.rows = rows
        terminalSockets[sessionId]?.send([
            "type": .string("terminal.resize"), "cols": .number(Double(cols)), "rows": .number(Double(rows)),
        ])
    }
    private func post(_ message: [String: JSONValue]) {
        guard connected, let control, let data = try? JSONEncoder().encode(JSONValue.object(message)) else { return }
        control.task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
    }

    private func open() {
        control?.cancel()
        control = nil
        guard let url = socketURL("/api/ws") else { return }
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
                self.scheduleReconnect()
            }
        )
        control = reader
        reader.start()
    }

    private func didConnect() {
        connected = true
        retry = 0
        // The daemon sends a fresh snapshot per subscription, so reconnects resync.
        for id in missionRefs.keys { post(["type": .string("mission.subscribe"), "missionId": .string(id)]) }
        for id in dashboardRefs.keys { post(["type": .string("dashboard.subscribe"), "projectId": .string(id)]) }
        // pilotd is back: dedicated sockets waiting out a reconnect delay retry now.
        for chat in chats.values { chat.socket?.retryNow() }
        for socket in terminalSockets.values { socket.retryNow() }
        for socket in subagentSockets.values { socket.retryNow() }
    }

    private func scheduleReconnect() {
        control?.cancel()
        control = nil
        let delay = min(10.0, 0.5 * pow(2.0, Double(retry)))
        retry += 1
        Task {
            try? await Task.sleep(for: .seconds(delay))
            if self.control == nil { self.open() }
        }
    }

    private func update(_ session: SessionSummary) {
        let current = self.session(session.id)
        if current?.updatedAt != session.updatedAt {
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
        case let .schedules(list):
            schedules = list
            onSchedulesChanged?(list)
        case let .sources(list):
            if trackingSources != list { trackingSources = list }
        case let .trackedChanged(projectId):
            for observer in trackedObservers.values { observer(projectId) }
        case let .projects(list):
            projects = list
            hasProjectSnapshot = true
        case let .sessions(list):
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

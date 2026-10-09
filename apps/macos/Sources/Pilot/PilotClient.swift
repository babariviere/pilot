import Foundation
import PilotCore

/// pilotd client: REST commands plus one reconnecting WebSocket for the session list and
/// per-session agent event streams.
@MainActor
final class PilotClient: ObservableObject {
    @Published private(set) var sessions: [SessionSummary] = []
    @Published private(set) var projects: [Project] = []
    @Published private(set) var hasProjectSnapshot = false
    @Published private(set) var artifacts: [String: [ArtifactSummary]] = [:]
    private var artifactVersions: [String: Int] = [:]
    /// Every mission, including done and archived ones.
    @Published private(set) var missions: [Mission] = []
    /// Details of subscribed missions only.
    @Published private(set) var missionDetails: [String: MissionDetail] = [:]
    /// Subscription reference counts. Active missions are always held so sidebar badges stay current.
    private var missionRefs: [String: Int] = [:]
    private var heldActiveMissions: Set<String> = []
    private var fixtureMissions = false
    @Published private(set) var connected = false

    /// Includes full snapshots on initial connection and reconnect, not just deltas.
    var onSessionsChanged: (([SessionSummary], Bool) -> Void)?

    // The WebSocket includes ALL sessions, including archives, for readable subscriptions.
    var activeSessions: [SessionSummary] { sessions.unarchivedSessions }
    var archivedSessions: [SessionSummary] { sessions.archivedSessions }
    var workingCount: Int { activeSessions.filter(\.isWorking).count }

    private var baseURL: URL?
    private let artifactSession: URLSession
    private let repositoryRequests = RepositoryRequestLimiter(limit: 4)
    private let summaryCache = AsyncReadCache<String, SessionChangeSummary>(ttl: 10)
    init(baseURL: URL? = nil, artifactSession: URLSession = .shared) {
        self.baseURL = baseURL
        self.artifactSession = artifactSession
    }
    private var task: URLSessionWebSocketTask?
    private var retry = 0
    private var awaitingList: [String: SessionSummary] = [:]
    private var listeners: [String: [UUID: ([JSONValue]) -> Void]] = [:]
    private var subagentListeners: [SubagentKey: [UUID: SubagentListener]] = [:]
    private var terminals: [String: TerminalAttachment] = [:]

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
        self.baseURL = baseURL
        open()
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

    // MARK: Commands

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

    func send(_ sessionId: String, message: String, mode: DeliveryMode) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat before sending messages.") }
        let _: Ack = try await call("api/sessions/\(sessionId)/messages", body: SendRequest(message: message, mode: mode))
    }

    func stop(_ sessionId: String) async throws {
        let _: Ack = try await call("api/sessions/\(sessionId)/stop", body: [String: String]())
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
            postSubagent("subagent.subscribe", key)
        }
        return token
    }

    func unsubscribeSubagent(_ key: SubagentKey, token: UUID) {
        subagentListeners[key]?[token] = nil
        guard subagentListeners[key]?.isEmpty ?? false else { return }
        subagentListeners[key] = nil
        if fixtureSubagentTranscripts == nil { postSubagent("subagent.unsubscribe", key) }
    }

    private func postSubagent(_ type: String, _ key: SubagentKey) {
        post(["type": .string(type), "sessionId": .string(key.sessionId), "name": .string(key.name)])
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

    func editQueuedMessage(_ sessionId: String, submissionId: Int, message: String) async throws {
        guard session(sessionId)?.isArchived != true else { throw ClientError("Restore this archived chat before editing queued messages.") }
        let _: Ack = try await call(
            "api/sessions/\(sessionId)/queue/\(submissionId)",
            method: "PATCH",
            body: EditQueuedMessageRequest(message: message)
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

    private func upsert(_ project: Project) {
        projects.removeAll { $0.id == project.id }
        projects.append(project)
        projects.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// The pi model scope for a project (or folder), with pi's default model.
    func models(projectId: String?, cwd: String?) async throws -> ModelList {
        if let fixtureModels { return fixtureModels }
        guard let baseURL, var components = URLComponents(url: baseURL.appending(path: "api/models"), resolvingAgainstBaseURL: false)
        else { throw ClientError("pilotd is not connected") }
        if let projectId { components.queryItems = [URLQueryItem(name: "projectId", value: projectId)] }
        else if let cwd, !cwd.isEmpty { components.queryItems = [URLQueryItem(name: "cwd", value: cwd)] }
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            throw ClientError((try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "HTTP \(status)")
        }
        return try JSONDecoder().decode(ModelList.self, from: data)
    }

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
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "api/sessions/\(sessionId)/changes"))
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
        let active = Set(list.filter { $0.status == .active }.map(\.id))
        for id in active.subtracting(heldActiveMissions) { retainMission(id) }
        for id in heldActiveMissions.subtracting(active) { releaseMission(id) }
        heldActiveMissions = active
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

    func unlinkMissionArtifact(_ id: String, artifactId: String) async throws {
        let _: Ack = try await missionRequest(["missions", id, "artifacts", artifactId], method: "DELETE")
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

    /// The first batch delivered is always a snapshot, including after reconnects.
    func subscribe(_ sessionId: String, _ listener: @escaping ([JSONValue]) -> Void) -> UUID {
        let token = UUID()
        let first = listeners[sessionId]?.isEmpty ?? true
        listeners[sessionId, default: [:]][token] = listener
        if first { post(["type": .string("subscribe"), "sessionId": .string(sessionId)]) }
        return token
    }

    func unsubscribe(_ sessionId: String, token: UUID) {
        listeners[sessionId]?[token] = nil
        if listeners[sessionId]?.isEmpty ?? false {
            listeners[sessionId] = nil
            post(["type": .string("unsubscribe"), "sessionId": .string(sessionId)])
        }
    }

    // MARK: Terminals (daemon-owned PTYs)

    func attachTerminal(_ sessionId: String, cols: Int, rows: Int, restart: Bool = false, _ attachment: TerminalAttachment) {
        terminals[sessionId] = attachment
        sendAttach(sessionId, restart: restart)
    }

    func detachTerminal(_ sessionId: String) {
        guard terminals.removeValue(forKey: sessionId) != nil else { return }
        post(["type": .string("terminal.detach"), "sessionId": .string(sessionId)])
    }

    func terminalInput(_ sessionId: String, _ data: Data) {
        post(["type": .string("terminal.input"), "sessionId": .string(sessionId), "data": .string(String(decoding: data, as: UTF8.self))])
    }

    func terminalResize(_ sessionId: String, cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        terminals[sessionId]?.cols = cols
        terminals[sessionId]?.rows = rows
        post([
            "type": .string("terminal.resize"), "sessionId": .string(sessionId),
            "cols": .number(Double(cols)), "rows": .number(Double(rows)),
        ])
    }

    private func sendAttach(_ sessionId: String, restart: Bool) {
        guard let attachment = terminals[sessionId], connected else { return }
        attachment.onReplay()
        post([
            "type": .string("terminal.attach"), "sessionId": .string(sessionId),
            "cols": .number(Double(attachment.cols)), "rows": .number(Double(attachment.rows)),
            "restart": .bool(restart),
        ])
    }

    private func post(_ message: [String: JSONValue]) {
        guard connected, let task, let data = try? JSONEncoder().encode(JSONValue.object(message)) else { return }
        task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
    }

    private func open() {
        guard let baseURL, var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/api/ws"
        guard let url = components.url else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        // Snapshots of long transcripts exceed the 1 MiB default.
        task.maximumMessageSize = 64 * 1024 * 1024
        self.task = task
        task.resume()
        receive(on: task)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === task else { return }
                switch result {
                case let .success(message):
                    let decoded = await Task.detached(priority: .userInitiated) {
                        let data: Data
                        switch message {
                        case let .string(text): data = Data(text.utf8)
                        case let .data(value): data = value
                        @unknown default: return ServerUpdate?.none
                        }
                        return try? ServerUpdate.decode(data)
                    }.value
                    // A reconnect may have replaced this socket while decoding a large snapshot.
                    guard self.task === task else { return }
                    if !self.connected {
                        self.connected = true
                        self.retry = 0
                        // The daemon sends a fresh snapshot per subscription, so reconnects resync.
                        for id in self.listeners.keys { self.post(["type": .string("subscribe"), "sessionId": .string(id)]) }
                        for key in self.subagentListeners.keys { self.postSubagent("subagent.subscribe", key) }
                        for id in self.missionRefs.keys {
                            self.post(["type": .string("mission.subscribe"), "missionId": .string(id)])
                        }
                        for id in self.terminals.keys { self.sendAttach(id, restart: false) }
                    }
                    if let decoded { self.handle(decoded) }
                    // Receive serially so snapshots and following deltas cannot be reordered.
                    self.receive(on: task)
                case .failure:
                    self.connected = false
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func scheduleReconnect() {
        task?.cancel()
        task = nil
        let delay = min(10.0, 0.5 * pow(2.0, Double(retry)))
        retry += 1
        Task {
            try? await Task.sleep(for: .seconds(delay))
            if self.task == nil { self.open() }
        }
    }

    private func update(_ session: SessionSummary) {
        if self.session(session.id)?.updatedAt != session.updatedAt { summaryCache.invalidate(session.id) }
        sessions.removeAll { $0.id == session.id }
        sessions.append(session)
        sessions.sort(by: SessionSummary.listPrecedes)
        onSessionsChanged?([session], false)
    }

    /// Internal, not private, so tests can deliver decoded updates without a socket.
    func handle(_ message: ServerUpdate) {
        switch message {
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
        case let .events(id, events):
            for listener in listeners[id]?.values ?? [:].values { listener(events) }
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

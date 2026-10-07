import Foundation
import PilotCore

/// pilotd client: REST commands plus one reconnecting WebSocket for the session list and
/// per-session agent event streams.
@MainActor
final class PilotClient: ObservableObject {
    @Published private(set) var sessions: [SessionSummary] = []
    @Published private(set) var projects: [Project] = []
    @Published private(set) var connected = false

    /// Fires on every session state change, for notifications.
    var onTransition: ((SessionSummary?, SessionSummary) -> Void)?

    var workingCount: Int { sessions.filter(\.isWorking).count }

    private var baseURL: URL?
    private var task: URLSessionWebSocketTask?
    private var retry = 0
    private var listeners: [String: [UUID: ([JSONValue]) -> Void]] = [:]
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

    /// Static data for snapshots and previews.
    func loadFixture(projects: [Project], sessions: [SessionSummary]) {
        self.projects = projects
        self.sessions = sessions
        connected = true
    }

    // MARK: Commands

    func spawn(_ request: SpawnRequest) async throws -> SessionSummary {
        try await call("api/sessions", body: request)
    }

    func send(_ sessionId: String, message: String, mode: DeliveryMode) async throws {
        let _: Ack = try await call("api/sessions/\(sessionId)/messages", body: SendRequest(message: message, mode: mode))
    }

    func stop(_ sessionId: String) async throws {
        let _: Ack = try await call("api/sessions/\(sessionId)/stop", body: [String: String]())
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
    var fixtureChanges: SessionChanges?

    /// The session's working copy against the point it branched from.
    func changes(_ sessionId: String) async throws -> SessionChanges {
        if let fixtureChanges { return fixtureChanges }
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "api/sessions/\(sessionId)/changes"))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            throw ClientError((try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "HTTP \(status)")
        }
        return try JSONDecoder().decode(SessionChanges.self, from: data)
    }

    private struct Ack: Decodable {}
    private struct APIError: Decodable { let error: String }

    private func call<Body: Encodable, Response: Decodable>(
        _ path: String,
        method: String = "POST",
        body: Body
    ) async throws -> Response {
        guard let baseURL else { throw ClientError("pilotd is not connected") }
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            throw ClientError((try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "HTTP \(status)")
        }
        return try JSONDecoder().decode(Response.self, from: data)
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
                    if !self.connected {
                        self.connected = true
                        self.retry = 0
                        // The daemon sends a fresh snapshot per subscription, so reconnects resync.
                        for id in self.listeners.keys { self.post(["type": .string("subscribe"), "sessionId": .string(id)]) }
                        for id in self.terminals.keys { self.sendAttach(id, restart: false) }
                    }
                    switch message {
                    case let .string(text): self.handle(Data(text.utf8))
                    case let .data(data): self.handle(data)
                    @unknown default: break
                    }
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

    private func handle(_ data: Data) {
        guard let message = try? JSONValue.decode(data) else { return }
        switch message["type"]?.string {
        case "projects":
            if let list = try? message["projects"]?.decode([Project].self) {
                projects = list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            }
        case "sessions":
            if let list = try? message["sessions"]?.decode([SessionSummary].self) {
                sessions = list.sorted { $0.updatedAt > $1.updatedAt }
            }
        case "session":
            guard let session = try? message["session"]?.decode(SessionSummary.self) else { return }
            let previous = self.session(session.id)
            sessions.removeAll { $0.id == session.id }
            sessions.append(session)
            sessions.sort { $0.updatedAt > $1.updatedAt }
            if previous?.state != session.state { onTransition?(previous, session) }
        case "events":
            guard let id = message["sessionId"]?.string, let events = message["events"]?.array else { return }
            for listener in listeners[id]?.values ?? [:].values { listener(events) }
        case "terminal.data":
            guard let id = message["sessionId"]?.string, let data = message["data"]?.string else { return }
            terminals[id]?.onData(data)
        case "terminal.exit":
            guard let id = message["sessionId"]?.string else { return }
            terminals[id]?.onExit(message["code"]?.int ?? 0)
        default:
            break
        }
    }
}

struct ClientError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

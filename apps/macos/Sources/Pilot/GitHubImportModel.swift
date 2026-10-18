import Combine
import Foundation
import PilotCore

@MainActor
struct GitHubImportActions {
    var available: (HostRef) -> Bool
    var repositories: (HostRef) async throws -> GitHubRepositoryChoices
    var operations: (HostRef) async throws -> [GitHubImportOperation]
    var preview: (HostRef, String, String) async throws -> GitHubImportPreview
    var start: (HostRef, GitHubImportRequest) async throws -> GitHubImportOperation
    var act: (HostRef, String, String) async throws -> GitHubImportOperation
    var project: (HostRef, String) async throws -> Hosted<Project>
    static func live(_ hosts: HostClients) -> Self {
        Self(available: { hosts.available.contains($0) }, repositories: {
            try await hosts.githubRequest(on: $0, path: "api/github-import/repositories", body: Optional<GitHubImportRequest>.none, method: "GET")
        }, operations: {
            try await hosts.githubRequest(on: $0, path: "api/github-import", body: Optional<GitHubImportRequest>.none, method: "GET")
        }, preview: { host, url, destination in
            try await hosts.githubRequest(on: host, path: "api/github-import/preview", body: ["url": url, "destination": destination])
        }, start: { try await hosts.githubRequest(on: $0, path: "api/github-import", body: $1) }, act: { host, id, action in
            guard UUID(uuidString: id) != nil, ["resume", "cancel", "confirm_existing"].contains(action) else { throw HostRoutingError.invalidReference }
            return try await hosts.githubRequest(on: host, path: "api/github-import/\(id)/\(action)", body: [String: String]())
        }, project: { host, id in
            try await hosts.importedProject(on: host, id: id)
        })
    }
}

@MainActor
final class GitHubImportModel: ObservableObject {
    let host: HostRef
    private let actions: GitHubImportActions
    @Published var url = ""
    @Published var destination = ""
    @Published var query = ""
    @Published private(set) var repositories: [GitHubRepositoryChoice] = []
    @Published private(set) var truncated = false
    @Published private(set) var operations: [GitHubImportOperation] = []
    @Published private(set) var busy = false
    @Published private(set) var problem: String?
    @Published private(set) var uncertain = false
    @Published private(set) var preview: GitHubImportPreview?
    private var previewInput: [String] = []
    private var suggestedDestination = ""
    private(set) var pending: GitHubImportRequest?
    private var generation = UUID()
    var available: Bool { actions.available(host) }
    var canStart: Bool { available && !busy && !uncertain && pending == nil && GitHubImportValidation.repository(url) != nil && !destination.isEmpty && resolvedDestination != nil }
    var resolvedDestination: String? { previewInput == [url, destination] ? preview?.resolvedDestination : nil }
    init(host: HostRef, actions: GitHubImportActions, initialURL: String = "") {
        self.host = host; self.actions = actions; url = initialURL
        suggestDestination()
    }
    func detach() { generation = UUID() }
    func choose(_ repo: GitHubRepositoryChoice) { url = repo.url; suggestDestination() }
    func suggestDestination() {
        guard let value = ProjectDestinationPolicy.destination(repository: url) else { return }
        if destination.isEmpty || destination == suggestedDestination { destination = value }
        suggestedDestination = value
    }
    func checkDestination() async {
        guard !busy, available, let normalized = GitHubImportValidation.repository(url) else { return }
        let captured = [url, destination], fence = generation
        busy = true; defer { busy = false }
        do {
            let value = try await actions.preview(host, normalized, destination)
            guard fence == generation, available, captured == [url, destination] else { return }
            preview = value; previewInput = captured; problem = nil
        } catch { if fence == generation { preview = nil; problem = "Could not validate this host's destination. Use a safe path under its Home without symlinks, traversal or shell expansion." } }
    }
    func refresh(loadRepositories: Bool = false) async {
        guard !busy, available else { return }
        busy = true; defer { busy = false }; let fence = generation
        do {
            let values = try await actions.operations(host)
            guard fence == generation, available else { return }
            operations = values
            if let pending, values.contains(where: { $0.id == pending.id }) { self.pending = nil }
            uncertain = pending != nil; problem = nil
            if loadRepositories {
                let page = try await actions.repositories(host)
                guard fence == generation, available else { return }
                repositories = page.repositories; truncated = page.truncated
            }
        } catch { if fence == generation { problem = "Could not check GitHub imports on this host. Reconnect or connect GitHub, then refresh. No request was sent to Local." } }
    }
    func start(retryOriginal: Bool = false) async {
        guard available, !busy else { return }
        let request: GitHubImportRequest
        if retryOriginal { guard uncertain, let pending else { return }; request = pending }
        else {
            guard canStart, let normalized = GitHubImportValidation.repository(url), let resolvedDestination else { return }
            request = GitHubImportRequest(url: normalized, destination: resolvedDestination); pending = request
        }
        busy = true; defer { busy = false }; let fence = generation
        do {
            let value = try await actions.start(host, request)
            guard fence == generation, available, value.id == request.id else { return }
            update(value); pending = nil; uncertain = false; problem = nil
        } catch { if fence == generation { uncertain = true; problem = "Import start is not confirmed. Refresh this host's imports before retrying the original request. No clone will be retried automatically." } }
    }
    func act(_ value: GitHubImportOperation, _ action: String) async {
        guard available, !busy, operations.contains(value) else { return }
        busy = true; defer { busy = false }; let fence = generation
        do {
            let result = try await actions.act(host, value.id, action)
            guard fence == generation, available, result.id == value.id else { return }
            update(result); problem = nil
        } catch { if fence == generation { problem = "Import action was not confirmed. Refresh this host. Cancellation, reuse and resume are never replayed automatically." } }
    }
    func open(_ value: GitHubImportOperation) async -> Hosted<Project>? {
        guard available, !busy, value.phase == "done", operations.contains(value), let id = value.projectId else { return nil }
        busy = true; defer { busy = false }; let fence = generation
        do {
            let project = try await actions.project(host, id)
            guard fence == generation, available, project.ref.host == host, project.ref.localId == id else { return nil }
            return project
        } catch { if fence == generation { problem = "This project could not be opened on its original host. Reconnect and refresh." }; return nil }
    }
    private func update(_ value: GitHubImportOperation) { operations.removeAll { $0.id == value.id }; operations.insert(value, at: 0) }
}

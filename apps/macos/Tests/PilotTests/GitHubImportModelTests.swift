import Foundation
import Testing
@testable import Pilot
@testable import PilotCore

private let importHost = HostRef(hostId: "box", daemonId: "d", lineageId: "l")
private func importFixture<T: Decodable>(_ text: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(text.utf8)) }
private func importOperation(id: String, phase: String = "cloning") throws -> GitHubImportOperation {
    try importFixture("""
    {"id":"\(id)","url":"https://github.com/owner/repo","destination":"/remote/src/github.com/owner/repo","phase":"\(phase)","projectId":"same-id"}
    """)
}
@MainActor private func importActions() throws -> GitHubImportActions {
    GitHubImportActions(available: { $0 == importHost }, repositories: { _ in try importFixture("{\"repositories\":[],\"truncated\":false}") },
        operations: { _ in [] }, preview: { host, _, destination in
            #expect(host == importHost)
            #expect(destination == "~/src/github.com/owner/repo")
            return try importFixture("{\"destination\":\"~/src/github.com/owner/repo\",\"resolvedDestination\":\"/remote/src/github.com/owner/repo\"}")
        }, start: { host, request in #expect(host == importHost); return try importOperation(id: request.id) },
        act: { _, id, _ in try importOperation(id: id) }, project: { _, _ in throw CancellationError() })
}

@Test func githubDestinationPolicyIsForgeHostBasedAndNeverExpandsCredentialsOrTraversal() {
    #expect(ProjectDestinationPolicy.destination(repository: "git@github.com:owner/repo.git") == "~/src/github.com/owner/repo")
    #expect(ProjectDestinationPolicy.destination(repository: "https://github.com/babariviere/pilot") == "~/src/github.com/babariviere/pilot")
    for url in ["https://token@github.com/o/r", "https://github.com/o/r?token=secret", "https://other.test/o/r", "https://github.com/o/../repo", "https://github.com/o/$(id)", "--upload-pack=evil"] {
        #expect(ProjectDestinationPolicy.destination(repository: url) == nil)
        #expect(GitHubImportValidation.repository(url) == nil)
    }
}

@Test @MainActor func githubImportRequiresSelectedHostPreviewAndDestinationEditsInvalidateIt() async throws {
    let model = GitHubImportModel(host: importHost, actions: try importActions(), initialURL: "https://github.com/owner/repo")
    #expect(model.destination == "~/src/github.com/owner/repo")
    #expect(!model.canStart && model.resolvedDestination == nil)
    await model.checkDestination()
    #expect(model.canStart && model.resolvedDestination == "/remote/src/github.com/owner/repo")
    model.destination = "~/custom"
    #expect(!model.canStart && model.resolvedDestination == nil)
    model.url = "https://github.com/owner/another"; model.suggestDestination()
    #expect(model.destination == "~/custom", "Manual edits must not be replaced by repository suggestions")
    model.destination = ""; model.suggestDestination()
    #expect(model.destination == "~/src/github.com/owner/another")
}

@Test @MainActor func githubImportLostStartRetainsExactRequestAndOriginalHostInsteadOfRecloningAnotherDraft() async throws {
    var actions = try importActions(), starts: [GitHubImportRequest] = [], offline = false
    actions.available = { $0 == importHost && !offline }
    actions.start = { host, request in
        #expect(host == importHost); starts.append(request)
        if starts.count == 1 { throw URLError(.networkConnectionLost) }
        return try importOperation(id: request.id)
    }
    let model = GitHubImportModel(host: importHost, actions: actions, initialURL: "https://github.com/owner/repo")
    await model.checkDestination(); await model.start()
    #expect(model.uncertain && starts.count == 1)
    model.url = "https://github.com/owner/newer"; model.destination = "~/newer"
    await model.start(); #expect(starts.count == 1)
    offline = true; await model.start(retryOriginal: true); #expect(starts.count == 1)
    offline = false; await model.refresh()
    #expect(model.uncertain)
    await model.start(retryOriginal: true)
    #expect(starts.count == 2 && starts[0] == starts[1])
    #expect(starts[0].destination == "/remote/src/github.com/owner/repo")
    #expect(!model.uncertain && model.operations.count == 1)
}

@Test @MainActor func githubImportReconcilesReadOnlyAndRejectsWrongHostProjectsAndStalePreviewResponses() async throws {
    let done = try importOperation(id: UUID().uuidString, phase: "done")
    let project: Project = try importFixture("{\"id\":\"same-id\",\"name\":\"repo\",\"path\":\"/remote/repo\",\"createdAt\":1}")
    var actions = try importActions(), mutations = 0
    actions.operations = { host in #expect(host == importHost); return [done] }
    actions.act = { _, _, _ in mutations += 1; return done }
    actions.project = { _, _ in Hosted(ref: HostResourceRef(host: HostRef(hostId: "local", daemonId: "local", lineageId: "l"), kind: .project, localId: project.id), value: project) }
    let model = GitHubImportModel(host: importHost, actions: actions)
    await model.refresh()
    #expect(mutations == 0 && model.operations == [done])
    #expect(await model.open(done) == nil)
    var receive: CheckedContinuation<GitHubImportPreview, any Error>?
    actions.preview = { _, _, _ in try await withCheckedThrowingContinuation { receive = $0 } }
    let pending = GitHubImportModel(host: importHost, actions: actions, initialURL: "https://github.com/owner/repo")
    let task = Task { await pending.checkDestination() }
    while receive == nil { await Task.yield() }
    pending.detach()
    let preview: GitHubImportPreview = try importFixture("{\"destination\":\"~/src/github.com/owner/repo\",\"resolvedDestination\":\"/remote/src/github.com/owner/repo\"}")
    receive?.resume(returning: preview); await task.value
    #expect(pending.preview == nil && !pending.canStart)
}

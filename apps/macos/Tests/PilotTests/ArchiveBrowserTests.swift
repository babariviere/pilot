import Combine
import Foundation
import PilotCore
import Testing
@testable import Pilot

private func archiveChat(_ id: String, project: String = "p1", mission: String? = "m1", archived: Double? = 10) -> SessionSummary {
    SessionSummary(id: id, title: "Archived \(id)", cwd: "/tmp", projectId: project, createdAt: 1,
                   updatedAt: 2, state: "idle", archivedAt: archived, missionId: mission)
}

private let archiveInventory = [archiveChat("older", archived: 5), archiveChat("newer"),
                                archiveChat("other-mission", mission: "m2"), archiveChat("solo", mission: nil),
                                archiveChat("other-project", project: "p2", mission: "m3"),
                                archiveChat("active", archived: nil)]

private final class ArchiveHTTPStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems ?? []
        let valid = request.httpMethod == "GET" && url.path == "/api/sessions"
            && query == [URLQueryItem(name: "archived", value: "true"),
                         URLQueryItem(name: "projectId", value: "project &/日本語"),
                         URLQueryItem(name: "missionId", value: "mission &/日本語")]
        let success = valid && url.host != "failed.invalid"
        let response = HTTPURLResponse(url: url, statusCode: success ? 200 : 400, httpVersion: nil, headerFields: nil)!
        let data = success ? try! JSONEncoder().encode([archiveChat("returned")]) : Data(#"{"error":"Archive request failed"}"#.utf8)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor private func archiveClient(_ host: String = "archive.invalid") -> PilotClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ArchiveHTTPStub.self]
    return PilotClient(baseURL: URL(string: "http://\(host)"), artifactSession: URLSession(configuration: config))
}

@Test @MainActor func archiveRequestUsesEncodedMissionAndProjectQuery() async throws {
    let filter = ArchiveFilter(projectId: "project &/日本語", missionId: "mission &/日本語")
    #expect(try await archiveClient().archivedSessions(filter: filter).map(\.id) == ["returned"])
    do {
        _ = try await archiveClient("failed.invalid").archivedSessions(filter: filter)
        Issue.record("HTTP errors must be surfaced")
    } catch { #expect(error.localizedDescription == "Archive request failed") }
    #expect(ArchiveFilter().queryItems == [URLQueryItem(name: "archived", value: "true")])
    #expect(ArchiveFilter(missionId: "m1").queryItems.last == URLQueryItem(name: "missionId", value: "m1"))
}

@Test func archiveFilterIncludesOnlyArchivedMembersAndSortsNewestFirst() {
    let filter = ArchiveFilter(projectId: "p1", missionId: "m1")
    #expect(filter.apply(to: archiveInventory).map(\.id) == ["newer", "older"])
    #expect(ArchiveFilter().apply(to: archiveInventory).count == 5)
    #expect(ArchiveFilter(projectId: "p2", missionId: "m1").apply(to: archiveInventory).isEmpty)
    #expect(ArchiveFilter(projectId: "p1").apply(to: archiveInventory).count == 4)
}

@Test @MainActor func archiveBrowserKeepsLiveRestoresAndMembershipChangesOverPendingGET() async {
    let state = ArchiveBrowserState()
    let filter = ArchiveFilter(missionId: "m1")
    var finish: CheckedContinuation<[SessionSummary], Never>?
    let request = Task { await state.load(filter) { await withCheckedContinuation { finish = $0 } } }
    while finish == nil { await Task.yield() }
    #expect(state.loading && state.sessions.isEmpty)
    state.receive([archiveChat("older", archived: nil), archiveChat("newer", mission: "m2"), archiveChat("added")], filter: filter)
    finish?.resume(returning: archiveInventory)
    await request.value
    #expect(!state.loading && state.error == nil)
    #expect(state.sessions.map(\.id) == ["added"])
    state.receive([], filter: filter)
    #expect(state.sessions.isEmpty)
    state.receive([archiveChat("first", archived: 20), archiveChat("second", archived: 10)], filter: filter)
    state.receive([archiveChat("second", archived: 30), archiveChat("first", archived: 20)], filter: filter)
    #expect(state.sessions.map(\.id) == ["second", "first"])
    // A same-sized replacement still removes departed members and keeps newest-first order.
    state.receive([archiveChat("replacement", archived: 15), archiveChat("second", archived: 30)], filter: filter)
    #expect(state.sessions.map(\.id) == ["second", "replacement"])
}

@Test @MainActor func archiveBrowserIgnoresObsoleteAndCancelledRequestsAndCanRetry() async {
    let state = ArchiveBrowserState()
    var finish: CheckedContinuation<[SessionSummary], Never>?
    let obsolete = Task { await state.load(ArchiveFilter(missionId: "m1")) { await withCheckedContinuation { finish = $0 } } }
    while finish == nil { await Task.yield() }
    await state.load(ArchiveFilter(missionId: "m2")) { archiveInventory }
    finish?.resume(returning: archiveInventory)
    await obsolete.value
    #expect(state.sessions.map(\.id) == ["other-mission"])
    await state.load(ArchiveFilter()) { throw ClientError("Offline") }
    #expect(state.error == "Offline" && state.sessions.isEmpty && !state.loading)
    await state.load(ArchiveFilter()) { [] }
    #expect(state.error == nil && state.sessions.isEmpty && !state.loading)
    finish = nil
    let cancelled = Task { await state.load(ArchiveFilter()) { await withCheckedContinuation { finish = $0 } } }
    while finish == nil { await Task.yield() }
    cancelled.cancel()
    finish?.resume(returning: archiveInventory)
    await cancelled.value
    #expect(state.error == nil && state.sessions.isEmpty && !state.loading)
}

@Test @MainActor func archiveNavigationPreservesMissionWhenReadingAndClearsItForGlobalOrOtherProject() throws {
    let app = AppModel()
    let detail = try JSONDecoder().decode(MissionDetail.self, from: Data(#"{"mission":{"id":"m1","projectId":"p1","title":"Goal","goal":"","status":"archived","briefRevision":1,"createdAt":1,"updatedAt":1},"decisions":[],"comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[]}"#.utf8))
    app.client.loadFixture(projects: [], sessions: archiveInventory)
    app.client.loadMissionFixture([detail])
    app.openMission("m1")
    app.showArchive(missionId: "m1")
    #expect(app.showingArchive && app.selectedMissionId == nil && app.selectedSessionId == nil)
    #expect(app.archiveFilter == ArchiveFilter(projectId: "p1", missionId: "m1"))
    // Selecting a row leaves the archive destination intact for the toolbar's back action.
    app.selectedSessionId = "newer"
    app.showArchive(in: app.archiveProjectId, missionId: app.archiveMissionId)
    #expect(app.archiveMissionId == "m1" && app.selectedSessionId == nil)
    app.chooseArchiveProject(nil)
    #expect(app.archiveMissionId == "m1")
    app.chooseArchiveProject("p2")
    #expect(app.archiveMissionId == nil)
    app.chooseArchiveMission("m1")
    #expect(app.archiveProjectId == "p1")
    app.chooseArchiveMission(nil)
    #expect(app.archiveMissionId == nil && app.archiveProjectId == "p1")
    app.showArchive(missionId: "m1")
    app.showArchive()
    #expect(app.archiveFilter == ArchiveFilter())
    app.showArchive(missionId: "deleted")
    #expect(app.archiveMissionId == nil)
}

@Test @MainActor func archiveFixturesUseTheSameFilterWithoutNetwork() async throws {
    let client = PilotClient()
    client.loadFixture(projects: [], sessions: archiveInventory)
    #expect(try await client.archivedSessions(filter: ArchiveFilter(missionId: "m1")).map(\.id) == ["newer", "older"])
}

@Test @MainActor func archiveStreamingWithLargeInventoryDoesNotRepublishUnchangedRows() async {
    var inventory: [SessionSummary] = []
    inventory.reserveCapacity(10_000)
    for index in 0..<10_000 {
        let mission: String = index % 3 == 0 ? "m1" : "m2"
        let archivedAt: Double? = index % 10 == 0 ? Double(index) : nil
        inventory.append(archiveChat("chat-\(index)", mission: mission, archived: archivedAt))
    }
    let filter = ArchiveFilter(projectId: "p1", missionId: "m1")
    let state = ArchiveBrowserState()
    await state.load(filter) { inventory }
    #expect(state.sessions.count == 334)
    var publishes = 0
    let subscription = state.$sessions.dropFirst().sink { _ in publishes += 1 }
    var streaming = inventory
    streaming[1] = archiveChat("stream", archived: nil)
    let baseline = Date()
    for event in 0..<100 {
        streaming[1] = archiveChat("stream-\(event)", archived: nil)
        let archived: [SessionSummary] = streaming.filter { $0.isArchived }
        let narrowed: [SessionSummary] = archived.filter { $0.projectId == "p1" && $0.missionId == "m1" }
        _ = narrowed.sorted { ($0.archivedAt ?? 0) > ($1.archivedAt ?? 0) }
    }
    let baselineMs = Date().timeIntervalSince(baseline) * 1000
    let start = Date()
    for event in 0..<100 {
        // Incoming active-session activity changes the inventory, not the archive's visible rows.
        streaming[1] = archiveChat("stream-\(event)", archived: nil)
        state.receive(streaming, filter: filter)
    }
    let elapsedMs = Date().timeIntervalSince(start) * 1000
    #expect(publishes == 0)
    print("archive benchmark: 10,000 chats, 100 updates, legacy filtering \(baselineMs) ms, live reconciliation \(elapsedMs) ms")
    withExtendedLifetime(subscription) {}
}

import AppKit
import PilotCore
import Testing
@testable import Pilot

private let clipboardLocal = HostRef(hostId: "local", daemonId: "local-daemon", lineageId: "local-lineage")
private let clipboardRemote = HostRef(hostId: "box", daemonId: "remote-daemon", lineageId: "remote-lineage")
private let clipboardSessionID = "abee494b-d1a8-484c-a57b-669148815d37"

@Test @MainActor func sessionClipboardUsesAuthoritativeCustomHomeForParkedAndArchivedChats() throws {
    let path = "/srv/custom-pilot/sessions/\(clipboardSessionID)"
    let session = SessionSummary(id: clipboardSessionID, title: "Parked", cwd: "/work/repository",
                                 createdAt: 1, updatedAt: 2, state: "parked", archivedAt: 3,
                                 sessionPath: path)
    let reference = HostResourceRef(host: clipboardRemote, kind: .session, localId: session.id)
    let target = try #require(SessionClipboardTarget(session: session, reference: reference))
    #expect(target.sessionPath == path)
    #expect(target.sessionPath != session.cwd)
    #expect(target.chatURL == "pilot://chat/\(clipboardSessionID)")

    let board = NSPasteboard(name: .init("pilot-session-copy-\(UUID())"))
    defer { board.releaseGlobally() }
    #expect(target.copyPath(to: board))
    #expect(board.string(forType: .string) == path)
    #expect(target.copyLink(to: board))
    #expect(board.string(forType: .string) == "pilot://chat/\(clipboardSessionID)")
}

@Test @MainActor func unavailablePathDoesNotDisableCanonicalLink() throws {
    for path in [nil, "relative/session", ""] as [String?] {
        let session = SessionSummary(id: clipboardSessionID, title: "Cached", cwd: "/work",
                                     createdAt: 1, updatedAt: 2, state: "idle", sessionPath: path)
        let target = try #require(SessionClipboardTarget(session: session,
            reference: HostResourceRef(host: clipboardRemote, kind: .session, localId: session.id)))
        #expect(target.sessionPath == nil)
        #expect(target.chatURL == "pilot://chat/\(clipboardSessionID)")
        let board = NSPasteboard(name: .init("pilot-session-unavailable-\(UUID())"))
        board.setString("keep", forType: .string)
        #expect(!target.copyPath(to: board))
        #expect(board.string(forType: .string) == "keep")
        #expect(target.copyLink(to: board))
        #expect(board.string(forType: .string) == "pilot://chat/\(clipboardSessionID)")
        board.releaseGlobally()
    }
}

@Test @MainActor func copiedLocalAndDevboxLinksResolveThroughTrustedHostInventories() async throws {
    let localSession = SessionSummary(id: "11111111-1111-4111-8111-111111111111", title: "Local", cwd: "/local",
                                      createdAt: 1, updatedAt: 2, state: "idle", sessionPath: "/home/pilot/sessions/local")
    let remoteSession = SessionSummary(id: clipboardSessionID, title: "Remote", cwd: "/remote",
                                       createdAt: 1, updatedAt: 2, state: "idle", archivedAt: 3,
                                       sessionPath: "/srv/pilot/sessions/remote")
    let localClient = PilotClient()
    localClient.loadFixture(projects: [], sessions: [localSession])
    let app = AppModel(client: localClient)
    try app.registerLocal(clipboardLocal)
    try app.hosts.install(localClient, host: clipboardLocal)
    let remoteClient = PilotClient()
    remoteClient.loadFixture(projects: [], sessions: [remoteSession])
    try app.hosts.install(remoteClient, host: clipboardRemote)

    let localTarget = try #require(SessionClipboardTarget(session: localSession,
        reference: HostResourceRef(host: clipboardLocal, kind: .session, localId: localSession.id)))
    let remoteTarget = try #require(SessionClipboardTarget(session: remoteSession,
        reference: HostResourceRef(host: clipboardRemote, kind: .session, localId: remoteSession.id)))
    await app.hosts.disconnect(clipboardRemote)
    let localLink = try #require(localTarget.chatURL)
    let localURL = try #require(URL(string: localLink))
    app.reveal(chat: try #require(ChatDestination(url: localURL)))
    #expect(app.selectedSessionId == localSession.id)
    let remoteLink = try #require(remoteTarget.chatURL)
    let remoteURL = try #require(URL(string: remoteLink))
    app.reveal(chat: try #require(ChatDestination(url: remoteURL)))
    #expect(app.selectedSessionId == HostResourceRef(host: clipboardRemote, kind: .session,
                                                     localId: remoteSession.id).storageKey)
    #expect(app.hosts.selection?.host == clipboardRemote)

    let setup = DiagnosticSetupTarget(reference: HostResourceRef(host: clipboardRemote, kind: .session,
                                                                  localId: remoteSession.id),
                                      askingAboutPilot: true, tracksFeature: false)
    let resolved = try DiagnosticSetup.resolve(remoteLink, setup: setup,
                                               localHost: clipboardLocal, local: localClient.sessions,
                                               hosted: app.hosts.sessions)
    #expect(resolved.reference.host == clipboardRemote)
    #expect(app.client.fixtureSpawnRequests.isEmpty)
    #expect(remoteClient.fixtureSpawnRequests.isEmpty)
}

@Test @MainActor func ambiguousChatLinkDoesNotChooseAHost() throws {
    let session = SessionSummary(id: clipboardSessionID, title: "Collision", cwd: "/work",
                                 createdAt: 1, updatedAt: 2, state: "idle", sessionPath: "/pilot/session")
    let localClient = PilotClient(); localClient.loadFixture(projects: [], sessions: [session])
    let app = AppModel(client: localClient)
    try app.registerLocal(clipboardLocal); try app.hosts.install(localClient, host: clipboardLocal)
    let remoteClient = PilotClient(); remoteClient.loadFixture(projects: [], sessions: [session])
    try app.hosts.install(remoteClient, host: clipboardRemote)
    let url = try #require(URL(string: "pilot://chat/\(clipboardSessionID)"))
    let link = try #require(ChatDestination(url: url))
    app.reveal(chat: link)
    #expect(app.selectedSessionId == nil)
    #expect(app.sessionActionError?.contains("more than one host") == true)
    #expect(app.client.fixtureSpawnRequests.isEmpty)
    #expect(remoteClient.fixtureSpawnRequests.isEmpty)
}

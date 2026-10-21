import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func qualifiedNavigationAndFeedsKeepCollidingChatsSeparate() throws {
    let app = AppModel()
    let local = HostRef(hostId: "local", daemonId: "a", lineageId: "1")
    let remote = HostRef(hostId: "box", daemonId: "b", lineageId: "2")
    try app.registerLocal(local)
    let localRef = HostResourceRef(host: local, kind: .session, localId: "same")
    let remoteRef = HostResourceRef(host: remote, kind: .session, localId: "same")
    let first = app.feeds.feed(ref: localRef, hosts: app.hosts)
    let second = app.feeds.feed(ref: remoteRef, hosts: app.hosts)
    #expect(first !== second)
    #expect(app.feeds.feed(ref: remoteRef, hosts: app.hosts) === second)
    try app.selectSession(remoteRef)
    #expect(app.hosts.selection == remoteRef)
    #expect(app.selectedSessionId == remoteRef.storageKey)
    #expect(app.resourceRef("same", kind: .session) == localRef)
    #expect(app.resourceRef("same", kind: .session, context: HostViewContext(host: remote, hosts: app.hosts)) == remoteRef)
}

@Test @MainActor func localProjectOverviewNormalizesQualifiedKeysWithoutChangingRemoteDestinations() throws {
    let app = AppModel()
    let local = HostRef(hostId: "local", daemonId: "a", lineageId: "1")
    let remote = HostRef(hostId: "box", daemonId: "b", lineageId: "2")
    try app.registerLocal(local)
    let project = Project(id: "same", name: "Repository", path: "/repo", createdAt: 1)
    app.client.loadFixture(projects: [project], sessions: [])
    let localRef = HostResourceRef(host: local, kind: .project, localId: project.id)
    let remoteRef = HostResourceRef(host: remote, kind: .project, localId: project.id)
    app.openProject(localRef.storageKey)
    #expect(app.selectedProjectId == project.id)
    app.openProject(remoteRef.storageKey)
    #expect(app.selectedProjectId == remoteRef.storageKey)
    #expect(app.hosts.selection == remoteRef)
    app.focus(on: project.id)
    app.openHome()
    app.openOverview()
    #expect(app.selectedProjectId == project.id)
    #expect(app.currentSelection == .project(project.id))
    #expect(app.hosts.selection == nil)
}

@Test @MainActor func unqualifiedNavigationStillRequiresTheLocalIdentity() {
    let app = AppModel()
    app.navigate(.session, id: "same")
    #expect(app.selectedSessionId == nil)
    #expect(app.hosts.selection == nil)
    app.navigate(.project, id: "hostref1:invalid")
    #expect(app.selectedProjectId == nil)
    #expect(app.hosts.selection == nil)
}

@Test @MainActor func retiredProjectScopeStartsLocalWithoutRetargetingSavedRemoteDraft() async throws {
    let app = AppModel()
    let local = HostRef(hostId: "local", daemonId: "a", lineageId: "1")
    let remote = HostRef(hostId: "box", daemonId: "b", lineageId: "2")
    try app.registerLocal(local)
    let project = Project(id: "same", name: "Repository", path: "/same/repo", createdAt: 0)
    app.client.loadFixture(projects: [project], sessions: [])
    let remoteClient = PilotClient()
    remoteClient.loadFixture(projects: [project], sessions: [])
    try loadClientFixture(remoteClient, host: remote, into: app.hosts)
    let context = HostViewContext(host: remote, hosts: app.hosts)
    let ref = context.ref(.project, "same")
    app.focus(on: ref.storageKey)
    #expect(app.focusedProjectRef == ref)
    #expect(app.hosts.selection == ref)
    app.newChatInScope()
    // Match the composer's destination resolution: nil means the installed Local host.
    #expect((app.newSessionForm.executionHost ?? app.localHost) == local)
    #expect(app.newSessionForm.executionHost != remote)
    // A draft restored from an older release still retains its original remote identity.
    app.newSessionForm.executionHost = remote
    app.newSessionForm.message = "Keep this remote draft"
    app.openHome()
    #expect(app.newSessionForm.executionHost == remote)
    #expect(app.newSessionForm.message == "Keep this remote draft")
    await app.hosts.disconnect(remote)
    app.openMemory("same", context: context)
    #expect(app.memoryProjectId == ref.storageKey)
    #expect(app.hosts.selection == ref)
    #expect(app.hosts.presentationClient(remote) !== app.client)
    app.showInbox(for: "same", context: context)
    #expect(app.inboxHost == remote)
    #expect(app.inboxProjectId == "same")
    app.focus(on: nil)
}

@Test @MainActor func offlinePresentationRetainsLatestRemoteSummaryWithoutLocalFallback() async throws {
    let host = HostRef(hostId: "box", daemonId: "b", lineageId: "2")
    let hosts = ClientDirectory()
    let initial = hosts.presentationClient(host)
    let live = PilotClient()
    live.loadFixture(projects: [], sessions: [SessionSummary(id: "same", title: "Latest remote", cwd: "/repo", createdAt: 0, updatedAt: 42, state: "working")])
    try loadClientFixture(live, host: host, into: hosts)
    #expect(hosts.presentationClient(host) !== live)
    await hosts.disconnect(host)
    let offline = hosts.presentationClient(host)
    #expect(offline === initial)
    #expect(offline.session("same")?.title == "Latest remote")
    #expect(offline.session("same")?.state == "working")
    #expect(!offline.connected)
    var called = false
    do { try await HostViewContext(host: host, hosts: hosts).perform(.session, "same") { _, _ in called = true } }
    catch { #expect(error as? HostRoutingError == .disconnected) }
    #expect(!called)
}

@Test @MainActor func remotePaletteConfirmationAndOfflineRetryKeepTheOriginalHost() throws {
    let app = AppModel()
    let local = HostRef(hostId: "local", daemonId: "a", lineageId: "1")
    let remote = HostRef(hostId: "box", daemonId: "b", lineageId: "2")
    try app.registerLocal(local)
    let ref = HostResourceRef(host: remote, kind: .session, localId: "same")
    let pr = SessionPullRequest(number: 1, url: "https://github.com/o/r/pull/1", title: "PR", state: .open, checkedAt: 1)
    let session = SessionSummary(id: "same", title: "Remote", cwd: "/repo", projectId: "p", createdAt: 0, updatedAt: 0, state: "failed", pullRequests: [pr])
    let catalog = CommandPaletteCatalog(model: app, openSettings: {}, openKeyboardShortcuts: {})
    let actions = catalog.chatActions(session, reference: ref)
    let merge = try #require(actions.first { $0.item.id.contains("merge-pr") })
    merge.perform()
    #expect(app.mergingPullRequest?.reference == ref)
    #expect(app.mergingPullRequest?.sessionId == "same")
    let retry = try #require(actions.first { $0.item.id.contains("action:retry:") })
    retry.perform()
    #expect(app.pendingRetry == nil)
    #expect(app.sessionActionError?.contains("Disconnected") == true)
}

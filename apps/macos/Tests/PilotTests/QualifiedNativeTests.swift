import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func sharedVersionLimitsRejectExtremeIntegersBeforeArithmetic() async throws {
    let host = HostRef(hostId: "box", daemonId: "daemon", lineageId: "history")
    let client = PilotClient()
    try client.bind(host)
    let project = SharedProjectRef(host: OperationHost(host), projectId: "project")
    let binding = SharedContextBinding(bindingId: "binding", generation: 1, logicalProjectId: "logical",
        memoryHome: project, missionHome: OperationHost(host), executionProject: project,
        missionIds: ["mission"], shareMemory: true)
    for limit in [Int.min, -1, 0, 129, Int.max] {
        do {
            _ = try await client.sharedMissionVersions(binding, missionId: "mission", limit: limit)
            Issue.record("Invalid version page limit was accepted")
        } catch { #expect(error as? HostRoutingError == .invalidReference) }
    }
}

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

@Test @MainActor func remoteProjectScopeNavigationAndUnsentDraftNeverChangeHost() async throws {
    let app = AppModel()
    let local = HostRef(hostId: "local", daemonId: "a", lineageId: "1")
    let remote = HostRef(hostId: "box", daemonId: "b", lineageId: "2")
    try app.registerLocal(local)
    let project = Project(id: "same", name: "Repository", path: "/same/repo", createdAt: 0)
    app.client.loadFixture(projects: [project], sessions: [])
    let remoteClient = PilotClient()
    remoteClient.loadFixture(projects: [project], sessions: [])
    try app.hosts.install(remoteClient, host: remote)
    let context = HostViewContext(host: remote, hosts: app.hosts)
    let ref = context.ref(.project, "same")
    app.focus(on: ref.storageKey)
    #expect(app.focusedProjectRef == ref)
    #expect(app.hosts.selection == ref)
    app.newChatInScope()
    #expect(app.newSessionForm.executionHost == remote)
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
    let hosts = HostClients()
    let initial = hosts.presentationClient(host)
    let live = PilotClient()
    live.loadFixture(projects: [], sessions: [SessionSummary(id: "same", title: "Latest remote", cwd: "/repo", createdAt: 0, updatedAt: 42, state: "working")])
    try hosts.install(live, host: host)
    #expect(hosts.presentationClient(host) === live)
    await hosts.disconnect(host)
    let offline = hosts.presentationClient(host)
    #expect(offline !== initial)
    #expect(offline.session("same")?.title == "Latest remote")
    #expect(offline.session("same")?.state == "working")
    #expect(!offline.connected)
    var called = false
    do { try await HostViewContext(host: host, hosts: hosts).perform(.session, "same") { _, _ in called = true } }
    catch { #expect(error as? HostRoutingError == .disconnected) }
    #expect(!called)
}

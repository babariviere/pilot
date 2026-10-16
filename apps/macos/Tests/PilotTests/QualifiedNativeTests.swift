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

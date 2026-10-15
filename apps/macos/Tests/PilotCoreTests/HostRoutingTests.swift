import Foundation
import Testing
@testable import PilotCore

private let localHost = HostRef(hostId: "local", daemonId: "same", lineageId: "a")
private let remoteHost = HostRef(hostId: "devbox", daemonId: "same", lineageId: "a")

@Test func qualifiedKeysNeverAliasPathsOrIDsAcrossHosts() throws {
    let local = HostResourceRef(host: localHost, kind: .session, localId: "/same:path/雪")
    let remote = HostResourceRef(host: remoteHost, kind: .session, localId: local.localId)
    #expect(local != remote)
    #expect(local.storageKey != remote.storageKey)
    #expect(try HostResourceRef.decodeKey(local.storageKey) == local)
    let drafts = try HostKeyMigration.local(["old": "local draft", remote.storageKey: "remote draft"],
                                             host: localHost, kind: .session)
    #expect(drafts[remote.storageKey] == "remote draft")
    #expect(drafts[HostResourceRef(host: localHost, kind: .session, localId: "old").storageKey] == "local draft")
}

@Test func migrationDoesNotOverwriteQualifiedDrafts() throws {
    let ref = HostResourceRef(host: localHost, kind: .session, localId: "id")
    #expect(throws: HostRoutingError.migrationConflict) {
        try HostKeyMigration.local(["id": "legacy", ref.storageKey: "qualified"], host: localHost, kind: .session)
    }
}

@Test func lateSnapshotsAndDisconnectCannotChangeOtherPartitionsOrOutcomes() throws {
    var local = HostPartition(host: localHost, values: ["id": "working"])
    var remote = HostPartition(host: remoteHost, values: ["id": "working remotely"])
    let old = remote.connect()
    remote.disconnect()
    #expect(remote.values["id"] == "working remotely")
    let current = remote.connect()
    #expect(throws: HostRoutingError.staleGeneration) { try remote.replace(["id": "stopped"], token: old) }
    try remote.replace(["id": "complete"], token: current)
    #expect(local.values["id"] == "working")
    let localToken = local.connect()
    #expect(throws: HostRoutingError.staleGeneration) { try remote.replace([:], token: localToken) }
}

@Test func contextHomesBindingAndSocketGenerationsRemainIndependent() throws {
    let execution = HostResourceRef(host: remoteHost, kind: .project, localId: "/same/path")
    let memory = HostResourceRef(host: localHost, kind: .project, localId: "/same/path")
    let binding = try ProjectBinding(logicalProjectId: "logical", bindingId: "binding", generation: 4,
                                    executionProject: execution, memoryHome: memory, missionHome: localHost)
    var partition = HostPartition<String>(host: remoteHost)
    let first = partition.connect()
    let second = partition.connect()
    #expect(first != second)
    #expect(binding.generation == 4)
    #expect(binding.memoryHome.host != binding.executionProject.host)
}


import Foundation
import Testing
@testable import PilotCore

@Test func sharedOperationIdentityRequiresPinsNotAliasOrCoincidentLocalIDs() {
    let identity = OperationHost(daemonId: "installation", lineageId: "history")
    #expect(identity.matches(HostRef(hostId: "box", daemonId: "installation", lineageId: "history")))
    #expect(!identity.matches(HostRef(hostId: "box", daemonId: "installation", lineageId: "restored")))
    #expect(!identity.matches(HostRef(hostId: "daemon", daemonId: "another", lineageId: "history")))
    #expect(!OperationHost(hostId: "box", daemonId: "installation", lineageId: "history")
        .matches(HostRef(hostId: "box", daemonId: "installation", lineageId: "history")))
}

@Test func sharedMemoryCASNullAndHostQualifiedProvenanceSurviveRoundTrip() throws {
    let source = """
    {"operationId":"original","payloadHash":"hash","noteId":"stable-note",
     "origin":{"host":{"hostId":"daemon","daemonId":"a","lineageId":"1"},"sessionId":"same"},
     "text":"provisional correction","replaces":[{"id":"old-note","expectedReplacementId":null}]}
    """
    let mutation = try JSONDecoder().decode(SharedMemoryMutation.self, from: Data(source.utf8))
    let encoded = try JSONValue.decode(JSONEncoder().encode(mutation))
    #expect(encoded["replaces"]?.array?.first?["expectedReplacementId"] == .null)
    #expect(mutation.origin.host.daemonId == "a")
    let entry = try JSONDecoder().decode(MemoryEntry.self, from: Data("""
    {"index":1,"id":"stable-note","deviceId":"device","at":0,"sessionId":"same","text":"note",
     "sharedOrigin":{"host":{"hostId":"daemon","daemonId":"a","lineageId":"1"},"sessionId":"same"}}
    """.utf8))
    #expect(entry.sharedOrigin?.host.daemonId == "a")
    #expect(try JSONDecoder().decode(MemoryEntry.self, from: JSONEncoder().encode(entry)) == entry)
}

@Test func sharedContextChangeFrameDecodesWithoutRefreshingUnrelatedLists() throws {
    let update = try ServerUpdate.decode(Data("{\"type\":\"shared-contexts.changed\"}".utf8))
    guard case .sharedContextsChanged? = update else {
        Issue.record("Shared-context invalidation was dropped"); return
    }
}

@Test func sharedMemoryOverlayRevisionIsAdditiveAndDistinguishesSameCountWrites() throws {
    let legacy = "{\"sequence\":5,\"complete\":true,\"pendingCount\":1,\"conflictCount\":0}"
    let previous = try JSONDecoder().decode(SharedMemoryReplicaState.self, from: Data(legacy.utf8))
    #expect(previous.overlayRevision == nil)
    let first = try JSONDecoder().decode(SharedMemoryReplicaState.self, from: Data("""
    {"sequence":5,"complete":true,"pendingCount":1,"conflictCount":0,"overlayRevision":7}
    """.utf8))
    let next = try JSONDecoder().decode(SharedMemoryReplicaState.self, from: Data("""
    {"sequence":5,"complete":true,"pendingCount":1,"conflictCount":0,"overlayRevision":8}
    """.utf8))
    #expect(first.pendingCount == next.pendingCount)
    #expect(first != next)
    #expect(try JSONDecoder().decode(SharedMemoryReplicaState.self, from: JSONEncoder().encode(next)) == next)
    #expect(try JSONValue.decode(JSONEncoder().encode(next))["overlayRevision"]?.int == 8)
}

@Test func sharedMissionProposalKeepsAssignedIDAndStillReadsOlderRecords() throws {
    let legacy = """
    {"proposalId":"proposal","missionId":"mission","entityId":"provisional-task","expectedRevision":0,
     "action":"task","args":{"title":"A task"},"state":"committed",
     "origin":{"host":{"hostId":"daemon","daemonId":"target","lineageId":"history"},"sessionId":"session"}}
    """
    var object = try #require(JSONSerialization.jsonObject(with: Data(legacy.utf8)) as? [String: Any])
    let previous = try JSONDecoder().decode(SharedMissionProposal.self, from: Data(legacy.utf8))
    #expect(previous.canonicalId == nil)
    #expect(try JSONDecoder().decode(SharedMissionProposal.self, from: JSONEncoder().encode(previous)) == previous)
    object["canonicalId"] = "assigned-task"
    let current = try JSONDecoder().decode(SharedMissionProposal.self,
        from: JSONSerialization.data(withJSONObject: object))
    #expect(current.canonicalId == "assigned-task")
    #expect(try JSONDecoder().decode(SharedMissionProposal.self, from: JSONEncoder().encode(current)) == current)
    #expect(try JSONValue.decode(JSONEncoder().encode(current))["canonicalId"]?.string == "assigned-task")
}

@Test func delegatedWorkKeepsOnlineOnlyLinksAndStillReadsOlderRecords() throws {
    let legacy = """
    {"delegationId":"delegation","executionEpoch":1,"bindingId":"binding","bindingGeneration":1,
     "task":{"mission":{"home":{"hostId":"daemon","daemonId":"home","lineageId":"h"},
                          "missionId":"mission"},"taskId":"task"},
     "target":{"host":{"hostId":"daemon","daemonId":"target","lineageId":"t"},"projectId":"project"},
     "session":{"host":{"hostId":"daemon","daemonId":"target","lineageId":"t"},"sessionId":"session"},
     "definitionRevision":1,"context":{"memory":2,"mission":3},"manifestId":"manifest",
     "references":[],"request":{"message":"Complete this task"},"state":"accepted"}
    """
    let base = try #require(JSONSerialization.jsonObject(with: Data(legacy.utf8)) as? [String: Any])
    let variants: [[String]?] = [nil, [], ["https://example.invalid/reference"]]
    for urls in variants {
        var object = base
        if let urls { object["onlineOnlyUrls"] = urls }
        let grant = try JSONDecoder().decode(DelegationGrant.self,
            from: JSONSerialization.data(withJSONObject: object))
        #expect(grant.onlineOnlyUrls == urls)
        let encoded = try JSONEncoder().encode(grant)
        let recovered = try JSONDecoder().decode(DelegationGrant.self, from: encoded)
        #expect(recovered.onlineOnlyUrls == urls)
        #expect(recovered.delegationId == grant.delegationId)
        #expect(recovered.request.message == grant.request.message)
        let wire = try JSONValue.decode(encoded)
        #expect(wire["onlineOnlyUrls"]?.array?.compactMap(\.string) == urls)
    }
}

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

@Test func sharedTaskVersionsKeepDefinitionChangesSeparateFromProgress() throws {
    let legacy = try JSONDecoder().decode(SharedEntity.self, from: Data("""
    {"id":"task","kind":"task","revision":21,"deleted":false,"value":{"title":"Committed task"}}
    """.utf8))
    #expect(legacy.definitionRevision == nil)
    let page = try JSONDecoder().decode(SharedMissionVersions.self, from: Data("""
    {"bindingId":"binding","generation":3,"missionId":"same",
     "authority":{"hostId":"daemon","daemonId":"home","lineageId":"history"},
     "source":"replica","sequence":42,"complete":true,"next":2,
     "entities":[{"id":"task","kind":"task","revision":21,"definitionRevision":4,"deleted":false},
                 {"id":"removed","kind":"decision","revision":9,"deleted":true}]}
    """.utf8))
    #expect(page.entities[0].revision == 21)
    #expect(page.entities[0].definitionRevision == 4)
    #expect(page.entities[1].definitionRevision == nil)
    #expect(page.entities[1].deleted)
    #expect(page.source == .replica)
    #expect(page.sequence == 42 && page.next == 2)
    #expect(try JSONDecoder().decode(SharedMissionVersions.self, from: JSONEncoder().encode(page)) == page)
    #expect(try JSONDecoder().decode(SharedEntity.self, from: JSONEncoder().encode(legacy)) == legacy)
}

@Test func sharedMissionReadKeepsPendingEditsOutsideSavedMission() throws {
    let read = try JSONDecoder().decode(SharedMissionRead.self, from: Data("""
    {"bindingId":"binding","generation":3,
     "authority":{"hostId":"daemon","daemonId":"home","lineageId":"history"},"source":"canonical",
     "snapshot":{"missionId":"same","sequence":42,
       "detail":{"mission":{"id":"same","projectId":"project","title":"Saved title","goal":"Goal",
                            "status":"active","briefRevision":0,"createdAt":0,"updatedAt":0},
                 "decisions":[],"comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[]},
       "entities":[{"id":"task","kind":"task","revision":21,"definitionRevision":4,"deleted":false}]},
     "proposals":[{"proposalId":"proposal","missionId":"same","entityId":"task","expectedRevision":20,
                    "action":"task","args":{"title":"Proposed title"},"state":"conflict",
                    "origin":{"host":{"hostId":"daemon","daemonId":"target","lineageId":"target-history"},
                               "sessionId":"same"}}]}
    """.utf8))
    #expect(read.snapshot.detail.mission.title == "Saved title")
    #expect(read.snapshot.entities[0].definitionRevision == 4)
    #expect(read.proposals.first?.state == .conflict)
    #expect(read.proposals.first?.args["title"]?.string == "Proposed title")
    #expect(try JSONDecoder().decode(SharedMissionRead.self, from: JSONEncoder().encode(read)) == read)
}

@Test func sharedMemoryTreeReadKeepsPendingNotesAndTruncationVisible() throws {
    let read = try JSONDecoder().decode(SharedMemoryTreeRead.self, from: Data("""
    {"state":{"sequence":2,"complete":true,"pendingCount":1,"conflictCount":0,"overlayRevision":5},
     "value":{"count":2,"nodes":[{"lo":0,"hi":1,"text":"Raw notes","children":[{"lo":0,"hi":0}]}],
              "truncated":true},
     "proposals":[{"state":"pending","mutation":{"operationId":"original","payloadHash":"hash",
                    "noteId":"pending-note","text":"Saved here, not shared yet","replaces":[],
                    "origin":{"host":{"hostId":"daemon","daemonId":"target","lineageId":"target-history"},
                               "sessionId":"same"}}}]}
    """.utf8))
    #expect(read.value.truncated)
    #expect(read.value.nodes.first?.children?.count == 1)
    #expect(read.state.overlayRevision == 5)
    #expect(read.proposals.first?.mutation.noteId == "pending-note")
    #expect(try JSONDecoder().decode(SharedMemoryTreeRead.self, from: JSONEncoder().encode(read)) == read)
}

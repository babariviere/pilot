import Foundation
import PilotCore
import Testing
@testable import Pilot

private func sharingDecode<T: Decodable>(_ object: Any, as type: T.Type = T.self) throws -> T {
    try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
}
private func sharingObject<T: Encodable>(_ value: T) throws -> Any {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
}

@MainActor
private final class SharingFake: SharedProjectService {
    let readingHost = HostRef(hostId: "home-alias", daemonId: "home", lineageId: "h")
    let targetHost = HostRef(hostId: "box-alias", daemonId: "box", lineageId: "b")
    var placementIntents: any SharedPlacementIntentStorage = SharedPlacementIntentStore()
    var binding: SharedContextBinding
    var memoryValue: SharedMemoryRead
    var missionValue: SharedMissionRead
    var pages: [Int: SharedMissionVersions] = [:]
    var grants: [DelegationGrant] = []
    var foreignGrants: [DelegationGrant] = []
    var versionRequests: [(Int, Int?)] = []
    var placementRequests: [SharedPlacementRequest] = []
    var resolutionRevisions: [Int] = []
    var offline = false
    var loseStartReply = false
    var acceptStart = true
    var rejectResolution = false
    var availableModels = ModelList(models: [ModelOption(id: "target/model", provider: "target", name: "Target model")])

    init() throws {
        let home = OperationHost(daemonId: "home", lineageId: "h")
        binding = SharedContextBinding(bindingId: "link", generation: 3, logicalProjectId: "logical",
            memoryHome: SharedProjectRef(host: home, projectId: "memory-not-workspace"), missionHome: home,
            executionProject: SharedProjectRef(host: OperationHost(daemonId: "box", lineageId: "b"), projectId: "same"),
            missionIds: ["same"], shareMemory: true)
        memoryValue = try sharingDecode([
            "state": ["sequence": 2, "complete": true, "pendingCount": 1, "conflictCount": 0],
            "value": ["count": 2, "nodes": [], "omittedBefore": 0, "text": "Saved"],
            "proposals": [["state": "pending", "mutation": ["operationId": "pending", "payloadHash": "hash",
                "noteId": "stable", "origin": ["host": try sharingObject(OperationHost(daemonId: "box", lineageId: "b")),
                                               "sessionId": "same"], "text": "Pending note", "replaces": []]]]
        ])
        let mission = Mission(id: "same", projectId: "same", title: "Mission", goal: "Goal", createdAt: 0, updatedAt: 0)
        let task = MissionTask(id: "same", number: 1, title: "Saved task")
        missionValue = try sharingDecode([
            "bindingId": "link", "generation": 3, "authority": try sharingObject(home), "source": "canonical",
            "snapshot": ["missionId": "same", "sequence": 42,
                "detail": ["mission": try sharingObject(mission), "tasks": [try sharingObject(task)],
                           "decisions": [], "comments": [], "artifacts": [], "resources": [], "events": []],
                "entities": [["id": "same", "kind": "task", "revision": 22, "definitionRevision": 5,
                              "deleted": false, "value": ["title": "Saved task"]]]],
            "proposals": []
        ])
        pages[0] = try page(entities: [["id": "same", "kind": "task", "revision": 22, "definitionRevision": 5, "deleted": false]])
    }
    func page(entities: [[String: Any]], sequence: Int = 42, next: Int? = nil, generation: Int = 3) throws -> SharedMissionVersions {
        var value: [String: Any] = ["bindingId": "link", "generation": generation, "missionId": "same",
            "authority": try sharingObject(binding.missionHome), "source": "canonical", "sequence": sequence,
            "complete": true, "entities": entities]
        if let next { value["next"] = next }
        return try sharingDecode(value)
    }
    func proposal() throws -> SharedMissionProposal {
        try sharingDecode(["proposalId": "edit", "missionId": "same", "entityId": "same", "expectedRevision": 1,
            "action": "task", "args": ["title": "Proposed task"], "state": "conflict",
            "origin": ["host": try sharingObject(binding.executionProject.host), "sessionId": "same"]])
    }
    func makeGrant(state: String = "accepted", epoch: Int = 1) throws -> DelegationGrant {
        try sharingDecode(["delegationId": "allocation", "bindingId": "link", "bindingGeneration": 3,
            "task": ["mission": ["home": try sharingObject(binding.missionHome), "missionId": "same"], "taskId": "same"],
            "executionEpoch": epoch, "target": try sharingObject(binding.executionProject),
            "session": ["host": try sharingObject(binding.executionProject.host), "sessionId": "same"],
            "definitionRevision": 5, "context": ["memory": 2, "mission": 42], "manifestId": "manifest",
            "references": [], "request": ["message": "Accepted scope", "model": "target/model"], "state": state])
    }
    func summary() throws -> SharedContextSummary {
        try sharingDecode(["binding": try sharingObject(binding), "grants": try sharingObject(grants),
            "freshness": ["applied": ["memory": 2, "mission": 42], "complete": true, "pendingCount": 0, "conflictCount": 0]])
    }
    func memory(regex: String?) async throws -> SharedMemoryRead {
        if offline { throw HostRoutingError.disconnected }; return memoryValue
    }
    func tree(range: MemoryRange?, depth: Int) async throws -> SharedMemoryTreeRead {
        if offline { throw HostRoutingError.disconnected }
        return try sharingDecode(["state": try sharingObject(memoryValue.state),
            "value": try sharingObject(MemoryTree(count: 2, nodes: [])), "proposals": try sharingObject(memoryValue.proposals)])
    }
    func mission(_ id: String) async throws -> SharedMissionRead {
        if offline { throw HostRoutingError.disconnected }; return missionValue
    }
    func versions(_ id: String, after: Int, sequence: Int?) async throws -> SharedMissionVersions {
        versionRequests.append((after, sequence))
        guard !offline, let page = pages[after] else { throw HostRoutingError.disconnected }; return page
    }
    func inventory() async throws -> SharedContextSummary {
        if offline { throw HostRoutingError.disconnected }; return try summary()
    }
    func taskAllocations(missionId: String, taskId: String) async throws -> [DelegationGrant] {
        if offline { throw HostRoutingError.disconnected }; return grants + foreignGrants
    }
    func targetModels() async throws -> ModelList {
        if offline { throw HostRoutingError.disconnected }; return availableModels
    }
    func reserve(missionId: String, taskId: String, request: SharedPlacementRequest) async throws -> DelegationGrant {
        placementRequests.append(request)
        let previous = (grants + foreignGrants).map(\.executionEpoch).max() ?? 0
        guard request.expectedPreviousEpoch == previous else { throw ClientError("Execution changed", status: 409) }
        let grant = try makeGrant(epoch: previous + 1)
        if acceptStart { grants = [grant] }
        if loseStartReply { throw HostRoutingError.staleGeneration }
        return grant
    }
    func cancel(_ grant: DelegationGrant) async throws -> DelegationGrant {
        let requested = try makeGrant(state: "cancel_requested"); grants = [requested]; return requested
    }
    func confirmStopped(_ grant: DelegationGrant) async throws -> SharedReleaseCheck {
        if offline { throw HostRoutingError.disconnected }
        return try sharingDecode(["sealed": true])
    }
    func resolve(_ proposal: SharedMissionProposal, revision: Int) async throws -> SharedMissionProposal {
        resolutionRevisions.append(revision)
        if rejectResolution { throw ClientError("Changed", status: 409) }
        var object = try #require(sharingObject(proposal) as? [String: Any]); object["state"] = "committed"
        return try sharingDecode(object)
    }
}

@Suite struct SharedProjectModelTests {
    @Test @MainActor func memoryKeepsPendingSeparateAndOfflineKeepsLastSavedRead() async throws {
        let service = try SharingFake(), model = SharedProjectModel(service: service)
        await model.loadMemory()
        #expect(model.memory?.proposals.first?.mutation.text == "Pending note")
        #expect(model.memory?.proposals.first?.mutation.origin.host == service.binding.executionProject.host)
        guard case let .view(saved)? = model.memory?.value else { Issue.record("No shared read"); return }
        #expect(saved.text == "Saved")
        service.offline = true
        await model.loadMemory()
        #expect(model.memory?.state.sequence == 2)
        #expect(model.error != nil)
    }

    @Test @MainActor func pagingPinsSequenceAndAllowsSameIDAcrossEntityKindsOnly() async throws {
        let service = try SharingFake(), model = SharedProjectModel(service: service)
        service.pages[0] = try service.page(entities: [["id": "same", "kind": "task", "revision": 22, "deleted": false]], next: 1)
        service.pages[1] = try service.page(entities: [["id": "same", "kind": "brief", "revision": 7, "deleted": false]])
        await model.loadMission("same")
        #expect(model.versionsReady)
        #expect(service.versionRequests[1].0 == 1)
        #expect(service.versionRequests[1].1 == 42)
        #expect(model.version(kind: .task, id: "same")?.revision == 22)
        #expect(model.version(kind: .brief, id: "same")?.revision == 7)
        service.pages[1] = service.pages[0]
        await model.loadMission("same")
        #expect(!model.versionsReady)
        #expect(model.mission?.snapshot.sequence == 42)
    }

    @Test @MainActor func changedSequenceOrEnrollmentCannotPublishMixedRevisions() async throws {
        let service = try SharingFake(), model = SharedProjectModel(service: service)
        service.pages[0] = try service.page(entities: [], sequence: 43)
        await model.loadMission("same")
        #expect(!model.versionsReady)
        #expect(model.mission == nil)
        service.pages[0] = try service.page(entities: [], generation: 4)
        await model.loadMission("same")
        #expect(!model.versionsReady)
    }

    @Test @MainActor func missingDefinitionVersionNeverUsesGenericRevisionOrPreferredSourceModel() async throws {
        let service = try SharingFake()
        service.pages[0] = try service.page(entities: [["id": "same", "kind": "task", "revision": 22, "deleted": false]])
        let model = SharedTaskPlacementModel(service: service, missionId: "same", taskId: "same")
        await model.load()
        model.selectedModel = "target/model"; model.confirmed = true
        #expect(model.definitionRevision == nil)
        #expect(!model.canStart)
        #expect(model.models.map(\.id) == ["target/model"])
    }

    @Test @MainActor func lostReplyLooksUpOriginalAllocationAndNeverPostsAgain() async throws {
        let service = try SharingFake()
        service.loseStartReply = true
        let model = SharedTaskPlacementModel(service: service, missionId: "same", taskId: "same")
        await model.load()
        model.selectedModel = "target/model"; model.confirmed = true
        #expect(model.canStart)
        await model.start()
        #expect(model.grant?.delegationId == "allocation")
        #expect(model.occupied)
        #expect(service.placementRequests.first?.expectedRevision == 5)
        #expect(service.placementRequests.first?.expectedPreviousEpoch == 0)
        model.confirmed = true
        await model.start()
        #expect(service.placementRequests.count == 1)
        #expect(model.grant?.session.host == service.binding.executionProject.host)
    }

    @Test @MainActor func absentAllocationDoesNotResolveAnAmbiguousStartOrEnableRetry() async throws {
        let service = try SharingFake()
        service.loseStartReply = true; service.acceptStart = false
        let model = SharedTaskPlacementModel(service: service, missionId: "same", taskId: "same")
        await model.load(); model.selectedModel = "target/model"; model.confirmed = true
        await model.start(); await model.checkStatus()
        #expect(model.uncertainStart)
        #expect(model.occupied)
        model.confirmed = true; await model.start()
        #expect(service.placementRequests.count == 1)
    }

    @Test @MainActor func placementRequiresEveryPinnedArtifactAndExplicitOnlineURLClassification() async throws {
        let service = try SharingFake()
        var read = try #require(sharingObject(service.missionValue) as? [String: Any])
        var snapshot = try #require(read["snapshot"] as? [String: Any])
        var detail = try #require(snapshot["detail"] as? [String: Any])
        detail["artifacts"] = [["taskId": "same", "artifactId": "same", "sessionId": "same", "title": "Required context",
                               "kind": "markdown", "revision": 3, "linkedAt": 0]]
        detail["resources"] = [["id": "url", "taskId": "same", "url": "https://example.invalid/context",
                               "kind": "url", "createdAt": 0]]
        snapshot["detail"] = detail; read["snapshot"] = snapshot
        service.missionValue = try sharingDecode(read)
        let model = SharedTaskPlacementModel(service: service, missionId: "same", taskId: "same")
        await model.load(); model.selectedModel = "target/model"; model.confirmed = true
        #expect(!model.canStart)
        let artifact = try #require(model.artifacts.first)
        model.requirements[SharedTaskPlacementModel.artifactKey(artifact)] = .required
        #expect(!model.canStart)
        model.onlineURLs.insert("https://example.invalid/context")
        #expect(model.canStart)
        await model.start()
        let sent = try #require(service.placementRequests.first)
        #expect(sent.references.first?.revision == 3)
        #expect(sent.references.first?.host == service.binding.missionHome)
        #expect(sent.references.first?.requirement == .required)
        #expect(sent.onlineOnlyUrls == ["https://example.invalid/context"])
    }

    @Test @MainActor func collidingIDsNeverShareViewStateAcrossHostsOrBindingGenerations() throws {
        let service = try SharingFake()
        let home = SharedProjectScope(binding: service.binding, host: service.readingHost)
        let target = SharedProjectScope(binding: service.binding, host: service.targetHost)
        #expect(home != target)
        let later = SharedContextBinding(bindingId: service.binding.bindingId, generation: 4,
            logicalProjectId: service.binding.logicalProjectId, memoryHome: service.binding.memoryHome,
            missionHome: service.binding.missionHome, executionProject: service.binding.executionProject,
            missionIds: service.binding.missionIds, shareMemory: true)
        #expect(home != SharedProjectScope(binding: later, host: service.readingHost))
    }

    @Test @MainActor func cancellationAndDisconnectNeverConfirmRelease() async throws {
        let service = try SharingFake()
        service.grants = [try service.makeGrant()]
        let model = SharedTaskPlacementModel(service: service, missionId: "same", taskId: "same")
        await model.load(); await model.requestStop()
        #expect(model.stopRequested)
        #expect(model.grant?.state == .cancelRequested)
        #expect(model.occupied)
        await model.confirmStopped()
        #expect(model.releaseConfirmedAtTarget)
        #expect(model.occupied)
        #expect(model.lastHomeEpoch == 1)
        service.offline = true; await model.checkStatus()
        #expect(model.occupied)
        service.offline = false; service.grants = [try service.makeGrant(state: "sealed")]
        await model.checkStatus()
        #expect(!model.occupied)
    }

    @Test @MainActor func epochComesFromHomeIncludingSealedPreviousBinding() async throws {
        let service = try SharingFake()
        var previous = try #require(sharingObject(service.makeGrant(state: "sealed", epoch: 8)) as? [String: Any])
        previous["bindingId"] = "previous-link"
        service.foreignGrants = [try sharingDecode(previous)]
        let model = SharedTaskPlacementModel(service: service, missionId: "same", taskId: "same")
        await model.load(); model.selectedModel = "target/model"; model.confirmed = true
        #expect(model.lastHomeEpoch == 8)
        #expect(model.canStart)
        await model.start()
        #expect(service.placementRequests.last?.expectedPreviousEpoch == 8)
        #expect(model.grant?.executionEpoch == 9)
    }

    @Test @MainActor func duplicateTargetSealedViewNeverOverridesOccupiedHomeAllocation() async throws {
        let service = try SharingFake()
        service.grants = [try service.makeGrant(), try service.makeGrant(state: "sealed")]
        let model = SharedTaskPlacementModel(service: service, missionId: "same", taskId: "same")
        await model.load()
        #expect(model.grant?.state == .accepted)
        #expect(model.lastHomeEpoch == 1)
        #expect(model.occupied)
    }

    @Test @MainActor func restartKeepsUnknownBlockedUntilHomeEpochAdvancesWithoutResending() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let service = try SharingFake()
        service.placementIntents = SharedPlacementIntentStore(directory: directory)
        service.grants = [try service.makeGrant(state: "sealed", epoch: 4)]
        service.loseStartReply = true; service.acceptStart = false
        let first = SharedTaskPlacementModel(service: service, missionId: "same", taskId: "same")
        await first.load(); first.selectedModel = "target/model"; first.confirmed = true
        await first.start()
        #expect(first.uncertainStart)
        #expect(service.placementRequests.count == 1)

        // Fresh store and model simulate closing the sheet and relaunching the app.
        service.placementIntents = SharedPlacementIntentStore(directory: directory)
        let reopened = SharedTaskPlacementModel(service: service, missionId: "same", taskId: "same")
        await reopened.load()
        #expect(reopened.uncertainStart)
        #expect(reopened.occupied)
        reopened.selectedModel = "target/model"; reopened.confirmed = true
        await reopened.start(); await reopened.checkStatus()
        #expect(service.placementRequests.count == 1)
        #expect(reopened.uncertainStart) // The unchanged sealed predecessor proves nothing.

        service.grants = [try service.makeGrant(state: "sealed", epoch: 6)]
        await reopened.checkStatus()
        #expect(!reopened.uncertainStart)
        #expect(reopened.lastHomeEpoch == 6)
        #expect(service.placementRequests.count == 1) // Reconciliation never resends.
        let key = SharedPlacementIntentKey(authority: service.binding.missionHome, missionId: "same", taskId: "same")
        #expect(try await SharedPlacementIntentStore(directory: directory).pending(for: key) == nil)
    }

    @Test @MainActor func delayedOldRequestCannotMintANewAllocationAfterLaterEpochSealed() async throws {
        let service = try SharingFake()
        let model = SharedTaskPlacementModel(service: service, missionId: "same", taskId: "same")
        await model.load(); model.selectedModel = "target/model"; model.confirmed = true
        await model.start()
        let original = try #require(service.placementRequests.first)
        service.grants = [try service.makeGrant(state: "sealed", epoch: 2)]
        do {
            _ = try await service.reserve(missionId: "same", taskId: "same", request: original)
            Issue.record("The delayed old request bypassed the execution-epoch fence")
        } catch { #expect((error as? ClientError)?.status == 409) }
        #expect(service.grants.first?.executionEpoch == 2)
        #expect(service.grants.first?.state == .sealed)
    }

    @Test @MainActor func explicitReviewUsesCurrentCASAndRetainsIncomingOnConflict() async throws {
        let service = try SharingFake(), model = SharedProjectModel(service: service)
        let proposal = try service.proposal()
        service.rejectResolution = true
        await model.loadMission("same")
        #expect(model.reviewRevision(proposal) == 22)
        #expect(!(await model.resolve(proposal)))
        #expect(service.resolutionRevisions == [22])
        #expect(!model.versionsReady)
        #expect(proposal.args["title"]?.string == "Proposed task")
        #expect(model.mission?.snapshot.detail.tasks.first?.title == "Saved task")
    }
}

@MainActor
private final class EnrollmentFake: SharedEnrollmentService {
    var values: [HostRef: [SharedContextSummary]] = [:]
    var writes: [HostRef] = []
    var failHost: HostRef?
    var lostReplyHost: HostRef?
    let summary: SharedContextSummary
    init(summary: SharedContextSummary) { self.summary = summary }
    func inventory(on host: HostRef) async throws -> [SharedContextSummary] { values[host] ?? [] }
    func enroll(_ binding: SharedContextBinding, on host: HostRef) async throws {
        writes.append(host)
        if host == failHost { throw HostRoutingError.disconnected }
        values[host] = [summary]
        if host == lostReplyHost { throw HostRoutingError.staleGeneration }
    }
}

@Test @MainActor func partialEnrollmentRecoversSameScopeAndChecksLostReplyBeforeWriting() async throws {
    let shared = try SharingFake(), service = EnrollmentFake(summary: try shared.summary())
    service.failHost = shared.targetHost; service.lostReplyHost = shared.readingHost
    let model = SharedEnrollmentModel(service: service)
    await model.confirm(shared.binding, participants: [shared.readingHost, shared.targetHost])
    #expect(model.confirmedHosts == [shared.readingHost])
    #expect(!model.complete)
    service.failHost = nil
    await model.confirm(shared.binding, participants: [shared.readingHost, shared.targetHost])
    #expect(model.complete)
    #expect(service.writes.filter { $0 == shared.readingHost }.count == 1)
    #expect(model.binding?.bindingId == "link")
}

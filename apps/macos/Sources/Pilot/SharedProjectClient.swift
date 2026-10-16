import Foundation
import PilotCore

struct SharedPlacementRequest: Encodable, Sendable {
    let bindingId: String
    let expectedRevision: Int
    let expectedPreviousEpoch: Int
    let model: String
    var thinking: String? = nil
    var references: [Reference] = []
    var onlineOnlyUrls: [String] = []
    var message: String? = nil
    struct Reference: Encodable, Sendable {
        let host: OperationHost
        let sessionId: String
        let artifactId: String
        let revision: Int
        let requirement: SharedContextReference.Requirement
    }
}

struct SharedReleaseCheck: Decodable, Sendable {
    let sealed: Bool
    let reason: String?
}

extension PilotClient {
    func confirmSharedTaskStopped(_ binding: SharedContextBinding, grant: DelegationGrant) async throws -> SharedReleaseCheck {
        try validatePlacement(grant, binding: binding, missionId: grant.task.mission.missionId, taskId: grant.task.taskId)
        return try await resourceRequest(["delegations", grant.delegationId, "seal"], method: "POST",
                                         body: JSONEncoder().encode(["bindingId": binding.bindingId]))
    }

    func reserveSharedTask(_ binding: SharedContextBinding, missionId: String, taskId: String,
                           request: SharedPlacementRequest) async throws -> DelegationGrant {
        guard binding.state == .active, binding.missionIds.contains(missionId),
              request.bindingId == binding.bindingId, request.expectedRevision > 0,
              (0..<9_007_199_254_740_991).contains(request.expectedPreviousEpoch),
              request.model.contains("/"), request.references.count <= 40,
              (request.message?.utf16.count ?? 0) <= 8000,
              request.onlineOnlyUrls.allSatisfy({ $0.utf16.count <= 2048 }),
              request.references.allSatisfy({ $0.revision > 0 && !$0.sessionId.isEmpty && !$0.artifactId.isEmpty
                  && $0.host == binding.missionHome }) else { throw HostRoutingError.invalidReference }
        let value: DelegationGrant = try await resourceRequest(
            ["missions", missionId, "tasks", taskId, "delegations"], method: "POST", body: JSONEncoder().encode(request))
        try validatePlacement(value, binding: binding, missionId: missionId, taskId: taskId)
        guard value.definitionRevision == request.expectedRevision, value.request.model == request.model,
              value.executionEpoch == request.expectedPreviousEpoch + 1 else {
            throw HostRoutingError.identityChanged
        }
        return value
    }

    func cancelSharedTask(_ binding: SharedContextBinding, grant: DelegationGrant) async throws -> DelegationGrant {
        try validatePlacement(grant, binding: binding, missionId: grant.task.mission.missionId, taskId: grant.task.taskId)
        let value: DelegationGrant = try await resourceRequest(["delegations", grant.delegationId, "cancel"], method: "POST")
        try validatePlacement(value, binding: binding, missionId: grant.task.mission.missionId, taskId: grant.task.taskId)
        guard value.delegationId == grant.delegationId, value.executionEpoch == grant.executionEpoch,
              value.state == .cancelRequested || value.state == .sealed else { throw HostRoutingError.identityChanged }
        return value
    }

    func resolveSharedEdit(_ binding: SharedContextBinding, proposal: SharedMissionProposal,
                          revision: Int) async throws -> SharedMissionProposal {
        struct Write: Encodable { let expectedRevision: Int; let action: String; let args: [String: JSONValue] }
        guard binding.state == .active, binding.missionIds.contains(proposal.missionId),
              proposal.state == .conflict, revision >= 0, ["task", "brief", "decide"].contains(proposal.action) else {
            throw HostRoutingError.invalidReference
        }
        let value: SharedMissionProposal = try await resourceRequest(
            ["shared-contexts", binding.bindingId, "proposals", proposal.proposalId, "resolve"], method: "POST",
            body: JSONEncoder().encode(Write(expectedRevision: revision, action: proposal.action, args: proposal.args)))
        guard value.proposalId == proposal.proposalId, value.missionId == proposal.missionId,
              value.entityId == proposal.entityId, value.state == .committed else { throw HostRoutingError.identityChanged }
        return value
    }

    private func validatePlacement(_ value: DelegationGrant, binding: SharedContextBinding,
                                   missionId: String, taskId: String) throws {
        guard value.bindingId == binding.bindingId, value.bindingGeneration == binding.generation,
              value.task.mission.home == binding.missionHome, value.task.mission.missionId == missionId,
              value.task.taskId == taskId, value.target == binding.executionProject,
              value.session.host == binding.executionProject.host, !value.session.sessionId.isEmpty,
              value.executionEpoch > 0 else { throw HostRoutingError.identityChanged }
    }
}

import Foundation
import PilotCore

/// A response belongs to both an installation and an immutable sharing enrollment.
struct SharedProjectRead<Value> {
    let bindingId: String
    let generation: UInt64
    let readingHost: HostRef
    let value: Value
}

struct SharedProjectScope: Hashable {
    let bindingId: String
    let generation: UInt64
    let host: HostRef
    init(binding: SharedContextBinding, host: HostRef) {
        bindingId = binding.bindingId; generation = binding.generation; self.host = host
    }
}

@MainActor
protocol SharedProjectService {
    var binding: SharedContextBinding { get }
    var readingHost: HostRef { get }
    var placementIntents: any SharedPlacementIntentStorage { get }
    func memory(regex: String?) async throws -> SharedMemoryRead
    func tree(range: MemoryRange?, depth: Int) async throws -> SharedMemoryTreeRead
    func mission(_ id: String) async throws -> SharedMissionRead
    func versions(_ id: String, after: Int, sequence: Int?) async throws -> SharedMissionVersions
    func inventory() async throws -> SharedContextSummary
    func taskAllocations(missionId: String, taskId: String) async throws -> [DelegationGrant]
    func targetModels() async throws -> ModelList
    func reserve(missionId: String, taskId: String, request: SharedPlacementRequest) async throws -> DelegationGrant
    func cancel(_ grant: DelegationGrant) async throws -> DelegationGrant
    func confirmStopped(_ grant: DelegationGrant) async throws -> SharedReleaseCheck
    func resolve(_ proposal: SharedMissionProposal, revision: Int) async throws -> SharedMissionProposal
}

/// No global server. Execution, memory authority, mission authority and the chosen read
/// installation remain separate even when some happen to be the same installation.
@MainActor
struct SharedProjectContext: SharedProjectService {
    let binding: SharedContextBinding
    let readingHost: HostRef
    let hosts: HostClients
    var placementIntents: any SharedPlacementIntentStorage { SharedPlacementIntentStore.shared }

    init(binding: SharedContextBinding, readingHost: HostRef, hosts: HostClients) {
        self.binding = binding; self.readingHost = readingHost; self.hosts = hosts
    }

    func host(for identity: OperationHost) throws -> HostRef {
        let known = Set(hosts.available).union(hosts.offlineHosts.keys).union(hosts.projects.map { $0.ref.host })
        let matches = known.filter { identity.matches($0) }
        guard matches.count == 1, let host = matches.first else { throw HostRoutingError.identityChanged }
        return host
    }

    func name(_ identity: OperationHost) -> String {
        guard let host = try? host(for: identity) else { return "Unavailable devbox" }
        return HostViewContext(host: host, hosts: hosts).name
    }

    func projectRef(_ project: SharedProjectRef) throws -> HostResourceRef {
        HostResourceRef(host: try host(for: project.host), kind: .project, localId: project.projectId)
    }

    /// Revalidate the enrolled scope as well as the socket on both sides of a request.
    /// Memory responses have no wire enrollment fields, so they must not escape this fence.
    func perform<Value>(on host: HostRef? = nil,
                        _ action: (PilotClient) async throws -> Value) async throws -> SharedProjectRead<Value> {
        let destination = host ?? readingHost
        guard binding.state == .active, binding.peers.contains(OperationHost(destination)) else {
            throw HostRoutingError.invalidReference
        }
        let fence = try hosts.token(for: destination)
        try await validate(on: destination)
        let value = try await action(hosts.endpoint(destination))
        try await validate(on: destination)
        try hosts.validate(fence)
        return SharedProjectRead(bindingId: binding.bindingId, generation: binding.generation,
                                 readingHost: destination, value: value)
    }

    private func validate(on host: HostRef) async throws {
        let summaries = try await hosts.sharedContexts(on: host)
        guard summaries.first(where: { $0.binding.bindingId == binding.bindingId })?.binding == binding else {
            throw HostRoutingError.staleGeneration
        }
    }

    func memory(regex: String?) async throws -> SharedMemoryRead {
        try await perform { client in
            if let regex { return try await client.sharedMemoryRecall(binding, regex: regex) }
            return try await client.sharedMemoryWake(binding)
        }.value
    }
    func tree(range: MemoryRange?, depth: Int) async throws -> SharedMemoryTreeRead {
        try await perform { try await $0.sharedMemoryTree(binding, range: range, depth: depth) }.value
    }
    func mission(_ id: String) async throws -> SharedMissionRead {
        try await perform { try await $0.sharedMission(binding, missionId: id) }.value
    }
    func versions(_ id: String, after: Int, sequence: Int?) async throws -> SharedMissionVersions {
        try await perform { try await $0.sharedMissionVersions(binding, missionId: id, after: after, sequence: sequence) }.value
    }
    func inventory() async throws -> SharedContextSummary {
        let home = try host(for: binding.missionHome), fence = try hosts.token(for: home)
        let values = try await hosts.sharedContexts(on: home)
        try hosts.validate(fence)
        guard let value = values.first(where: { $0.binding == binding }) else { throw HostRoutingError.staleGeneration }
        return value
    }
    func taskAllocations(missionId: String, taskId: String) async throws -> [DelegationGrant] {
        let home = try host(for: binding.missionHome), fence = try hosts.token(for: home)
        let values = try await hosts.sharedContexts(on: home)
        try hosts.validate(fence)
        guard values.contains(where: { $0.binding == binding }) else { throw HostRoutingError.staleGeneration }
        // Include the previous binding's sealed allocation. The epoch belongs to the task,
        // not to a link or a target-side stopped response.
        return values.flatMap(\.grants).filter {
            $0.task.mission.home == binding.missionHome && $0.task.mission.missionId == missionId && $0.task.taskId == taskId
        }
    }
    func targetModels() async throws -> ModelList {
        let target = try projectRef(binding.executionProject)
        return try await hosts.perform(target, kind: .project) { client, id in
            try await client.models(projectId: id, cwd: nil, taskStart: true)
        }
    }
    func reserve(missionId: String, taskId: String, request: SharedPlacementRequest) async throws -> DelegationGrant {
        try await perform(on: host(for: binding.missionHome)) {
            try await $0.reserveSharedTask(binding, missionId: missionId, taskId: taskId, request: request)
        }.value
    }
    func cancel(_ grant: DelegationGrant) async throws -> DelegationGrant {
        try await perform(on: host(for: binding.missionHome)) { try await $0.cancelSharedTask(binding, grant: grant) }.value
    }
    func confirmStopped(_ grant: DelegationGrant) async throws -> SharedReleaseCheck {
        let result = try await perform(on: host(for: binding.executionProject.host)) {
            try await $0.confirmSharedTaskStopped(binding, grant: grant)
        }.value
        hosts.reconcileSharedContexts()
        return result
    }
    func resolve(_ proposal: SharedMissionProposal, revision: Int) async throws -> SharedMissionProposal {
        try await perform(on: host(for: binding.missionHome)) {
            try await $0.resolveSharedEdit(binding, proposal: proposal, revision: revision)
        }.value
    }
}

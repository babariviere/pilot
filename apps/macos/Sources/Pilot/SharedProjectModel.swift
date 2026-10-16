import Combine
import Foundation
import PilotCore
import Darwin

struct SharedPlacementIntentKey: Codable, Hashable, Sendable {
    let authority: OperationHost
    let missionId: String
    let taskId: String
}

/// Metadata only. Never stores instructions, references, credentials or a replayable POST.
struct SharedPlacementIntent: Codable, Equatable, Sendable {
    let key: SharedPlacementIntentKey
    let bindingId: String
    let bindingGeneration: UInt64
    let previousEpoch: Int
}

protocol SharedPlacementIntentStorage: Sendable {
    func pending(for key: SharedPlacementIntentKey) async throws -> SharedPlacementIntent?
    func begin(_ intent: SharedPlacementIntent) async throws
    func clear(_ intent: SharedPlacementIntent) async throws
}

/// Small, bounded, fsynced uncertainty markers. An unreadable/full store blocks admission.
/// All file work runs on this actor, never on the UI actor. There is no resend queue.
actor SharedPlacementIntentStore: SharedPlacementIntentStorage {
    static let shared = SharedPlacementIntentStore(directory: FileManager.default.urls(
        for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Pilot/PlacementIntents"))
    private let directory: URL?
    private var records: [SharedPlacementIntentKey: SharedPlacementIntent]?
    init(directory: URL? = nil) { self.directory = directory }

    func pending(for key: SharedPlacementIntentKey) throws -> SharedPlacementIntent? { try load()[key] }
    func begin(_ intent: SharedPlacementIntent) throws {
        var values = try load()
        guard values[intent.key] == nil, values.count < 256, intent.previousEpoch >= 0 else {
            throw HostRoutingError.migrationConflict
        }
        values[intent.key] = intent
        try save(values); records = values
    }
    func clear(_ intent: SharedPlacementIntent) throws {
        var values = try load()
        guard let current = values[intent.key] else { return }
        guard current == intent else { throw HostRoutingError.migrationConflict }
        values[intent.key] = nil
        try save(values); records = values
    }
    private func load() throws -> [SharedPlacementIntentKey: SharedPlacementIntent] {
        if let records { return records }
        guard let directory else { records = [:]; return [:] }
        let file = directory.appendingPathComponent("pending.json")
        guard FileManager.default.fileExists(atPath: file.path) else { records = [:]; return [:] }
        guard (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= 256 * 1024 else {
            throw HostRoutingError.invalidReference
        }
        let values = try JSONDecoder().decode([SharedPlacementIntent].self, from: Data(contentsOf: file))
        guard values.count <= 256, Set(values.map(\.key)).count == values.count else { throw HostRoutingError.invalidReference }
        let decoded = Dictionary(uniqueKeysWithValues: values.map { ($0.key, $0) })
        records = decoded; return decoded
    }
    private func save(_ values: [SharedPlacementIntentKey: SharedPlacementIntent]) throws {
        guard let directory else { return }
        let data = try JSONEncoder().encode(Array(values.values))
        guard data.count <= 256 * 1024 else { throw HostRoutingError.invalidReference }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let temporary = directory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try data.write(to: temporary, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        let handle = try FileHandle(forWritingTo: temporary)
        defer { try? handle.close() }
        try handle.synchronize()
        guard Darwin.rename(temporary.path, directory.appendingPathComponent("pending.json").path) == 0 else {
            throw CocoaError(.fileWriteUnknown)
        }
        let descriptor = Darwin.open(directory.path, O_RDONLY)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
}

enum SharedSaveState: String {
    case saved = "Saved here", pending = "Pending sharing", conflict = "Conflicting edits"
}

@MainActor
final class SharedProjectModel: ObservableObject {
    let service: any SharedProjectService
    @Published private(set) var memory: SharedMemoryRead?
    @Published private(set) var memoryTree: SharedMemoryTreeRead?
    @Published private(set) var mission: SharedMissionRead?
    @Published private(set) var entityVersions: [SharedEntityVersion] = []
    @Published private(set) var versionsReady = false
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    private var readGeneration = 0

    init(context: SharedProjectContext) { service = context }
    init(service: any SharedProjectService) { self.service = service }

    func stop() { readGeneration += 1; busy = false }

    func loadMemory(regex: String? = nil) async {
        readGeneration += 1
        let generation = readGeneration
        busy = true; error = nil
        defer { if generation == readGeneration { busy = false } }
        do {
            let result = try await service.memory(regex: regex)
            guard generation == readGeneration, !Task.isCancelled else { return }
            guard result.state.complete, result.proposals.count <= 256 else { throw HostRoutingError.invalidReference }
            memory = result
        } catch {
            if generation == readGeneration, !(error is CancellationError) { self.error = "Shared memory is unavailable. Reconnect and refresh." }
        }
    }

    func loadTree(range: MemoryRange? = nil) async {
        guard !busy else { return }
        readGeneration += 1
        let generation = readGeneration
        busy = true; error = nil
        defer { if generation == readGeneration { busy = false } }
        do {
            let result = try await service.tree(range: range, depth: 2)
            guard generation == readGeneration, !Task.isCancelled else { return }
            memoryTree = result
        } catch {
            if generation == readGeneration, !(error is CancellationError) { self.error = "Shared memory is unavailable. Reconnect and refresh." }
        }
    }

    /// Never mix snapshot values and revisions from different sequences or enrollments.
    /// A changed page fails closed; a user refresh starts again at the beginning.
    func loadMission(_ id: String) async {
        readGeneration += 1
        let generation = readGeneration
        busy = true; error = nil; versionsReady = false
        defer { if generation == readGeneration { busy = false } }
        do {
            let snapshot = try await service.mission(id)
            try validate(snapshot.bindingId, snapshot.generation, missionId: snapshot.snapshot.missionId,
                         authority: snapshot.authority, expectedMission: id)
            var after = 0, sequence: Int?, versions: [SharedEntityVersion] = [], seen = Set<[String]>()
            while true {
                try Task.checkCancellation()
                guard generation == readGeneration else { return }
                let page = try await service.versions(id, after: after, sequence: sequence)
                try validate(page.bindingId, page.generation, missionId: page.missionId,
                             authority: page.authority, expectedMission: id)
                guard page.complete, page.source == snapshot.source, page.sequence == snapshot.snapshot.sequence,
                      sequence == nil || sequence == page.sequence, page.entities.count <= 128,
                      versions.count + page.entities.count <= 16_384 else { throw HostRoutingError.staleGeneration }
                for entity in page.entities {
                    guard seen.insert([entity.kind.rawValue, entity.id]).inserted else { throw HostRoutingError.invalidReference }
                }
                versions += page.entities
                sequence = page.sequence
                guard let next = page.next else { break }
                guard next == after + page.entities.count, next > after else { throw HostRoutingError.invalidReference }
                after = next
            }
            guard generation == readGeneration, !Task.isCancelled else { return }
            mission = snapshot; entityVersions = versions; versionsReady = true
        } catch {
            if generation == readGeneration, !(error is CancellationError) {
                self.error = "The saved content changed or is unavailable. Refresh before making changes."
            }
        }
    }

    private func validate(_ id: String, _ generation: UInt64, missionId: String,
                          authority: OperationHost, expectedMission: String) throws {
        guard id == service.binding.bindingId, generation == service.binding.generation,
              authority == service.binding.missionHome, missionId == expectedMission,
              service.binding.missionIds.contains(missionId) else { throw HostRoutingError.identityChanged }
    }

    func version(kind: SharedEntity.Kind, id: String) -> SharedEntityVersion? {
        guard versionsReady else { return nil }
        return entityVersions.first { $0.kind == kind && $0.id == id }
    }

    func reviewRevision(_ proposal: SharedMissionProposal) -> Int? {
        guard versionsReady, mission?.source == .canonical, proposal.state == .conflict,
              mission?.snapshot.missionId == proposal.missionId else { return nil }
        let kind: SharedEntity.Kind
        switch proposal.action {
        case "brief": kind = .brief
        case "decide": kind = .decision
        case "task": kind = .task
        default: return nil
        }
        if let version = version(kind: kind, id: proposal.entityId) { return version.deleted ? nil : version.revision }
        return proposal.expectedRevision == 0 && (proposal.action == "task" || proposal.action == "decide") ? 0 : nil
    }

    func resolve(_ proposal: SharedMissionProposal) async -> Bool {
        guard !busy, let revision = reviewRevision(proposal) else { return false }
        busy = true; error = nil
        defer { busy = false }
        do {
            _ = try await service.resolve(proposal, revision: revision)
            versionsReady = false
            return true
        } catch {
            versionsReady = false
            self.error = "The edit was not confirmed. Refresh and review the current saved content before trying again."
            return false
        }
    }
}

@MainActor
protocol SharedEnrollmentService {
    func inventory(on host: HostRef) async throws -> [SharedContextSummary]
    func enroll(_ binding: SharedContextBinding, on host: HostRef) async throws
}

@MainActor
struct SharedEnrollmentClient: SharedEnrollmentService {
    let hosts: HostClients
    func inventory(on host: HostRef) async throws -> [SharedContextSummary] { try await hosts.sharedContexts(on: host) }
    func enroll(_ binding: SharedContextBinding, on host: HostRef) async throws {
        let fence = try hosts.token(for: host)
        try await hosts.endpoint(host).enrollSharedContext(binding)
        try hosts.validate(fence)
        hosts.reconcileSharedContexts()
    }
}

/// Keeps the same binding ID across partial enrollment and ambiguous replies. Recovery
/// checks persisted enrollment first, and never quietly expands or replaces its scope.
@MainActor
final class SharedEnrollmentModel: ObservableObject {
    @Published private(set) var binding: SharedContextBinding?
    @Published private(set) var confirmedHosts = Set<HostRef>()
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    private let service: any SharedEnrollmentService
    init(service: any SharedEnrollmentService) { self.service = service }
    var complete: Bool { binding.map { confirmedHosts.count == $0.peers.count } ?? false }

    func confirm(_ binding: SharedContextBinding, participants: [HostRef]) async {
        guard !busy, self.binding == nil || self.binding == binding,
              Set(participants.map(OperationHost.init)) == binding.peers,
              Set(participants).count == participants.count else { return }
        self.binding = binding; busy = true; error = nil
        defer { busy = false }
        for host in participants {
            do {
                let existing = try await service.inventory(on: host).first { $0.binding.bindingId == binding.bindingId }
                if let existing {
                    guard existing.binding == binding else { throw HostRoutingError.staleGeneration }
                } else {
                    do { try await service.enroll(binding, on: host) }
                    catch {
                        // A lost reply may already have enrolled this installation.
                        guard try await service.inventory(on: host).contains(where: { $0.binding == binding }) else { throw error }
                    }
                }
                guard try await service.inventory(on: host).contains(where: { $0.binding == binding }) else {
                    throw HostRoutingError.staleGeneration
                }
                confirmedHosts.insert(host)
            } catch {
                self.error = "Linking is incomplete. Reconnect the selected devboxes, then finish linking with the same scope."
                return
            }
        }
    }
}

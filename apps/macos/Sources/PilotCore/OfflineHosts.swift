import Darwin
import Foundation

/// Delivery acknowledgment is not execution completion or a delegation seal/release.
public enum HostStopRequest: String, Codable, Sendable { case requested, acknowledged }

/// Private navigation metadata only. Not a transcript, context replica, or execution authority.
public struct OfflineHostSnapshot: Codable, Sendable {
    public let host: HostRef
    public let configuration: SSHConnectionConfiguration
    public var receivedAt: Date?
    public var sessions: [SessionSummary]
    public var projects: [Project]
    public var missions: [Mission]
    public var stopRequests: [String: HostStopRequest]

    public init(host: HostRef, configuration: SSHConnectionConfiguration, receivedAt: Date? = nil,
                sessions: [SessionSummary] = [], projects: [Project] = [], missions: [Mission] = [],
                stopRequests: [String: HostStopRequest] = [:]) {
        self.host = host; self.configuration = configuration; self.receivedAt = receivedAt
        self.sessions = sessions; self.projects = projects; self.missions = missions
        self.stopRequests = stopRequests
    }

    /// Run on the store's actor, not for every streaming update on the UI actor.
    fileprivate func metadataOnly() -> Self {
        var snapshot = self
        snapshot.sessions = sessions.map { value in
            // Deliberately omit diagnostics, tool/job commands, subagent prompts, integration
            // configuration and usage. Drafts/attachments have their own durable owner.
            var summary = SessionSummary(id: value.id, title: value.title, cwd: value.cwd,
                projectId: value.projectId, branch: value.branch, createdAt: value.createdAt,
                updatedAt: value.updatedAt, state: value.state, model: value.model,
                outcome: value.outcome, outcomeAt: value.outcomeAt, archivedAt: value.archivedAt,
                thinking: value.thinking, mode: value.mode, sourceBranch: value.sourceBranch,
                workspace: value.workspace, lastUserMessageAt: value.lastUserMessageAt,
                workspaceStorage: value.workspaceStorage, pinned: value.pinned, missionId: value.missionId,
                missionCoordinator: value.missionCoordinator, activeMissionCoordinator: value.activeMissionCoordinator,
                working: value.working ?? value.isWorking)
            summary.sleepPaused = value.sleepPaused
            summary.offlinePaused = value.offlinePaused
            summary.subscriptionPause = value.subscriptionPause
            summary.continuationOf = value.continuationOf
            summary.continuedTo = value.continuedTo
            summary.trackedSource = value.trackedSource
            return summary
        }
        snapshot.projects = projects.map {
            Project(id: $0.id, name: $0.name, path: $0.path, model: $0.model, workspace: $0.workspace,
                    requirePullRequest: $0.requirePullRequest, createdAt: $0.createdAt)
        }
        snapshot.missions = missions.map {
            Mission(id: $0.id, projectId: $0.projectId, title: $0.title, goal: "", status: $0.status,
                    coordinatorSessionId: $0.coordinatorSessionId, autopilot: $0.autopilot,
                    briefRevision: $0.briefRevision, createdAt: $0.createdAt, updatedAt: $0.updatedAt,
                    completedAt: $0.completedAt, archivedAt: $0.archivedAt,
                    needsYouCount: $0.needsYouCount, tasksDone: $0.tasksDone, tasksTotal: $0.tasksTotal)
        }
        return snapshot
    }
}

/// All encoding and filesystem work stays off the UI actor. Corrupt/unknown files fence writes,
/// preserving the original rather than overwriting it with an apparently empty host list.
public actor OfflineHostStore {
    private struct Index: Codable { var version = 1; let hosts: [OfflineHostSnapshot] }
    private let directory: URL
    private var loaded = false
    private var failure: Error?
    private var latestRevision: UInt64 = 0
    public init(directory: URL) { self.directory = directory }

    public func load() throws -> [OfflineHostSnapshot] {
        if let failure { throw failure }
        do {
            let url = directory.appendingPathComponent("hosts.json")
            guard FileManager.default.fileExists(atPath: url.path) else { loaded = true; return [] }
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 32 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
            let index = try JSONDecoder().decode(Index.self, from: Data(contentsOf: url))
            guard index.version == 1 else { throw HostRoutingError.incompatible }
            try validate(index.hosts)
            loaded = true
            return index.hosts
        } catch { failure = error; throw error }
    }

    private func validate(_ hosts: [OfflineHostSnapshot]) throws {
        guard hosts.count <= 32, Set(hosts.map { $0.host.hostId }).count == hosts.count,
              hosts.allSatisfy({ !$0.host.hostId.isEmpty && $0.host.hostId != "local"
                  && !$0.host.daemonId.isEmpty && !$0.host.lineageId.isEmpty
                  && $0.sessions.count <= 20_000 && $0.projects.count <= 2_000 && $0.missions.count <= 5_000
                  && $0.stopRequests.count <= 20_000
                  && Set($0.sessions.map(\.id)).count == $0.sessions.count
                  && Set($0.projects.map(\.id)).count == $0.projects.count
                  && Set($0.missions.map(\.id)).count == $0.missions.count }) else {
            throw HostRoutingError.invalidReference
        }
    }

    public func save(_ hosts: [OfflineHostSnapshot], revision: UInt64? = nil) throws {
        if let failure { throw failure }
        if !loaded { _ = try load() }
        if let revision {
            guard revision >= latestRevision else { return }
            latestRevision = revision
        }
        try validate(hosts)
        // Reapply the metadata whitelist even if a caller supplied mutable snapshot arrays.
        let sanitized = hosts.map { $0.metadataOnly() }
        let data = try JSONEncoder().encode(Index(hosts: sanitized))
        guard data.count <= 32 * 1024 * 1024 else { throw CocoaError(.fileWriteOutOfSpace) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let temp = directory.appendingPathComponent(UUID().uuidString + ".tmp")
        defer { try? FileManager.default.removeItem(at: temp) }
        try data.write(to: temp, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp.path)
        let file = try FileHandle(forWritingTo: temp)
        do { try file.synchronize(); try file.close() } catch { try? file.close(); throw error }
        guard rename(temp.path, directory.appendingPathComponent("hosts.json").path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let fd = open(directory.path, O_RDONLY)
        guard fd >= 0 else { throw POSIXError(.EIO) }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw POSIXError(.EIO) }
    }
}

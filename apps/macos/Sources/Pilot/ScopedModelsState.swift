import Foundation
import PilotCore

/// App persistence, not an HTTP DTO. nil means the user's explicit All choice.
struct ScopedModelsSelection: Codable, Equatable, Sendable {
    let patterns: [String]?
    static let all = Self(patterns: nil)

    func validate() throws {
        if let patterns {
            guard !patterns.isEmpty, patterns.count <= 256,
                  patterns.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf8.count <= 256
                      && !$0.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }) else {
                throw ScopedModelsFailure.invalidSelection
            }
        }
    }
}

/// Keeps the observed [] distinct from absent, even though both display as All.
struct ScopedModelsBaseline: Codable, Equatable, Sendable {
    let patterns: [String]?
    let hash: String
    var displaysAll: Bool { patterns?.isEmpty != false }
    var selection: ScopedModelsSelection { displaysAll ? .all : .init(patterns: patterns) }
}

enum ScopedModelsFailure: Error {
    case invalidSelection, storage, stale, conflict, unsupported, readOnly, unavailable, nativeActionRequired, settingsUnreadable
}

enum ScopedModelsHostStatus: String, Codable, Sendable {
    case needsConsent, pending, applying, synced, conflict, divergent, failed, unsupported, readOnly, authorizationRequired, settingsUnreadable

    var title: String {
        switch self {
        case .needsConsent: "Review before joining"
        case .pending: "Pending"
        case .applying: "Checking application…"
        case .synced: "Synced"
        case .conflict: "Changed on this host"
        case .divergent: "Left as is"
        case .failed: "Could not sync"
        case .unsupported: "Update required"
        case .readOnly: "Read-only host"
        case .authorizationRequired: "Native authorization unavailable"
        case .settingsUnreadable: "Settings could not be read"
        }
    }
}

struct ScopedModelsHostState: Codable, Equatable, Sendable {
    let host: HostRef
    var baseline: ScopedModelsBaseline?
    var observed: ScopedModelsBaseline?
    var unresolved: [Unresolved] = []
    var participates = false
    var decision = UUID()
    var status = ScopedModelsHostStatus.needsConsent
    var appliedRevision: UInt64?
    var appliedHash: String?
    var attempt: Attempt?

    struct Unresolved: Codable, Equatable, Sendable {
        let pattern: String
        let reason: String
    }

    struct Attempt: Codable, Equatable, Sendable {
        let id: UUID
        let revision: UInt64
        let selection: ScopedModelsSelection
        let expectedHash: String
        var sends: Int
    }
}

struct ScopedModelsState: Codable, Equatable, Sendable {
    var version = 1
    var sequence: UInt64 = 0
    var revision: UInt64 = 0
    var desired: ScopedModelsSelection?
    var hosts: [ScopedModelsHostState] = []

    func entry(_ host: HostRef) -> ScopedModelsHostState? { hosts.first { $0.host == host } }

    mutating func edit(_ host: HostRef, _ change: (inout ScopedModelsHostState) throws -> Void) rethrows {
        if let index = hosts.firstIndex(where: { $0.host == host }) { try change(&hosts[index]) }
        else {
            var entry = ScopedModelsHostState(host: host)
            try change(&entry)
            hosts.append(entry)
        }
    }

    mutating func save(_ selection: ScopedModelsSelection, joining: [HostRef: ScopedModelsBaseline]) throws {
        try selection.validate()
        guard revision < UInt64.max else { throw ScopedModelsFailure.storage }
        revision += 1
        desired = selection
        for (host, baseline) in joining {
            if let existing = entry(host), existing.baseline != nil || existing.status == .divergent {
                // Save may consent to first contact, not overwrite an established conflict.
                throw ScopedModelsFailure.stale
            }
            edit(host) { entry in
                entry.baseline = baseline; entry.observed = baseline; entry.participates = true
                entry.status = .pending; entry.attempt = nil; entry.decision = UUID()
            }
        }
        for index in hosts.indices where hosts[index].participates && hosts[index].status != .divergent {
            // Preserve established conflict baselines. Save is not force-overwrite consent.
            if hosts[index].status != .conflict { hosts[index].status = .pending }
        }
    }

    mutating func leave(_ host: HostRef) {
        edit(host) { $0.participates = false; $0.status = .divergent; $0.attempt = nil; $0.decision = UUID() }
    }

    mutating func join(_ host: HostRef, baseline: ScopedModelsBaseline) throws {
        guard desired != nil else { throw ScopedModelsFailure.stale }
        edit(host) {
            $0.baseline = baseline; $0.observed = baseline; $0.participates = true
            $0.status = .pending; $0.attempt = nil; $0.decision = UUID()
        }
    }

    func validate() throws {
        guard version == 1, hosts.count <= 64, Set(hosts.map(\.host)).count == hosts.count,
              (desired == nil) == (revision == 0) else { throw ScopedModelsFailure.storage }
        try desired?.validate()
        for entry in hosts {
            guard !entry.host.hostId.isEmpty, !entry.host.daemonId.isEmpty, !entry.host.lineageId.isEmpty,
                  entry.appliedRevision.map({ $0 <= revision }) ?? true,
                  entry.unresolved.count <= 256,
                  entry.unresolved.allSatisfy({ $0.pattern.utf8.count <= 256 && $0.reason.utf8.count <= 256 }) else { throw ScopedModelsFailure.storage }
            for baseline in [entry.baseline, entry.observed].compactMap({ $0 }) {
                guard !baseline.hash.isEmpty, baseline.hash.utf8.count <= 256,
                      (baseline.patterns?.count ?? 0) <= 256,
                      baseline.patterns?.allSatisfy({ $0.utf8.count <= 256 }) ?? true else { throw ScopedModelsFailure.storage }
            }
            if let attempt = entry.attempt {
                try attempt.selection.validate()
                guard attempt.revision <= revision, (1...2).contains(attempt.sends),
                      !attempt.expectedHash.isEmpty else { throw ScopedModelsFailure.storage }
            }
        }
    }
}

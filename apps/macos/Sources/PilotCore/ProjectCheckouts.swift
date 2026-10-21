import Foundation

/// Sanitized origin evidence belongs to an exact installation, registered project and checkout path.
public struct CheckoutOrigin: Codable, Equatable, Sendable {
    public let project: HostResourceRef
    public let path: String
    public let identity: String?
    public init(project: HostResourceRef, path: String, identity: String?) {
        self.project = project; self.path = path; self.identity = identity
    }
}

public struct ProjectCheckoutGroup: Identifiable, Sendable {
    public let checkouts: [Hosted<Project>]
    public var id: HostResourceRef { checkouts[0].ref }
    public var representative: Hosted<Project> { checkouts[0] }
}

/// A presentation over ClientDirectory' inventory and existing RepositoryBindings, not another project store.
public enum ProjectCheckouts {
    public static func groups(_ projects: [Hosted<Project>], origins: [CheckoutOrigin],
                              bindings: RepositoryBindings, local: HostRef?) -> [ProjectCheckoutGroup] {
        let known = Dictionary(projects.map { ($0.ref, $0) }, uniquingKeysWith: { first, _ in first })
        let evidence = Dictionary(origins.filter { known[$0.project]?.value.path == $0.path }.map { ($0.project, $0) },
                                  uniquingKeysWith: { _, last in last })
        var parents = Dictionary(uniqueKeysWithValues: known.keys.map { ($0, $0) })
        var placements = Dictionary(uniqueKeysWithValues: known.keys.map { ($0, Set([$0.host])) })
        var pinnedRoots: Set<HostResourceRef> = []
        func root(_ key: HostResourceRef) -> HostResourceRef {
            var result = key
            while let parent = parents[result], parent != result { result = parent }
            return result
        }
        func join(_ a: HostResourceRef, _ b: HostResourceRef) {
            let left = root(a), right = root(b)
            guard left != right else { return }
            parents[right] = left
            placements[left, default: []].formUnion(placements.removeValue(forKey: right) ?? [])
            if pinnedRoots.remove(right) != nil { pinnedRoots.insert(left) }
        }
        var explicitTargets: Set<HostResourceRef> = []
        for mapping in bindings.mappings {
            guard let source = try? HostResourceRef.decodeKey(mapping.logicalProjectId),
                  let a = known[source], let b = known[mapping.project],
                  a.value.path == mapping.sourcePath, b.value.path == mapping.remotePath,
                  evidence[source]?.identity == mapping.sourceOrigin,
                  evidence[b.ref]?.identity == mapping.destinationOrigin else { continue }
            join(a.ref, b.ref)
            pinnedRoots.insert(root(a.ref)); explicitTargets.insert(b.ref)
        }
        // Wait for every known clone on a host: partially discovered inventory must not look unique.
        let settled = Set(Dictionary(grouping: projects, by: { $0.ref.host }).filter { _, values in
            values.allSatisfy { evidence[$0.ref] != nil }
        }.keys)
        let automatic = Dictionary(grouping: projects.filter { settled.contains($0.ref.host) && evidence[$0.ref]?.identity != nil },
                                   by: { evidence[$0.ref]!.identity! })
        for values in automatic.values {
            // Ambiguity belongs to that host, not to the source's placements on other hosts.
            let byHost = Dictionary(grouping: values, by: { $0.ref.host })
            let roots = Set(values.filter { byHost[$0.ref.host]?.count == 1 && !explicitTargets.contains($0.ref) }.map { root($0.ref) })
            let pinned = roots.intersection(pinnedRoots)
            let reserved = pinned.reduce(into: Set<HostRef>()) { $0.formUnion(placements[$1] ?? []) }
            // An explicit fork/worktree occupies its destination slot even when another checkout
            // there has the source's origin. Do not pull that alternative into the project.
            let candidates = roots.filter { pinned.contains($0) || (placements[$0] ?? []).isDisjoint(with: reserved) }
            let hosts = candidates.reduce(into: Set<HostRef>()) { $0.formUnion(placements[$1] ?? []) }
            guard hosts.count == candidates.reduce(0, { $0 + (placements[$1]?.count ?? 0) }) else { continue }
            // Conflicting explicit groups stay separate; no observation order chooses a winner.
            let ordered = candidates.sorted { $0.storageKey < $1.storageKey }
            if let first = ordered.first { for other in ordered.dropFirst() { join(first, other) } }
        }
        return Dictionary(grouping: projects, by: { root($0.ref) }).values.map { values in
            ProjectCheckoutGroup(checkouts: values.sorted {
                if ($0.ref.host == local) != ($1.ref.host == local) { return $0.ref.host == local }
                return $0.ref.storageKey < $1.ref.storageKey
            })
        }.sorted { $0.representative.value.name == $1.representative.value.name
            ? $0.id.storageKey < $1.id.storageKey : $0.representative.value.name < $1.representative.value.name }
    }

    public static func candidates(from source: HostResourceRef, on host: HostRef, projects: [Hosted<Project>],
                                  origins: [CheckoutOrigin], bindings: RepositoryBindings) -> [Hosted<Project>] {
        let group = groups(projects, origins: origins, bindings: bindings, local: nil).first { $0.checkouts.contains { $0.ref == source } }
        let mapped = group?.checkouts.filter { $0.ref.host == host } ?? []
        if !mapped.isEmpty { return mapped }
        guard let item = projects.first(where: { $0.ref == source }),
              let origin = origins.first(where: { $0.project == source && $0.path == item.value.path })?.identity else { return [] }
        return projects.filter { item in item.ref.host == host && origins.contains {
            $0.project == item.ref && $0.path == item.value.path && $0.identity == origin
        } }
    }
}

/// Private association metadata only. No credentials, raw URLs, files or sharing grants.
public struct RepositoryAssociations: Codable, Sendable {
    public var origins: [CheckoutOrigin] = []
    public var bindings = RepositoryBindings()
    public init() {}
}

public actor RepositoryAssociationStore {
    private let file: URL
    private var failure: Error?
    private var latest: UInt64 = 0
    private var loaded = false
    public init(file: URL) { self.file = file }
    public func load() throws -> RepositoryAssociations {
        if let failure { throw failure }
        do {
            guard FileManager.default.fileExists(atPath: file.path) else { loaded = true; return RepositoryAssociations() }
            guard (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 2_000_000 else { throw CocoaError(.fileReadTooLarge) }
            let value = try JSONDecoder().decode(RepositoryAssociations.self, from: Data(contentsOf: file))
            loaded = true
            return value
        } catch { failure = error; throw error }
    }
    public func save(_ value: RepositoryAssociations, revision: UInt64) throws {
        if let failure { throw failure }
        if !loaded { _ = try load() }
        guard revision >= latest else { return }
        let data = try JSONEncoder().encode(value)
        guard data.count <= 2_000_000, value.origins.count <= 10_000, value.bindings.mappings.count <= 2_000 else { throw CocoaError(.fileWriteOutOfSpace) }
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = directory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
        if FileManager.default.fileExists(atPath: file.path) { _ = try FileManager.default.replaceItemAt(file, withItemAt: temporary) }
        else { try FileManager.default.moveItem(at: temporary, to: file) }
        latest = revision
    }
}

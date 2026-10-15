import Foundation

public struct ProjectFolder: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// One folder heading and its items, or the ungrouped items (`folder` nil), from `ProjectFolders.sections`.
public struct ProjectFolderSection<Item> {
    public let folder: ProjectFolder?
    public let items: [Item]

    public init(folder: ProjectFolder?, items: [Item]) {
        self.folder = folder
        self.items = items
    }

    public var id: String { folder?.id ?? "" }
}

/// Local project organization for the project picker and Home, independent of the daemon's project model.
public struct ProjectFolders: Codable, Equatable, Sendable {
    public private(set) var folders: [ProjectFolder]
    public private(set) var assignments: [String: String]
    public private(set) var collapsed: Set<String>

    private static let defaultsKey = "PilotProjectFolders"

    public init() {
        folders = []
        assignments = [:]
        collapsed = []
    }

    public static func load(defaults: UserDefaults = .standard) -> ProjectFolders {
        guard let data = defaults.data(forKey: defaultsKey),
              let folders = try? JSONDecoder().decode(ProjectFolders.self, from: data) else {
            return ProjectFolders()
        }
        return folders
    }

    public func save(defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }

    @discardableResult
    public mutating func create(name: String) -> ProjectFolder? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }
        let folder = ProjectFolder(id: UUID().uuidString, name: name)
        folders.append(folder)
        return folder
    }

    public mutating func rename(_ id: String, name: String) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let index = folders.firstIndex(where: { $0.id == id }) else { return }
        folders[index].name = name
    }

    public mutating func remove(_ id: String) {
        folders.removeAll { $0.id == id }
        assignments = assignments.filter { $0.value != id }
        collapsed.remove(id)
    }

    public func folderId(for projectId: String) -> String? {
        guard let id = assignments[projectId], folders.contains(where: { $0.id == id }) else { return nil }
        return id
    }

    /// `items` under their folders in folder order, then the ungrouped ones, each keeping its input order. Empty
    /// folders are kept only with `includingEmpty`; an empty ungrouped section is always left out.
    public func sections<Item>(_ items: [Item], includingEmpty: Bool = false,
                               projectId: (Item) -> String) -> [ProjectFolderSection<Item>] {
        var byFolder: [String: [Item]] = [:]
        var ungrouped: [Item] = []
        for item in items {
            if let id = folderId(for: projectId(item)) {
                byFolder[id, default: []].append(item)
            } else {
                ungrouped.append(item)
            }
        }
        var sections = folders.compactMap { folder -> ProjectFolderSection<Item>? in
            let items = byFolder[folder.id] ?? []
            guard includingEmpty || !items.isEmpty else { return nil }
            return ProjectFolderSection(folder: folder, items: items)
        }
        if !ungrouped.isEmpty { sections.append(ProjectFolderSection(folder: nil, items: ungrouped)) }
        return sections
    }

    public mutating func move(projectId: String, to folderId: String?) {
        if let folderId {
            guard folders.contains(where: { $0.id == folderId }) else { return }
            assignments[projectId] = folderId
        } else {
            assignments.removeValue(forKey: projectId)
        }
    }

    public mutating func setExpanded(_ expanded: Bool, folderId: String) {
        guard folders.contains(where: { $0.id == folderId }) else { return }
        if expanded {
            collapsed.remove(folderId)
        } else {
            collapsed.insert(folderId)
        }
    }
}

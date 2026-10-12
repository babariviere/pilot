/// Last known model list per scope, shown immediately while the daemon revalidates it.
/// Bounded and least-recently-used, so many visited folders cannot grow it without limit.
public struct ModelListCache: Sendable {
    private var entries: [String: ModelList] = [:]
    private var order: [String] = []
    public let limit: Int

    public init(limit: Int = 32) {
        self.limit = max(1, limit)
    }

    /// Mirrors the daemon query: a project wins over a folder, and no folder means the home directory.
    public static func key(projectId: String?, cwd: String?) -> String {
        if let projectId { return "project:\(projectId)" }
        if let cwd, !cwd.isEmpty { return "cwd:\(cwd)" }
        return "cwd:~"
    }

    public var count: Int { entries.count }

    public mutating func list(for key: String) -> ModelList? {
        guard let list = entries[key] else { return nil }
        touch(key)
        return list
    }

    public mutating func store(_ list: ModelList, for key: String) {
        entries[key] = list
        touch(key)
        while order.count > limit {
            entries.removeValue(forKey: order.removeFirst())
        }
    }

    private mutating func touch(_ key: String) {
        if let index = order.firstIndex(of: key) { order.remove(at: index) }
        order.append(key)
    }
}

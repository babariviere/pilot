import Foundation

/// Reader state of visuals (tabs, toggles, sliders) as the runtime's JSON, per artifact revision, least recently
/// used first. Bounded by entries and bytes, so it can persist across launches without growing.
public struct VisualStateMemory: Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let key: String
        public let state: String

        public init(key: String, state: String) {
            self.key = key
            self.state = state
        }
    }

    public let limit: Int
    public let byteLimit: Int
    public private(set) var entries: [Entry] = []
    public private(set) var bytes = 0

    public init(limit: Int = 256, byteLimit: Int = 1 << 20, entries: [Entry] = []) {
        self.limit = limit
        self.byteLimit = byteLimit
        for entry in entries { store(entry.state, for: entry.key) }
    }

    public subscript(key: String) -> String? {
        entries.last { $0.key == key }?.state
    }

    /// Stores state for key as the most recent entry. Returns false when nothing changed. A state larger than the
    /// whole budget is not kept; the visual then starts from its initial values next time.
    @discardableResult
    public mutating func store(_ state: String, for key: String) -> Bool {
        if entries.last?.key == key, entries.last?.state == state { return false }
        if let index = entries.firstIndex(where: { $0.key == key }) {
            bytes -= Self.size(entries[index])
            entries.remove(at: index)
        }
        let entry = Entry(key: key, state: state)
        guard Self.size(entry) <= byteLimit else { return true }
        entries.append(entry)
        bytes += Self.size(entry)
        while entries.count > limit || bytes > byteLimit {
            bytes -= Self.size(entries.removeFirst())
        }
        return true
    }

    static func size(_ entry: Entry) -> Int { entry.key.utf8.count + entry.state.utf8.count }
}


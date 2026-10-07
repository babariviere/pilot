import Foundation

public enum QueueNavigationDirection: Sendable {
    case up
    case down
}

/// Local drafts only. Navigation never submits or mutates the durable queue.
public struct QueuedMessageEditing: Equatable, Sendable {
    public private(set) var selected: QueuedMessage?
    private var drafts: [Int: String] = [:]

    public init() {}

    public var draft: String {
        get { selected.map { drafts[$0.id] ?? $0.text } ?? "" }
        set { if let selected { drafts[selected.id] = newValue } }
    }

    public func hasUnsavedEdit(_ message: QueuedMessage) -> Bool {
        drafts[message.id].map { $0 != message.text } ?? false
    }

    public mutating func select(_ message: QueuedMessage) { selected = message }

    /// A confirmed removal discards only that message's draft.
    public mutating func remove(_ id: Int) {
        drafts.removeValue(forKey: id)
        if selected?.id == id { selected = nil }
    }

    /// From the composer, Up starts at the closest row and Down starts at the first row.
    @discardableResult
    public mutating func navigate(_ direction: QueueNavigationDirection, messages: [QueuedMessage]) -> Bool {
        guard !messages.isEmpty else { return false }
        let index: Int
        if let current = messages.firstIndex(where: { $0.id == selected?.id }) {
            index = min(max(current + (direction == .up ? -1 : 1), 0), messages.count - 1)
        } else {
            index = direction == .up ? messages.count - 1 : 0
        }
        select(messages[index])
        return true
    }

    /// Discard only the selected draft; other drafts remain available when navigating back to them.
    public mutating func finish() {
        if let selected { drafts.removeValue(forKey: selected.id) }
        selected = nil
    }
}

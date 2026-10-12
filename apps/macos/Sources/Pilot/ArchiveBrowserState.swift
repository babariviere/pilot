import Combine
import Foundation
import PilotCore

/// Project and mission narrowing share the REST and live-inventory predicates.
struct ArchiveFilter: Hashable {
    var projectId: String?
    var missionId: String?

    var queryItems: [URLQueryItem] {
        var items = [URLQueryItem(name: "archived", value: "true")]
        if let projectId { items.append(URLQueryItem(name: "projectId", value: projectId)) }
        if let missionId { items.append(URLQueryItem(name: "missionId", value: missionId)) }
        return items
    }

    func apply(to sessions: [SessionSummary]) -> [SessionSummary] {
        Self.ordered(matching(sessions))
    }

    func matching(_ sessions: [SessionSummary]) -> [SessionSummary] {
        sessions.filter {
            $0.isArchived && (projectId == nil || $0.projectId == projectId)
                && (missionId == nil || $0.missionId == missionId)
        }
    }

    static func ordered(_ sessions: [SessionSummary]) -> [SessionSummary] {
        sessions.sorted {
            let left = $0.archivedAt ?? 0
            let right = $1.archivedAt ?? 0
            return left == right ? $0.id < $1.id : left > right
        }
    }
}

@MainActor
final class ArchiveBrowserState: ObservableObject {
    @Published var query = ""
    @Published private(set) var sessions: [SessionSummary] = []
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published var reloadRevision = 0
    private var generation = 0
    private var inventoryRevision = 0
    private var filter: ArchiveFilter?
    private var rowsById: [String: SessionSummary] = [:]

    func load(_ filter: ArchiveFilter, fetch: () async throws -> [SessionSummary]) async {
        generation += 1
        let request = generation
        let revision = inventoryRevision
        self.filter = filter
        sessions = []
        rowsById = [:]
        error = nil
        loading = true
        do {
            let result = try await fetch()
            guard request == generation else { return }
            guard !Task.isCancelled else { loading = false; return }
            // A restore, membership change or reconnect snapshot received during GET wins.
            if revision == inventoryRevision { replace(filter.apply(to: result)) }
            loading = false
        } catch {
            guard request == generation else { return }
            loading = false
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    /// No polling or extra subscriptions. The existing inventory includes archived chats.
    func receive(_ inventory: [SessionSummary], filter: ArchiveFilter) {
        guard self.filter == filter else { return }
        inventoryRevision += 1
        let matching = filter.matching(inventory)
        // Active-chat activity must not repeatedly sort the archive or invalidate its rows.
        if matching.count == rowsById.count, matching.allSatisfy({ rowsById[$0.id] == $0 }) { return }
        replace(ArchiveFilter.ordered(matching))
    }

    private func replace(_ rows: [SessionSummary]) {
        rowsById = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        sessions = rows
    }
}

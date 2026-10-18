import Foundation
import PilotCore

/// What the Control screen reads: pilotd's read-only memory routes. `PilotClient` in the app, a fixture in
/// snapshots and tests.
@MainActor
protocol ControlMemoryReading: AnyObject {
    func controlMemoryView() async throws -> ControlMemoryViewResponse
    func controlMemoryNode(start: Int, n: Int, offset: Int?) async throws -> ControlMemoryNodeResponse
    func controlMemoryMessages(before: Int?, limit: Int, query: String?) async throws -> ControlMemoryMessagesResponse
    func controlMemoryStats() async throws -> ControlMemoryStats
}

extension PilotClient: ControlMemoryReading {}

/// The Control screen's data: the summaries view with its expanded ranges, the message log (paged, searchable) and
/// the health figures. Everything is read-only. `control-memory.changed` and reconnects call `scheduleRefresh`
/// or `load`; refreshes keep expansions, loaded messages and older log pages, so the page does not jump.
@MainActor
final class ControlScreenModel: ObservableObject {
    @Published var section: ControlScreenSection = .summaries

    @Published private(set) var lines: [ControlMemoryLine] = []
    @Published private(set) var viewLoaded = false
    @Published private(set) var viewError: String?
    @Published private(set) var expanded: Set<String> = []
    @Published private(set) var children: [String: [ControlMemoryLine]] = [:]
    /// Whole messages by id, shared by the summaries tree and opened log rows.
    @Published private(set) var messages: [Int: ControlMemoryMessageText] = [:]
    /// Load failures by line id (`"12+1"` for a message).
    @Published private(set) var failures: [String: String] = [:]
    @Published private(set) var loadingMessages: Set<Int> = []

    /// The log search, as typed. The page debounces it before `reloadLog`.
    @Published var query = ""
    @Published private(set) var log: [ControlMemoryLogEntry] = []
    @Published private(set) var logNext: Int?
    @Published private(set) var logLoaded = false
    @Published private(set) var logError: String?
    @Published private(set) var loadingOlder = false
    /// Log rows opened to their whole message.
    @Published private(set) var openLogRows: Set<Int> = []

    @Published private(set) var stats: ControlMemoryStats?
    @Published private(set) var statsError: String?

    static let logPage = 50
    /// Invalidations within this window share one refresh. pilotd already sends at most one a second.
    static let coalesce: Duration = .milliseconds(200)
    /// Typing pauses this long before a search runs.
    static let searchDelay: Duration = .milliseconds(250)

    private let source: ControlMemoryReading
    private var refreshTask: Task<Void, Never>?
    /// The search the held log rows answer (nil for the whole log).
    private(set) var logQuery: String?
    /// Bumped by every reload, so a slow older page or refresh for a previous search is dropped.
    private var logGeneration = 0

    init(source: ControlMemoryReading) {
        self.source = source
    }

    /// The trimmed search, nil when empty. pilotd accepts at most 200 characters.
    var searchQuery: String? {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : String(trimmed.prefix(200))
    }

    var treeRows: [ControlMemoryTreeRow] {
        ControlMemoryTree.rows(lines: lines, expanded: expanded, children: children, messages: messages, failures: failures)
    }

    var pendingLines: Int { lines.filter(\.isPending).count }

    // MARK: Loading

    func load() async {
        await loadView()
        await reloadLog()
        await loadStats()
    }

    /// After `control-memory.changed`: refetch the view, the newest log page and the figures.
    func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: Self.coalesce)
            guard !Task.isCancelled, let self else { return }
            await refresh()
        }
    }

    func refresh() async {
        await loadView()
        await refreshLog()
        await loadStats()
    }

    func stop() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    func loadView() async {
        do {
            let view = try await source.controlMemoryView()
            lines = view.lines
            viewError = nil
            // Halves still being summarized are refetched; built halves never change.
            children = children.filter { !$0.value.contains(where: \.isPending) }
            failures = [:]
            viewLoaded = true
            for id in expanded { await ensureLoaded(id) }
        } catch {
            viewError = error.localizedDescription
            viewLoaded = true
        }
    }

    func loadStats() async {
        do {
            stats = try await source.controlMemoryStats()
            statsError = nil
        } catch { statsError = error.localizedDescription }
    }

    // MARK: Summaries

    func toggle(_ line: ControlMemoryLine) async {
        if expanded.contains(line.id) {
            expanded.remove(line.id)
            return
        }
        expanded.insert(line.id)
        await ensureLoaded(line.id)
    }

    func retry(_ line: ControlMemoryLine) async {
        failures[line.id] = nil
        await ensureLoaded(line.id)
    }

    /// Loads an expanded line's halves, or its message for a single message.
    private func ensureLoaded(_ id: String) async {
        guard let line = Self.line(id) else { return }
        if line.n == 1 {
            await ensureMessage(line.start)
            return
        }
        guard children[id] == nil, failures[id] == nil else { return }
        do {
            let node = try await source.controlMemoryNode(start: line.start, n: line.n, offset: nil)
            children[id] = node.lines ?? []
        } catch { failures[id] = error.localizedDescription }
    }

    private func ensureMessage(_ id: Int) async {
        let key = "\(id)+1"
        guard messages[id] == nil, failures[key] == nil, !loadingMessages.contains(id) else { return }
        loadingMessages.insert(id)
        defer { loadingMessages.remove(id) }
        do {
            let node = try await source.controlMemoryNode(start: id, n: 1, offset: nil)
            guard let page = node.page else { throw ControlScreenError.missingMessage }
            messages[id] = ControlMemoryMessageText(page)
        } catch { failures[key] = error.localizedDescription }
    }

    /// "Show more" of a long message: its next page.
    func loadMore(message id: Int) async {
        guard let message = messages[id], message.canLoadMore, let offset = message.next,
              !loadingMessages.contains(id) else { return }
        loadingMessages.insert(id)
        defer { loadingMessages.remove(id) }
        do {
            let node = try await source.controlMemoryNode(start: id, n: 1, offset: offset)
            guard let page = node.page else { throw ControlScreenError.missingMessage }
            messages[id]?.append(page, offset: offset)
        } catch { failures["\(id)+1"] = error.localizedDescription }
    }

    /// "12+4" → the line it names (text is not needed to load it).
    private static func line(_ id: String) -> ControlMemoryLine? {
        let parts = id.split(separator: "+")
        guard parts.count == 2, let start = Int(parts[0]), let n = Int(parts[1]) else { return nil }
        return ControlMemoryLine(start: start, n: n, text: "")
    }

    // MARK: Log

    /// The first page for the current search, replacing the held rows.
    func reloadLog() async {
        logGeneration += 1
        let generation = logGeneration
        let query = searchQuery
        do {
            let page = try await source.controlMemoryMessages(before: nil, limit: Self.logPage, query: query)
            guard generation == logGeneration else { return }
            log = page.messages
            logNext = page.next
            logQuery = query
            logError = nil
            logLoaded = true
        } catch {
            guard generation == logGeneration else { return }
            logError = error.localizedDescription
            logLoaded = true
        }
    }

    /// The newest page, merged above the held rows so older pages stay.
    private func refreshLog() async {
        guard logLoaded, logQuery == searchQuery else { return await reloadLog() }
        let generation = logGeneration
        do {
            let page = try await source.controlMemoryMessages(before: nil, limit: Self.logPage, query: logQuery)
            guard generation == logGeneration else { return }
            (log, logNext) = ControlMemoryLog.merge(held: log, heldNext: logNext, newest: page)
            logError = nil
        } catch {
            guard generation == logGeneration else { return }
            logError = error.localizedDescription
        }
    }

    /// "Show more": the next older page (or, while searching, the next stretch of the log).
    func loadOlderLog() async {
        guard let next = logNext, !loadingOlder, log.count < ControlMemoryLog.cap else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        let generation = logGeneration
        do {
            let page = try await source.controlMemoryMessages(before: next, limit: Self.logPage, query: logQuery)
            guard generation == logGeneration, logNext == next else { return }
            (log, logNext) = ControlMemoryLog.append(held: log, older: page)
        } catch { logError = error.localizedDescription }
    }

    /// Opens a log row to its whole message, or closes it.
    func toggleLogRow(_ id: Int) async {
        if openLogRows.remove(id) != nil { return }
        openLogRows.insert(id)
        failures["\(id)+1"] = nil
        await ensureMessage(id)
    }
}

enum ControlScreenError: LocalizedError {
    case missingMessage

    var errorDescription: String? { "pilotd returned no message." }
}

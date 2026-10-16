import Foundation
import Combine
import PilotCore

@MainActor
protocol ProjectMemoryClient {
    func memoryTree(_ projectId: String, range: MemoryRange?, depth: Int, reveal: [Int]) async throws -> MemoryTree
    func memoryRecall(_ projectId: String, regex: String) async throws -> MemoryRecall
    func forgetMemory(_ projectId: String, lo: Int, hi: Int) async throws
}

extension PilotClient: ProjectMemoryClient {}

/// One visible row of the memory tree.
struct MemoryTreeRow: Equatable, Identifiable {
    let node: MemoryNode
    let depth: Int
    /// For each level above the parent's, whether that ancestor has a later sibling, so its guide line continues.
    let guides: [Bool]
    /// The last of its siblings: its elbow ends the parent's guide line.
    let isLast: Bool
    let expanded: Bool
    /// A top-level row after the first, which a hairline separates from the one above.
    let startsGroup: Bool
    var id: String { node.key }
    var expandable: Bool { node.hi > node.lo }
}

/// The tree's shape, which depends only on the number of notes: top-level blocks tile the log in aligned powers of two,
/// a summary of more than 16 notes splits into halves and one of 16 or fewer lists its notes. Newest first, as pilotd
/// returns them.
enum MemoryTreeShape {
    static let leafGroup = 16

    /// Inclusive top-level ranges, newest first.
    static func roots(count: Int) -> [MemoryRange] {
        var out: [MemoryRange] = []
        var lo = 0
        var size = 1
        while size * 2 <= count { size *= 2 }
        while size >= 1 {
            if count - lo >= size {
                out.append(MemoryRange(lo: lo, hi: lo + size - 1))
                lo += size
            }
            size /= 2
        }
        return out.reversed()
    }

    /// Inclusive child ranges of a range, newest first.
    static func children(of range: MemoryRange) -> [MemoryRange] {
        let size = range.hi - range.lo + 1
        guard size > 1 else { return [] }
        if size > leafGroup {
            let mid = range.lo + size / 2
            return [MemoryRange(lo: mid, hi: range.hi), MemoryRange(lo: range.lo, hi: mid - 1)]
        }
        return (range.lo...range.hi).reversed().map { MemoryRange(lo: $0, hi: $0) }
    }

    /// The ranges from a top-level block down to the note, both included.
    static func path(to index: Int, count: Int) -> [MemoryRange] {
        guard index >= 0, index < count,
              var range = roots(count: count).first(where: { $0.lo <= index && index <= $0.hi }) else { return [] }
        var out = [range]
        while range.hi > range.lo, let next = children(of: range).first(where: { $0.lo <= index && index <= $0.hi }) {
            out.append(next)
            range = next
        }
        return out
    }
}

/// The Memory page's state: the browsing tree, loaded in bounded slices from pilotd's tree endpoint, and a search that
/// shows matching notes in place with their summaries. Large logs never load whole on the main thread.
@MainActor
final class MemoryPageModel: ObservableObject {
    /// Most matches revealed in the tree, matching pilotd's reveal limit.
    static let revealLimit = 64

    @Published private(set) var count = 0
    @Published private(set) var rows: [MemoryTreeRow] = []
    @Published var selection: String?
    @Published var query = ""
    /// Matching notes below each node while searching, by node key. nil when not searching.
    @Published private(set) var matches: [String: Int]?
    /// Total matching notes reported by search. nil when not searching.
    @Published private(set) var matchCount: Int?
    /// Says when only the newest matches are shown, or Expand all could not open everything.
    @Published private(set) var notice: String?
    @Published private(set) var error: String?
    @Published private(set) var loading = true
    @Published private(set) var busy = false
    @Published private(set) var forgetting: MemoryNode?

    private let projectId: String
    private let client: any ProjectMemoryClient
    private var roots: [MemoryNode] = []
    private var children: [String: [MemoryNode]] = [:]
    private var expanded = Set<String>()
    private var nodes: [String: MemoryNode] = [:]
    private var parents: [String: String] = [:]
    private var searchRoots: [MemoryNode]?
    private var searchChildren: [String: [MemoryNode]] = [:]
    private var searchCollapsed = Set<String>()
    private var searchGeneration = 0
    private var loadedOnce = false
    private var refreshTask: Task<Void, Never>?

    init(projectId: String, client: any ProjectMemoryClient) {
        self.projectId = projectId
        self.client = client
    }

    /// Cancels a pending live refresh when the page goes away.
    func stop() { refreshTask?.cancel() }

    var searching: Bool { searchRoots != nil }

    func node(_ key: String) -> MemoryNode? { nodes[key] }

    /// Loaded children of a node in the browsing tree, nil until loaded.
    func children(of key: String) -> [MemoryNode]? { children[key] }

    // MARK: Loading

    /// The top-level blocks and their children. The first load opens the newest block.
    func load() async {
        error = nil
        do {
            let tree = try await client.memoryTree(projectId, range: nil, depth: 2, reveal: [])
            ingestRoots(tree)
            if !loadedOnce, let newest = roots.first, children[newest.key] != nil { expanded.insert(newest.key) }
            loadedOnce = true
        } catch {
            guard !(error is CancellationError), !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
        guard !Task.isCancelled else { return }
        loading = false
        rebuild()
    }

    /// Coalesces live changes (new notes, rebuilt summaries) into one refresh that keeps what is open.
    func scheduleRefresh() {
        guard loadedOnce else { return }
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    /// Reloads the top two levels and every open node deeper down, then reruns a search.
    func refresh() async {
        // Parents first, so each open node is known again before its children load.
        let open = expanded.compactMap(MemoryRange.init(key:)).sorted { $0.hi - $0.lo > $1.hi - $1.lo }
        await load()
        for range in open where children[range.key] == nil {
            guard let node = nodes[range.key], (try? await loadChildren(node)) != nil else {
                expanded.remove(range.key)
                continue
            }
        }
        expanded.formIntersection(Set(children.keys))
        rebuild()
        if searching { await search() }
    }

    private func ingestRoots(_ tree: MemoryTree) {
        count = tree.count
        children.removeAll()
        nodes.removeAll()
        parents.removeAll()
        roots = tree.nodes.map(\.node)
        for node in tree.nodes { ingest(node, parent: nil, into: &children) }
    }

    /// Records a tree node and its loaded children in `cache`.
    private func ingest(_ tree: MemoryTreeNode, parent: String?, into cache: inout [String: [MemoryNode]]) {
        let node = tree.node
        nodes[node.key] = node
        if let parent { parents[node.key] = parent }
        guard let kids = tree.children else { return }
        cache[node.key] = kids.map(\.node)
        for kid in kids { ingest(kid, parent: node.key, into: &cache) }
    }

    @discardableResult
    private func loadChildren(_ node: MemoryNode) async throws -> [MemoryNode] {
        if let loaded = children[node.key] { return loaded }
        let tree = try await client.memoryTree(projectId, range: MemoryRange(lo: node.lo, hi: node.hi), depth: 1,
                                               reveal: [])
        let kids = tree.nodes.map(\.node)
        children[node.key] = kids
        for kid in tree.nodes { ingest(kid, parent: node.key, into: &children) }
        return kids
    }

    /// Loads a summary's children for the detail column without opening it in the tree.
    func ensureChildren(_ key: String) async {
        guard let node = nodes[key], node.hi > node.lo, children[key] == nil else { return }
        do { try await loadChildren(node) } catch { self.error = error.localizedDescription }
        rebuild()
    }

    // MARK: Expanding

    func isExpanded(_ key: String) -> Bool {
        searching ? searchChildren[key] != nil && !searchCollapsed.contains(key) : expanded.contains(key)
    }

    func toggle(_ key: String) async {
        isExpanded(key) ? collapse(key) : await expand(key)
    }

    func expand(_ key: String) async {
        if searching {
            searchCollapsed.remove(key)
            rebuild()
            return
        }
        guard let node = nodes[key], node.hi > node.lo else { return }
        if children[key] == nil {
            busy = true
            error = nil
            do { try await loadChildren(node) } catch { self.error = error.localizedDescription }
            busy = false
        }
        if children[key] != nil { expanded.insert(key) }
        rebuild()
    }

    func collapse(_ key: String) {
        if searching { searchCollapsed.insert(key) } else { expanded.remove(key) }
        rebuild()
    }

    /// Opens everything pilotd returns in one bounded request; the rest opens one node at a time.
    func expandAll() async {
        if searching {
            searchCollapsed.removeAll()
            rebuild()
            return
        }
        busy = true
        error = nil
        do {
            let tree = try await client.memoryTree(projectId, range: nil, depth: 64, reveal: [])
            ingestRoots(tree)
            expanded = Set(children.keys)
            notice = tree.truncated ? "Memory is too large to open at once. Open the rest one summary at a time." : nil
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
        rebuild()
    }

    func collapseAll() {
        if searching { searchCollapsed = Set(searchChildren.keys) } else { expanded.removeAll() }
        notice = searching ? notice : nil
        rebuild()
    }

    /// Opens the path to a note in the browsing tree and selects it, such as a "Replaced by #n" link.
    func reveal(note index: Int) async {
        let path = MemoryTreeShape.path(to: index, count: count)
        guard !path.isEmpty else { return }
        if searching { clearSearch() }
        busy = true
        for range in path.dropLast() {
            guard let node = nodes[range.key] else { break }
            do { try await loadChildren(node) } catch { self.error = error.localizedDescription; break }
            expanded.insert(range.key)
        }
        busy = false
        if let last = path.last, nodes[last.key] != nil { selection = last.key }
        rebuild()
    }

    /// Selects a node, opening its parents in the browsing tree.
    func select(_ key: String) {
        if !searching {
            var parent = parents[key]
            while let key = parent {
                expanded.insert(key)
                parent = parents[key]
            }
        }
        selection = key
        rebuild()
    }

    // MARK: Searching

    /// Runs the query as a regular expression and shows the newest matches in the tree with their summaries.
    func search() async {
        let regex = query.trimmingCharacters(in: .whitespaces)
        guard !regex.isEmpty else { clearSearch(); return }
        searchGeneration += 1
        let generation = searchGeneration
        busy = true
        error = nil
        do {
            let recall = try await client.memoryRecall(projectId, regex: regex)
            let indices = Array(recall.entries.prefix(Self.revealLimit).map(\.index))
            var tree = MemoryTree(count: count, nodes: [])
            if !indices.isEmpty {
                tree = try await client.memoryTree(projectId, range: nil, depth: 1, reveal: indices)
            }
            guard generation == searchGeneration, !Task.isCancelled else { return }
            applySearch(tree, indices: Set(indices), total: recall.matches,
                        limited: recall.truncated || recall.entries.count > indices.count)
        } catch {
            guard generation == searchGeneration else { return }
            if !(error is CancellationError) { self.error = error.localizedDescription }
        }
        if generation == searchGeneration { busy = false }
    }

    private func applySearch(_ tree: MemoryTree, indices: Set<Int>, total: Int, limited: Bool) {
        var cache: [String: [MemoryNode]] = [:]
        for node in tree.nodes { ingest(node, parent: nil, into: &cache) }
        var counts: [String: Int] = [:]
        func tally(_ node: MemoryTreeNode) -> Int {
            let own = node.entry.map { indices.contains($0.index) ? 1 : 0 } ?? 0
            let sum = own + (node.children ?? []).reduce(0) { $0 + tally($1) }
            counts[node.node.key] = sum
            return sum
        }
        for node in tree.nodes { _ = tally(node) }
        searchRoots = tree.nodes.map(\.node)
        searchChildren = cache
        searchCollapsed.removeAll()
        matches = counts
        matchCount = total
        notice = limited ? "Showing the newest \(indices.count) matches. Narrow the search to see the rest." : nil
        if let selection, counts[selection] == nil { self.selection = nil }
        rebuild()
    }

    /// Back to the browsing tree, keeping what was open there.
    func clearSearch() {
        searchGeneration += 1
        busy = false
        guard searching || matchCount != nil else { return }
        searchRoots = nil
        searchChildren.removeAll()
        searchCollapsed.removeAll()
        matches = nil
        matchCount = nil
        notice = nil
        rebuild()
    }

    // MARK: Forgetting

    func requestForget(_ node: MemoryNode) {
        guard node.canForget else { return }
        forgetting = node
    }
    func cancelForget() { forgetting = nil }

    func confirmForget() async {
        guard let node = forgetting else { return }
        forgetting = nil
        busy = true
        error = nil
        do {
            try await client.forgetMemory(projectId, lo: node.lo, hi: node.hi)
            await refresh()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    // MARK: Keyboard

    func moveSelection(by offset: Int) {
        guard !rows.isEmpty else { return }
        guard let current = selection, let index = rows.firstIndex(where: { $0.id == current }) else {
            selection = offset > 0 ? rows.first?.id : rows.last?.id
            return
        }
        selection = rows[max(0, min(rows.count - 1, index + offset))].id
    }

    /// → opens a closed summary, or moves into an open one.
    func moveRight() async {
        guard let key = selection, let row = rows.first(where: { $0.id == key }), row.expandable else { return }
        if row.expanded { moveSelection(by: 1) } else { await expand(key) }
    }

    /// ← closes an open summary, or moves to the parent.
    func moveLeft() {
        guard let key = selection, let row = rows.first(where: { $0.id == key }) else { return }
        if row.expandable, row.expanded { collapse(key) } else if let parent = parents[key] { selection = parent }
    }

    // MARK: Rows

    private func rebuild() {
        var out: [MemoryTreeRow] = []
        let top = searchRoots ?? roots
        let cache = searching ? searchChildren : children
        func walk(_ node: MemoryNode, depth: Int, lines: [Bool], first: Bool) {
            let open = isExpanded(node.key) && cache[node.key] != nil
            out.append(MemoryTreeRow(node: node, depth: depth, guides: Array(lines.dropLast()),
                                     isLast: !(lines.last ?? false), expanded: open,
                                     startsGroup: depth == 0 && !first))
            guard open, let kids = cache[node.key] else { return }
            for (index, kid) in kids.enumerated() {
                walk(kid, depth: depth + 1, lines: lines + [index < kids.count - 1], first: false)
            }
        }
        for (index, root) in top.enumerated() { walk(root, depth: 0, lines: [], first: index == 0) }
        if rows != out { rows = out }
    }
}

extension MemoryRange {
    var key: String { "\(lo)-\(hi)" }

    /// Parses a node key ("lo-hi").
    init?(key: String) {
        let parts = key.split(separator: "-")
        guard parts.count == 2, let lo = Int(parts[0]), let hi = Int(parts[1]) else { return nil }
        self.init(lo: lo, hi: hi)
    }
}

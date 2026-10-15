import Foundation
import PilotCore
import Testing
@testable import Pilot

/// Serves a fake log of `count` notes in the same shape as pilotd's tree endpoint.
@MainActor
private final class MemoryTreeClient: ProjectMemoryClient {
    var count = 162
    var recallIndices: [Int] = []
    var failure: Error?
    private(set) var treeRequests: [(range: MemoryRange?, depth: Int, reveal: [Int])] = []
    private(set) var forgotten: [MemoryRange] = []
    private(set) var requestedRegex: String?

    func memoryTree(_ projectId: String, range: MemoryRange?, depth: Int, reveal: [Int]) async throws -> MemoryTree {
        treeRequests.append((range, depth, reveal))
        if let failure { throw failure }
        func wanted(_ range: MemoryRange) -> Bool { reveal.isEmpty || reveal.contains { range.lo <= $0 && $0 <= range.hi } }
        func make(_ range: MemoryRange, level: Int) -> MemoryTreeNode {
            if range.lo == range.hi {
                let entry = MemoryEntry(index: range.lo, id: "n\(range.lo)", deviceId: "d", at: 0, sessionId: "s",
                                        text: "note \(range.lo)")
                return MemoryTreeNode(lo: range.lo, hi: range.hi, text: entry.text, entry: entry)
            }
            let deeper = !reveal.isEmpty || level + 1 < depth
            let kids = MemoryTreeShape.children(of: range).filter(wanted).map { make($0, level: level + 1) }
            return MemoryTreeNode(lo: range.lo, hi: range.hi, text: "summary \(range.key)", children: deeper ? kids : nil)
        }
        let base = range.map(MemoryTreeShape.children(of:)) ?? MemoryTreeShape.roots(count: count)
        return MemoryTree(count: count, nodes: base.filter(wanted).map { make($0, level: 0) })
    }

    func memoryRecall(_ projectId: String, regex: String) async throws -> MemoryRecall {
        requestedRegex = regex
        if let failure { throw failure }
        let entries = recallIndices.map {
            MemoryEntry(index: $0, id: "n\($0)", deviceId: "d", at: 0, sessionId: "s", text: "note \($0)")
        }
        return MemoryRecall(count: count, matches: entries.count, entries: entries, truncated: false)
    }

    func forgetMemory(_ projectId: String, lo: Int, hi: Int) async throws {
        if let failure { throw failure }
        forgotten.append(MemoryRange(lo: lo, hi: hi))
    }
}

@Test func memoryTreeShapeMatchesTheDaemonsGrouping() {
    #expect(MemoryTreeShape.roots(count: 162).map(\.key) == ["160-161", "128-159", "0-127"])
    #expect(MemoryTreeShape.roots(count: 0).isEmpty)
    #expect(MemoryTreeShape.roots(count: 1).map(\.key) == ["0-0"])
    #expect(MemoryTreeShape.children(of: MemoryRange(lo: 128, hi: 159)).map(\.key) == ["144-159", "128-143"])
    #expect(MemoryTreeShape.children(of: MemoryRange(lo: 0, hi: 15)).map(\.lo) == Array((0...15).reversed()))
    #expect(MemoryTreeShape.path(to: 3, count: 162).map(\.key) == ["0-127", "0-63", "0-31", "0-15", "3-3"])
    #expect(MemoryTreeShape.path(to: 162, count: 162).isEmpty)
    #expect(MemoryRange(key: "128-159") == MemoryRange(lo: 128, hi: 159))
    #expect(MemoryRange(key: "oops") == nil)
}

@Test @MainActor func memoryPageOpensTheNewestBlockWithGuides() async {
    let client = MemoryTreeClient()
    let model = MemoryPageModel(projectId: "p", client: client)
    await model.load()

    #expect(client.treeRequests.count == 1 && client.treeRequests[0].depth == 2)
    #expect(model.count == 162)
    #expect(model.rows.map(\.id) == ["160-161", "161-161", "160-160", "128-159", "0-127"])
    #expect(model.rows[0].expanded && !model.rows[3].expanded)
    #expect(!model.rows[1].isLast && model.rows[2].isLast)
    #expect(model.rows[3].startsGroup && !model.rows[0].startsGroup)
}

@Test @MainActor func memoryPageLoadsChildrenOncePerNode() async {
    let client = MemoryTreeClient()
    let model = MemoryPageModel(projectId: "p", client: client)
    await model.load()

    await model.expand("128-159")
    #expect(client.treeRequests.count == 1)
    await model.expand("144-159")
    #expect(client.treeRequests.count == 2)
    #expect(client.treeRequests[1].range == MemoryRange(lo: 144, hi: 159))
    let index = model.rows.firstIndex { $0.id == "159-159" }
    #expect(index != nil)
    // Notes under the first half keep their grandparent's guide running down to the second half.
    if let index { #expect(model.rows[index].guides == [true]) }

    model.collapse("144-159")
    await model.toggle("144-159")
    #expect(client.treeRequests.count == 2)
    #expect(model.rows.contains { $0.id == "144-144" })
}

@Test @MainActor func memoryPageExpandAllAndCollapseAll() async {
    let client = MemoryTreeClient()
    let model = MemoryPageModel(projectId: "p", client: client)
    await model.load()

    await model.expandAll()
    #expect(client.treeRequests.last?.depth == 64)
    // 162 notes, 3 top-level blocks, 2 halves of #128–159 and 14 summaries under #0–127.
    let everyNode = 181
    #expect(model.rows.count == everyNode)
    model.collapseAll()
    #expect(model.rows.map(\.id) == ["160-161", "128-159", "0-127"])
}

@Test @MainActor func memoryPageSearchRevealsMatchesInTheTree() async {
    let client = MemoryTreeClient()
    client.recallIndices = [150, 3]
    let model = MemoryPageModel(projectId: "p", client: client)
    await model.load()
    model.query = "note"

    await model.search()
    #expect(client.requestedRegex == "note")
    #expect(client.treeRequests.last?.reveal == [150, 3])
    #expect(model.searching)
    #expect(model.matchCount == 2)
    #expect(model.matches?["0-127"] == 1 && model.matches?["128-159"] == 1)
    #expect(model.rows.map(\.id) == ["128-159", "144-159", "150-150", "0-127", "0-63", "0-31", "0-15", "3-3"])

    model.collapse("0-127")
    #expect(model.rows.last?.id == "0-127")
    model.clearSearch()
    #expect(!model.searching && model.matches == nil)
    #expect(model.rows.map(\.id).prefix(3) == ["160-161", "161-161", "160-160"])
}

@Test @MainActor func memoryPageSearchWithoutMatchesShowsNoRows() async {
    let client = MemoryTreeClient()
    let model = MemoryPageModel(projectId: "p", client: client)
    await model.load()
    model.query = "nothing"
    await model.search()
    #expect(model.searching && model.rows.isEmpty && model.matchCount == 0)
}

@Test @MainActor func memoryPageArrowKeysMoveAndFold() async {
    let client = MemoryTreeClient()
    let model = MemoryPageModel(projectId: "p", client: client)
    await model.load()

    model.moveSelection(by: 1)
    #expect(model.selection == "160-161")
    model.moveSelection(by: 1)
    #expect(model.selection == "161-161")
    model.moveLeft()
    #expect(model.selection == "160-161")
    model.moveLeft()
    #expect(!model.rows[0].expanded)
    await model.moveRight()
    #expect(model.rows[0].expanded && model.selection == "160-161")
    await model.moveRight()
    #expect(model.selection == "161-161")
    model.moveSelection(by: -5)
    #expect(model.selection == "160-161")
}

@Test @MainActor func memoryPageRevealsAReplacingNote() async {
    let client = MemoryTreeClient()
    let model = MemoryPageModel(projectId: "p", client: client)
    await model.load()

    await model.reveal(note: 3)
    #expect(model.selection == "3-3")
    #expect(model.rows.contains { $0.id == "3-3" })
}

@Test func memoryPageMarksReplacedNotesAndSummaries() {
    let old = MemoryEntry(index: 2, id: "a", deviceId: "d", at: 0, sessionId: "s", text: "Old fact", replacedBy: 5)
    let note = MemoryNode(lo: 2, hi: 2, text: old.text, entry: old, replaced: true)
    #expect(note.isReplaced)
    #expect(note.title == "Old fact")
    #expect(old.replacedLabel == "Replaced by #5")

    let emptied = MemoryNode(lo: 0, hi: 3, replaced: true)
    #expect(emptied.isReplaced)
    #expect(emptied.title == "All notes here were replaced by later corrections")
    #expect(MemoryNode(lo: 128, hi: 159, text: "s").rangeLabel == "#128–159 · 32 notes")

    let current = MemoryNode(lo: 4, hi: 7, text: "Summary")
    #expect(!current.isReplaced)
    #expect(MemoryNode(lo: 0, hi: 3, pending: true).title == "Summary is being built…")
    #expect(MemoryEntry(index: 5, id: "b", deviceId: "d", at: 0, sessionId: "s", text: "New").replacedLabel == nil)
}

@Test @MainActor func memoryPageRequiresConfirmationBeforeForgetting() async {
    let client = MemoryTreeClient()
    let model = MemoryPageModel(projectId: "p", client: client)
    await model.load()
    let summary = MemoryNode(lo: 128, hi: 159, text: "bad summary")

    model.requestForget(summary)
    #expect(model.forgetting == summary)
    #expect(client.forgotten.isEmpty)

    await model.confirmForget()
    #expect(model.forgetting == nil)
    #expect(client.forgotten == [MemoryRange(lo: 128, hi: 159)])
    #expect(model.rows.first?.expanded == true)
}

@Test @MainActor func memoryPageOffersForgetOnlyOnSummaries() async {
    let entry = MemoryEntry(index: 3, id: "note", deviceId: "d", at: 0, sessionId: "s", text: "A single note")
    let note = MemoryNode(lo: 3, hi: 3, text: entry.text, entry: entry)
    #expect(!note.canForget)
    #expect(MemoryNode(lo: 0, hi: 3, text: "summary").canForget)
    #expect(!MemoryNode(lo: 0, hi: 3, pending: true).canForget)

    let client = MemoryTreeClient()
    let model = MemoryPageModel(projectId: "p", client: client)
    model.requestForget(note)
    #expect(model.forgetting == nil)
    await model.confirmForget()
    #expect(client.forgotten.isEmpty)
}

@Test @MainActor func memoryPageSurfacesLoadAndSearchErrors() async {
    let client = MemoryTreeClient()
    client.failure = MemoryPageFailure.unavailable
    let model = MemoryPageModel(projectId: "p", client: client)

    await model.load()
    #expect(!model.loading)
    #expect(model.error == "Memory unavailable")

    model.query = "note"
    await model.search()
    #expect(model.error == "Memory unavailable")
    #expect(model.matchCount == nil)
}

@Test @MainActor func memoryPageReplacesTheProjectPageUntilAnotherPageOpens() {
    let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "memory-page-\(UUID())")!)
    app.client.loadFixture(projects: [Project(id: "p", name: "Repo", path: "/repo", createdAt: 1)], sessions: [
        SessionSummary(id: "s", title: "Chat", cwd: "/repo", projectId: "p", createdAt: 1, updatedAt: 1, state: "idle"),
    ])
    app.openMemory("p")
    #expect(app.selectedProjectId == "p" && app.memoryProjectId == "p")
    app.openProject("p")
    #expect(app.selectedProjectId == "p" && app.memoryProjectId == nil)
    app.openMemory("p")
    app.openSlackTriage("p")
    #expect(app.memoryProjectId == nil && app.slackTriageProjectId == "p")
    app.openMemory("p")
    app.selectedSessionId = "s"
    #expect(app.selectedProjectId == nil && app.memoryProjectId == nil)
}

private enum MemoryPageFailure: LocalizedError {
    case unavailable
    var errorDescription: String? { "Memory unavailable" }
}

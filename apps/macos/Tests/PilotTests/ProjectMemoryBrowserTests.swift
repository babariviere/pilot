import Foundation
import PilotCore
import Testing
@testable import Pilot

@MainActor
private final class MemoryBrowserClient: ProjectMemoryClient {
    var wakeResult = MemoryView(count: 1, nodes: [MemoryNode(lo: 0, hi: 1, text: "project summary")],
                                omittedBefore: 0, text: "")
    var zoomResult = [MemoryNode(lo: 0, hi: 0, text: "one half"), MemoryNode(lo: 1, hi: 1, text: "two half")]
    var recallResult = MemoryRecall(count: 2, matches: 1,
                                    entries: [MemoryEntry(index: 1, id: "entry", deviceId: "device", at: 0,
                                                         sessionId: "chat", text: "matching note")], truncated: false)
    var failure: Error?
    private(set) var forgotten: [MemoryRange] = []
    private(set) var requestedRegex: String?

    func memoryWake(_ projectId: String) async throws -> MemoryView {
        if let failure { throw failure }
        return wakeResult
    }
    func memoryZoom(_ projectId: String, lo: Int, hi: Int) async throws -> [MemoryNode] {
        if let failure { throw failure }
        return zoomResult
    }
    func memoryRecall(_ projectId: String, regex: String) async throws -> MemoryRecall {
        requestedRegex = regex
        if let failure { throw failure }
        return recallResult
    }
    func forgetMemory(_ projectId: String, lo: Int, hi: Int) async throws {
        if let failure { throw failure }
        forgotten.append(MemoryRange(lo: lo, hi: hi))
    }
}

@Test @MainActor func memoryBrowserExpandsNodesOnDemand() async throws {
    let client = MemoryBrowserClient()
    let model = ProjectMemoryBrowserModel(projectId: "project", client: client)
    await model.load()

    let root = try #require(model.roots.first)
    await model.expand(root)

    #expect(model.expanded.contains("0-1"))
    #expect(model.children["0-1"] == client.zoomResult)
}

@Test @MainActor func memoryBrowserSearchShowsMatches() async {
    let client = MemoryBrowserClient()
    let model = ProjectMemoryBrowserModel(projectId: "project", client: client)
    model.query = "matching"

    await model.search()

    #expect(client.requestedRegex == "matching")
    #expect(model.resultCount == 1)
    #expect(model.results.first?.text == "matching note")
}

@Test func memoryBrowserMarksReplacedNotesAndSummaries() {
    let old = MemoryEntry(index: 2, id: "a", deviceId: "d", at: 0, sessionId: "s", text: "Old fact", replacedBy: 5)
    let note = MemoryNode(lo: 2, hi: 2, text: old.text, entry: old, replaced: true)
    #expect(note.isReplaced)
    #expect(note.title == "Old fact")
    #expect(old.replacedLabel == "Replaced by #5")

    let emptied = MemoryNode(lo: 0, hi: 3, replaced: true)
    #expect(emptied.isReplaced)
    #expect(emptied.title == "All notes here were replaced by later corrections")

    let current = MemoryNode(lo: 4, hi: 7, text: "Summary")
    #expect(!current.isReplaced)
    #expect(MemoryNode(lo: 0, hi: 3, pending: true).title == "Summary is being built…")
    #expect(MemoryEntry(index: 5, id: "b", deviceId: "d", at: 0, sessionId: "s", text: "New").replacedLabel == nil)
}

@Test @MainActor func memoryBrowserRequiresConfirmationBeforeForgetting() async {
    let client = MemoryBrowserClient()
    let model = ProjectMemoryBrowserModel(projectId: "project", client: client)
    let summary = MemoryNode(lo: 4, hi: 7, text: "bad summary")

    model.requestForget(summary)
    #expect(model.forgetting == summary)
    #expect(client.forgotten.isEmpty)

    await model.confirmForget()
    #expect(model.forgetting == nil)
    #expect(client.forgotten == [MemoryRange(lo: 4, hi: 7)])
}

@Test @MainActor func memoryBrowserSurfacesLoadAndSearchErrors() async {
    let client = MemoryBrowserClient()
    client.failure = MemoryBrowserFailure.unavailable
    let model = ProjectMemoryBrowserModel(projectId: "project", client: client)

    await model.load()
    #expect(!model.loading)
    #expect(model.error == "Memory unavailable")

    model.query = "note"
    await model.search()
    #expect(model.error == "Memory unavailable")
    #expect(model.resultCount == nil)
}

private enum MemoryBrowserFailure: LocalizedError {
    case unavailable
    var errorDescription: String? { "Memory unavailable" }
}

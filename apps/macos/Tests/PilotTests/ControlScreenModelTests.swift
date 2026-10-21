import Foundation
import PilotCore
import Testing
@testable import Pilot

/// Answers like pilotd's memory routes from a small in-memory log, recording what was asked.
@MainActor
private final class FakeMemory: ControlMemoryReading {
    var lines = [ControlMemoryLine(start: 0, n: 2, text: "first two"), ControlMemoryLine(start: 2, n: 1, text: "", pending: true)]
    var entries = (0 ..< 3).reversed().map { ControlMemoryLogEntry(id: $0, at: Double($0), kind: .user, text: "m\($0)") }
    var pages: [Int: [String]] = [:]
    var failNodes = false
    private(set) var nodeCalls: [String] = []
    private(set) var queries: [String?] = []
    private(set) var befores: [Int?] = []

    func controlMemoryView() async throws -> ControlMemoryViewResponse { ControlMemoryViewResponse(lines: lines) }

    func controlMemoryNode(start: Int, n: Int, offset: Int?) async throws -> ControlMemoryNodeResponse {
        nodeCalls.append("\(start)+\(n)@\(offset ?? 0)")
        if failNodes { throw ControlScreenError.missingMessage }
        if n > 1 {
            return ControlMemoryNodeResponse(lines: [ControlMemoryLine(start: start, n: n / 2, text: "a"),
                                                     ControlMemoryLine(start: start + n / 2, n: n / 2, text: "b")])
        }
        let parts = pages[start] ?? ["message \(start)"]
        // Each fake page is ten characters of offset apart.
        let index = (offset ?? 0) / 10
        let next = index + 1 < parts.count ? (index + 1) * 10 : nil
        return ControlMemoryNodeResponse(ControlMemoryMessagePage(
            message: .init(id: start, at: 1, kind: .assistant, text: parts[index]), next: next))
    }

    func controlMemoryMessages(before: Int?, limit: Int, query: String?) async throws -> ControlMemoryMessagesResponse {
        queries.append(query)
        befores.append(before)
        let matching = entries.filter { entry in
            (before.map { entry.id < $0 } ?? true) && (query.map { entry.text.localizedCaseInsensitiveContains($0) } ?? true)
        }
        let page = Array(matching.prefix(limit))
        return ControlMemoryMessagesResponse(messages: page, next: matching.count > limit ? page.last?.id : nil)
    }

    func controlMemoryStats() async throws -> ControlMemoryStats {
        ControlMemoryStats(count: entries.count, pendingJobs: 1, failedJobs: 0, viewBytes: 10, merging: false, dbBytes: 4096)
    }
}

@Test @MainActor func loadingFillsEverySectionAndPendingLinesAreCounted() async {
    let source = FakeMemory()
    let state = ControlScreenModel(source: source)
    await state.load()
    #expect(state.viewLoaded && state.logLoaded)
    #expect(state.lines.count == 2)
    #expect(state.pendingLines == 1)
    #expect(state.log.map(\.id) == [2, 1, 0])
    #expect(state.logNext == nil)
    #expect(state.stats?.count == 3)
}

@Test @MainActor func expandingASummaryLoadsItsHalvesThenTheMessage() async {
    let source = FakeMemory()
    let state = ControlScreenModel(source: source)
    await state.load()
    await state.toggle(state.lines[0])
    #expect(state.treeRows.map(\.id) == ["0+2", "0+1", "1+1", "2+1"])
    await state.toggle(ControlMemoryLine(start: 1, n: 1, text: "b"))
    #expect(state.treeRows.map(\.id) == ["0+2", "0+1", "1+1", "message:1", "2+1"])
    #expect(state.messages[1]?.text == "message 1")
    // Closing and reopening reuses what was loaded.
    await state.toggle(state.lines[0])
    await state.toggle(state.lines[0])
    #expect(source.nodeCalls == ["0+2@0", "1+1@0"])
}

@Test @MainActor func longMessagesPageWithShowMore() async {
    let source = FakeMemory()
    source.pages[2] = ["one ", "two ", "three"]
    let state = ControlScreenModel(source: source)
    await state.load()
    await state.toggle(state.lines[1])
    #expect(state.messages[2]?.text == "one ")
    await state.loadMore(message: 2)
    await state.loadMore(message: 2)
    #expect(state.messages[2]?.text == "one two three")
    #expect(state.messages[2]?.canLoadMore == false)
    await state.loadMore(message: 2)
    #expect(source.nodeCalls == ["2+1@0", "2+1@10", "2+1@20"])
}

@Test @MainActor func failuresShowInPlaceAndRetry() async {
    let source = FakeMemory()
    source.failNodes = true
    let state = ControlScreenModel(source: source)
    await state.load()
    await state.toggle(state.lines[0])
    #expect(state.treeRows.map(\.id) == ["0+2", "failed:0+2", "2+1"])
    source.failNodes = false
    await state.retry(state.lines[0])
    #expect(state.treeRows.map(\.id) == ["0+2", "0+1", "1+1", "2+1"])
}

@Test @MainActor func searchReplacesTheLogAndShowMoreContinuesIt() async {
    let source = FakeMemory()
    source.entries = (0 ..< 120).reversed().map {
        ControlMemoryLogEntry(id: $0, at: Double($0), kind: .user, text: $0 % 2 == 0 ? "even \($0)" : "odd \($0)")
    }
    let state = ControlScreenModel(source: source)
    await state.load()
    #expect(state.log.count == ControlScreenModel.logPage)
    await state.loadOlderLog()
    #expect(state.log.count == 100)
    #expect(state.log.last?.id == 20)

    state.query = "  EVEN  "
    #expect(state.searchQuery == "EVEN")
    await state.reloadLog()
    #expect(state.logQuery == "EVEN")
    #expect(state.log.first?.id == 118)
    #expect(state.log.count == 50)
    await state.loadOlderLog()
    #expect(state.log.count == 60)
    #expect(state.logNext == nil)
    #expect(source.queries.last == "EVEN")

    state.query = String(repeating: "x", count: 300)
    #expect(state.searchQuery?.count == 200)
}

@Test @MainActor func refreshKeepsOlderPagesExpansionsAndAddsNewRowsOnTop() async {
    let source = FakeMemory()
    source.entries = (0 ..< 60).reversed().map { ControlMemoryLogEntry(id: $0, at: Double($0), kind: .note, text: "n\($0)") }
    let state = ControlScreenModel(source: source)
    await state.load()
    await state.loadOlderLog()
    #expect(state.log.count == 60)
    await state.toggle(state.lines[0])
    source.entries.insert(ControlMemoryLogEntry(id: 60, at: 60, kind: .event, text: "new"), at: 0)
    source.lines.append(ControlMemoryLine(start: 3, n: 1, text: "user: later"))
    await state.refresh()
    #expect(state.log.count == 61)
    #expect(state.log.first?.id == 60)
    #expect(state.lines.count == 3)
    #expect(state.expanded == ["0+2"])
    #expect(state.treeRows.map(\.id).prefix(3) == ["0+2", "0+1", "1+1"])
}

@Test @MainActor func openingALogRowLoadsItsWholeMessage() async {
    let source = FakeMemory()
    let state = ControlScreenModel(source: source)
    await state.load()
    await state.toggleLogRow(1)
    #expect(state.openLogRows == [1])
    #expect(state.messages[1]?.text == "message 1")
    await state.toggleLogRow(1)
    #expect(state.openLogRows.isEmpty)
}

@Test @MainActor func memoryInvalidationsReachControlObservers() {
    let client = PilotClient()
    var changes: [ControlDetailsChange] = []
    let id = client.observeControlDetails { changes.append($0) }
    client.handle(.controlMemoryChanged)
    #expect(changes == [.memory])
    client.stopObservingControlDetails(id)
}

@MainActor
private func appWithControl() -> AppModel {
    let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "control-screen-\(UUID())")!)
    var control = SessionSummary(id: "c", title: "Control", cwd: "", createdAt: 1, updatedAt: 1, state: "idle", mode: .ask,
                                 pinned: true)
    control.control = true
    app.client.loadFixture(projects: [Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)], sessions: [
        control,
        SessionSummary(id: "a", title: "a", cwd: "/tmp", projectId: "p1", createdAt: 1, updatedAt: 2, state: "idle"),
    ])
    return app
}

@Test @MainActor func retiredControlScreenRoutesToHome() {
    let app = appWithControl()
    app.selectedSessionId = "a"
    app.openControlScreen()
    #expect(app.currentRoute == .home)
    #expect(app.currentSelection == .home)
    #expect(app.selectedSessionId == nil && !app.showingControl)
    app.openControlChat()
    #expect(app.currentRoute == .home)
    #expect(SidebarSelection.restoring(.control, in: "p1", sessions: [], missions: [], projectIds: ["p1"]) == .project("p1"))
}

@Test @MainActor func paletteOmitsRetiredControlPagesEvenWithLegacyInventory() {
    let app = appWithControl()
    let catalog = CommandPaletteCatalog(model: app, openSettings: {}, openKeyboardShortcuts: {})
    #expect(!catalog.entries().contains { $0.item.id == "page:control-screen" || $0.item.id == "page:control" })
    #expect(app.controlChat == nil)
    #expect(!app.canGo(to: .control))
}

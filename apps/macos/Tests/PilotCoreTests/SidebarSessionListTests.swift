import Foundation
import Testing
@testable import PilotCore

private func row(_ id: String, pinned: Bool? = nil) -> SessionSummary {
    SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle", pinned: pinned)
}

@Test func shortSidebarListsStayWhole() {
    let sessions = (0..<6).map { row("s\($0)") }
    let result = SidebarSessionList.collapsed(sessions, limit: 5) { _ in false }
    #expect(result.shown.map(\.id) == sessions.map(\.id))
    #expect(result.hidden == 0)
}

@Test func longSidebarListsFoldBeyondTheLimitButKeepImportantChats() {
    var sessions = (0..<10).map { row("s\($0)") }
    sessions[7] = row("pinned-late", pinned: true)
    let result = SidebarSessionList.collapsed(sessions, limit: 3) { $0.id == "s8" }
    #expect(result.shown.map(\.id) == ["s0", "s1", "s2", "pinned-late", "s8"])
    #expect(result.hidden == 5)
}

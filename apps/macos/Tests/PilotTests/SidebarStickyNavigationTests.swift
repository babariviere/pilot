import Foundation
import PilotCore
import Testing
@testable import Pilot

private let pilot = Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)
private let dotfiles = Project(id: "p2", name: "dotfiles", path: "/tmp/dotfiles", createdAt: 1)
private let local = HostRef(hostId: "local", daemonId: "local", lineageId: "l1")
private let box = HostRef(hostId: "box", daemonId: "remote", lineageId: "r1")

private func chat(_ id: String, project: String?, control: Bool = false) throws -> SessionSummary {
    let projectField = project.map { #","projectId":"\#($0)""# } ?? ""
    let json = #"{"id":"\#(id)","title":"\#(id)","cwd":"/tmp","pinned":\#(control),"control":\#(control),"createdAt":1,"updatedAt":2,"state":"idle"\#(projectField)}"#
    return try JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
}

@MainActor private func fixture() throws -> AppModel {
    let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "sidebar-control-\(UUID())")!)
    app.client.loadFixture(projects: [pilot, dotfiles], sessions: [
        try chat("control", project: nil, control: true), try chat("a", project: "p1"), try chat("b", project: "p2"),
    ])
    return app
}

@Test func allControlHistoriesStayOutsideTheNormalSidebarSlot() throws {
    let control = try chat("control", project: nil, control: true)
    let remote = Hosted(ref: HostResourceRef(host: box, kind: .session, localId: "control"), value: control)
    let mine = Hosted(ref: HostResourceRef(host: local, kind: .session, localId: "control"), value: control)
    #expect(RetainedConversation.isHistory(remote.value, reference: remote.ref, localHost: local))
    #expect(RetainedConversation.isHistory(mine.value, reference: mine.ref, localHost: local))
    #expect(RetainedConversation.isHistory(mine.value, reference: nil, localHost: nil))
    #expect(!RetainedConversation.isHistory(try chat("ordinary", project: "p1"), reference: mine.ref, localHost: local))
}

@Test @MainActor func explicitControlHistoryDoesNotBecomeASavedLiveDestination() throws {
    let app = try fixture()
    try app.registerLocal(local)
    app.focus(on: "p1")
    app.navigate(.session, id: "control")
    #expect(app.sidebarScope == "p1" && app.selectedSessionId == "control")
    app.selectedSessionId = nil
    app.reveal(session: "control")
    #expect(app.sidebarScope == "p1" && app.selectedSessionId == "control")
    // A retained conversation is available explicitly, but is not restored as a live destination.
    app.focus(on: "p2")
    app.focus(on: "p1")
    #expect(app.sidebarScope == "p1" && app.selectedSessionId == nil)
    #expect(app.isRetainedHistorySelected == false)
}

@Test func arrowKeysReachTheFixedRowsAsTheListsFirstItems() {
    typealias Nav = SidebarStickyNavigation
    #expect(Nav.step(down: true, sticky: [], current: nil, listHasSelection: false) == .native)
    // From nothing selected, down selects the first fixed row; from it, down enters the list natively.
    #expect(Nav.step(down: true, sticky: ["c"], current: nil, listHasSelection: false) == .select("c"))
    #expect(Nav.step(down: true, sticky: ["c"], current: "c", listHasSelection: false) == .native)
    #expect(Nav.step(down: false, sticky: ["c"], current: "c", listHasSelection: false) == .stay)
    // In the list, up moves natively, reaching the fixed rows only from the first list row.
    #expect(Nav.step(down: false, sticky: ["c"], current: "a", listHasSelection: true) == .nativeOr("c"))
    #expect(Nav.step(down: true, sticky: ["c"], current: "a", listHasSelection: true) == .native)
    // Multiple fixed rows are traversed in order.
    #expect(Nav.step(down: true, sticky: ["c", "r"], current: "c", listHasSelection: false) == .select("r"))
    #expect(Nav.step(down: false, sticky: ["c", "r"], current: "r", listHasSelection: false) == .select("c"))
    #expect(Nav.step(down: false, sticky: ["c", "r"], current: "a", listHasSelection: true) == .nativeOr("r"))
}

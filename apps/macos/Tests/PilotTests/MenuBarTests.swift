import AppKit
import Combine
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func menuBarImagesKeepIdentityAndTemplateRendering() throws {
    let idle = PlaneImage.menuBar(working: false)
    let working = PlaneImage.menuBar(working: true)
    for _ in 0..<100 {
        #expect(PlaneImage.menuBar(working: false) === idle)
        #expect(PlaneImage.menuBar(working: true) === working)
    }
    #expect(idle !== working)
    for image in [idle, working] {
        #expect(image.isTemplate)
        #expect(image.size == NSSize(width: 18, height: 18))
        let bitmap = NSBitmapImageRep(cgImage: try #require(image.cgImage(forProposedRect: nil, context: nil, hints: nil)))
        var opaque = 0
        var transparent = 0
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide {
                let alpha = try #require(bitmap.colorAt(x: x, y: y)).alphaComponent
                if alpha > 0.5 { opaque += 1 }
                if alpha < 0.1 { transparent += 1 }
            }
        }
        #expect(opaque > 5 && transparent > 5)
    }
    #expect(idle.tiffRepresentation != working.tiffRepresentation)
}

@Test @MainActor func menuBarIconOnlyPublishesIdleWorkingTransitionsAsynchronously() async {
    let client = PilotClient()
    let icon = MenuBarIconModel(client: client)
    var changes: [Bool] = []
    let observation = icon.$isWorking.dropFirst().sink { changes.append($0) }
    await drainMenuUpdates()
    #expect(changes.isEmpty)

    client.loadFixture(projects: [], sessions: [menuSession(state: "starting")])
    #expect(!icon.isWorking) // Never notify the menu host inside the source's publication.
    await drainMenuUpdates()
    #expect(icon.isWorking && changes == [true])
    for i in 0..<100 {
        // Match PilotClient.update's synchronous remove/append/sort publication burst.
        client.loadFixture(projects: [], sessions: [])
        client.loadFixture(projects: [], sessions: [menuSession(state: "working", updatedAt: Double(i))])
    }
    await drainMenuUpdates()
    #expect(changes == [true])
    client.loadFixture(projects: [], sessions: [menuSession(state: "working", archivedAt: 10)])
    await drainMenuUpdates()
    #expect(!icon.isWorking && changes == [true, false])
    withExtendedLifetime(observation) {}
}

@Test @MainActor func menuBarContentIgnoresUnrelatedUpdatesButRetainsLiveVisibleChanges() async {
    let model = AppModel()
    let menu = MenuBarModel(model: model, updater: AppUpdater())
    var changes = 0
    let observation = menu.$snapshot.dropFirst().sink { _ in changes += 1 }
    model.client.loadFixture(projects: [], sessions: [menuSession()])
    model.daemon.markRunningForSnapshot()
    await drainMenuUpdates()
    #expect(menu.snapshot.rows.map(\.id) == ["menu-test"])
    #expect(menu.snapshot.statusText == "pilotd running · idle")
    let baseline = changes
    for i in 0..<100 {
        model.sidebarQuery = "query \(i)"
        model.selectedSessionId = "other-\(i)"
        model.inspectorVisible.toggle()
        model.client.loadFixture(projects: [], sessions: [])
        model.client.loadFixture(projects: [], sessions: [menuSession(updatedAt: Double(i))])
    }
    await drainMenuUpdates()
    #expect(changes == baseline)

    model.client.loadFixture(projects: [], sessions: [menuSession(title: "Renamed", state: "working")])
    #expect(menu.snapshot.rows[0].session.title == "Session")
    await drainMenuUpdates()
    #expect(changes == baseline + 1)
    #expect(menu.snapshot.rows[0].session.title == "Renamed")
    #expect(menu.snapshot.rows[0].session.status == .working)
    #expect(menu.snapshot.statusText == "pilotd running · 1 working")

    model.client.loadFixture(projects: [], sessions: [menuSession(archivedAt: 20)])
    await drainMenuUpdates()
    #expect(menu.snapshot.rows.isEmpty)
    #expect(menu.snapshot.statusText == "pilotd running · idle")
    withExtendedLifetime(observation) {}
}

@Test @MainActor func menuBarSnapshotTracksUnreadPRDetailsOrderingAndControls() {
    let sessions = (0..<10).map { menuSession(id: "s\($0)") }
    func snapshot(_ list: [SessionSummary], unread: Bool = false,
                  status: DaemonController.Status = .running, busy: Bool = false,
                  waiting: Bool = false) -> MenuBarSnapshot {
        MenuBarSnapshot(sessions: list, isUnread: { _ in unread }, status: status,
                        lifecycleBusy: busy, waitingToInstall: waiting)
    }
    let original = snapshot(sessions)
    #expect(original.rows.count == 8)
    #expect(original.rows.map(\.id) == Array(sessions.prefix(8)).map(\.id))
    let unread = snapshot(sessions, unread: true)
    #expect(unread != original && unread.rows.allSatisfy(\.isUnread))
    #expect(unread.statusText == "pilotd running · 10 unread")
    #expect(snapshot(Array(sessions.reversed())) != original)
    #expect(snapshot(sessions, busy: true) != original)
    #expect(snapshot(sessions, waiting: true) != original)
    #expect(snapshot(sessions, status: .stopped).statusText == "pilotd stopped")
    #expect(snapshot(sessions, status: .failed("a")) == snapshot(sessions, status: .failed("b")))
    #expect(snapshot(sessions, status: .starting) == snapshot(sessions, status: .unknown))

    let pr = SessionPullRequest(number: 1, url: "https://github.com/a/b/pull/1",
                                title: "PR", state: .open, checkedAt: 1)
    let row = snapshot([menuSession(pullRequest: pr)])
    #expect(row != snapshot([menuSession()]))
    #expect(row != snapshot([menuSession(pullRequest: pr, pullRequestError: "Lookup failed")]))
    let checked = SessionPullRequest(number: 1, url: pr.url, title: pr.title, state: .open, checkedAt: 2)
    #expect(row != snapshot([menuSession(pullRequest: checked)]))
    let merged = SessionPullRequest(number: 1, url: pr.url, title: pr.title, state: .merged, checkedAt: 1)
    #expect(row != snapshot([menuSession(pullRequest: merged)]))

    // Sessions outside the eight-row limit still contribute to activity totals.
    let outside = Array(sessions.prefix(8)) + [menuSession(id: "outside", state: "working")]
    #expect(snapshot(outside).rows == original.rows)
    #expect(snapshot(outside).statusText == "pilotd running · 1 working")
}

private func menuSession(id: String = "menu-test", title: String = "Session", state: String = "idle",
                         updatedAt: Double = 1, pullRequest: SessionPullRequest? = nil,
                         pullRequestError: String? = nil, archivedAt: Double? = nil) -> SessionSummary {
    SessionSummary(id: id, title: title, cwd: "/tmp", createdAt: 1, updatedAt: updatedAt, state: state,
                   pullRequest: pullRequest, pullRequestError: pullRequestError, archivedAt: archivedAt)
}

@MainActor
private func drainMenuUpdates() async {
    // Allow the zero-delay debounce's scheduled delivery to run, not only queued
    // async blocks. No source emits while waiting, so the final snapshot is stable.
    try? await Task.sleep(for: .milliseconds(20))
}

import AppKit
import Combine
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func menuBarImageKeepsIdentityAndTemplateRendering() throws {
    let image = PlaneImage.menuBar
    for _ in 0..<100 { #expect(PlaneImage.menuBar === image) }
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

@Test func menuBarPlaneHeadsTopRightInsideTheImage() throws {
    var transform = PlaneImage.planeTransform
    let plane = try #require(PlaneGlyph.path.copy(using: &transform))
    #expect(CGRect(x: 0, y: 0, width: 18, height: 18).insetBy(dx: 0.4, dy: 0.4).contains(plane.boundingBoxOfPath))
    let nose = CGPoint(x: 0, y: -300).applying(PlaneImage.planeTransform)
    let tail = CGPoint(x: 0, y: 300).applying(PlaneImage.planeTransform)
    #expect(nose.x > tail.x && nose.y < tail.y)
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
    #expect(menu.snapshot.statusText == "Nothing needs you")
    #expect(menu.snapshot.daemonText == "pilotd running")
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
    #expect(menu.snapshot.sections.map(\.title) == ["Working"])
    #expect(menu.snapshot.statusText == "1 working")

    model.client.loadFixture(projects: [], sessions: [menuSession(archivedAt: 20)])
    await drainMenuUpdates()
    #expect(menu.snapshot.rows.isEmpty)
    #expect(menu.snapshot.statusText == "Nothing needs you")
    withExtendedLifetime(observation) {}
}

@Test @MainActor func menuBarSnapshotListsChatsByUrgencyWithinItsLimit() {
    func snapshot(_ list: [SessionSummary], unread: Set<String> = [],
                  status: DaemonController.Status = .running, busy: Bool = false,
                  waiting: Bool = false) -> MenuBarSnapshot {
        MenuBarSnapshot(sessions: list, isUnread: { unread.contains($0.id) }, status: status,
                        lifecycleBusy: busy, waitingToInstall: waiting)
    }
    let quiet = (0..<10).map { menuSession(id: "s\($0)") }
    let original = snapshot(quiet)
    #expect(original.rows.count == MenuBarSnapshot.limit)
    #expect(original.rows.map(\.id) == Array(quiet.prefix(8)).map(\.id))
    #expect(original.sections.map(\.title) == ["Recent"])
    #expect(snapshot(Array(quiet.reversed())) != original)
    #expect(snapshot(quiet, busy: true) != original)
    #expect(snapshot(quiet, waiting: true) != original)
    #expect(snapshot(quiet, status: .stopped).statusText == "pilotd stopped")
    #expect(snapshot(quiet, status: .failed("a")) == snapshot(quiet, status: .failed("b")))
    #expect(snapshot(quiet, status: .starting) == snapshot(quiet, status: .unknown))

    // Needs you leads, then Working, then Recent, in the sidebar's order, whatever the list order.
    let mixed = [menuSession(id: "quiet"), menuSession(id: "busy", state: "working"),
                 menuSession(id: "unread"), menuSession(id: "failed", state: "failed")]
    let urgent = snapshot(mixed, unread: ["unread"])
    #expect(urgent.sections.map(\.title) == ["Needs you", "Working", "Recent"])
    #expect(urgent.rows.map(\.id) == ["failed", "unread", "busy", "quiet"])
    #expect(urgent.rows.first?.accessibilityLabel == "Session, Failed")
    #expect(urgent.statusText == "2 need you · 1 working")
    #expect(snapshot([menuSession(id: "unread")], unread: ["unread"]).statusText == "1 needs you")

    // Chats past the limit still count in the heading.
    let outside = Array(quiet.prefix(8)) + [menuSession(id: "outside", state: "working")]
    #expect(snapshot(outside).rows.count == MenuBarSnapshot.limit)
    #expect(snapshot(outside).rows.map(\.id) == ["outside"] + Array(quiet.prefix(7)).map(\.id))
    #expect(snapshot(outside).statusText == "1 working")

    // PR details are not shown, so they do not change the menu.
    let pr = SessionPullRequest(number: 1, url: "https://github.com/a/b/pull/1",
                                title: "PR", state: .draft, checkedAt: 1)
    #expect(snapshot([menuSession(pullRequest: pr)]) == snapshot([menuSession()]))
}

private func menuSession(id: String = "menu-test", title: String = "Session", state: String = "idle",
                         updatedAt: Double = 1, pullRequest: SessionPullRequest? = nil,
                         archivedAt: Double? = nil) -> SessionSummary {
    SessionSummary(id: id, title: title, cwd: "/tmp", createdAt: 1, updatedAt: updatedAt, state: state,
                   pullRequest: pullRequest, archivedAt: archivedAt)
}

@MainActor
private func drainMenuUpdates() async {
    // Allow the zero-delay debounce's scheduled delivery to run, not only queued
    // async blocks. No source emits while waiting, so the final snapshot is stable.
    try? await Task.sleep(for: .milliseconds(20))
}

/// Chat rows use static native images. A live spinner would refresh the menu every frame and close the pilotd submenu.
@Test @MainActor func menuBarChatIconsAreStaticTemplates() {
    let statuses: [SessionStatus] = [.working, .question, .done, .failed, .stopped, .idle, .paused, .usagePaused,
                                     .offlinePaused]
    for status in statuses {
        let image = status.icon.menuImage
        #expect(image.isTemplate)
        #expect(image.size.width > 0 && image.size.height > 0, "Empty menu icon for \(status.rawValue)")
    }
}

import AppKit
import PilotCore
import SwiftUI

extension Snapshot {
    /// Regression fixture: legacy Control inventory never creates a sidebar row, in either scope or a short list.
    static func renderControlSidebar(model: AppModel, to directory: URL) async {
        let now = Fixtures.now
        var control = SessionSummary(id: "control", title: "Control", cwd: "", createdAt: now, updatedAt: now,
                                     state: "working", mode: .ask, pinned: true)
        control.control = true
        model.client.loadFixture(projects: Fixtures.projects, sessions: Fixtures.sessions + [control])
        model.selectedSessionId = nil
        for (name, scope) in [("all", nil), ("focused", "p1")] as [(String, String?)] {
            model.focus(on: scope)
            model.selectedSessionId = "control"
            await render(SessionSidebar(model: model, client: model.client), size: CGSize(width: 280, height: 640),
                         to: directory.appending(path: "control-sidebar-\(name).png"))
        }
        model.focus(on: nil)
        model.selectedSessionId = Fixtures.sessions.first?.id
        await render(SessionSidebar(model: model, client: model.client), size: CGSize(width: 280, height: 360),
                     to: directory.appending(path: "control-sidebar-short.png"))
    }
}


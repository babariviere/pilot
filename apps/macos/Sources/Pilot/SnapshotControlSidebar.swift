import AppKit
import PilotCore
import SwiftUI

extension Snapshot {
    /// The Control chat's fixed row under the scope header, in All projects and in a focused project, selected and
    /// working. A short sidebar shows it staying put above a list that overflows.
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


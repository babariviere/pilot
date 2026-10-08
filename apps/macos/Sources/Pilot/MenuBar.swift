import AppKit
import PilotCore
import SwiftUI

struct MenuBarContent: View {
    private let model: AppModel
    @StateObject private var menu: MenuBarModel
    @Environment(\.openWindow) private var openWindow

    init(model: AppModel) {
        self.model = model
        _menu = StateObject(wrappedValue: MenuBarModel(model: model, updater: .shared))
    }

    var body: some View {
        Text(menu.snapshot.statusText)
        Divider()
        ForEach(menu.snapshot.rows) { row in
            let session = row.session
            Button {
                model.openWindowAction = { openWindow(id: MainWindow.id) }
                model.open(session: session.id)
            } label: {
                Label {
                    Text("\(session.title)\(row.isUnread ? " •" : "")")
                } icon: {
                    SessionStatusIcon(status: session.status)
                }
            }
            .help(session.status.rawValue)
            .accessibilityLabel("\(session.title), \(session.status.rawValue)\(row.isUnread ? ", unread" : "")")
            PullRequestBadge(session: session)
        }
        if !menu.snapshot.rows.isEmpty { Divider() }
        Button("Open Pilot") {
            openWindow(id: MainWindow.id)
            model.showMainWindow()
        }
        .keyboardShortcut("o")
        Divider()
        Button("Restart pilotd") { Task { await model.daemon.restart() } }
            .disabled(menu.snapshot.lifecycleBusy)
        Button("Stop pilotd") { Task { await model.daemon.stop() } }
            .disabled(menu.snapshot.lifecycleBusy)
        Button("Open pilotd Log") { NSWorkspace.shared.open(model.daemon.logURL) }
        Divider()
        Button(menu.snapshot.waitingToInstall ? "Quit Pilot (update waits for idle)" : "Quit Pilot (agents keep running)") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}

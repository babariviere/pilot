import AppKit
import PilotCore
import SwiftUI

/// The menu bar extra: what needs the user at a glance ("1 needs you · 2 working"), chats in the sidebar's urgency
/// order, then Open Pilot, pilotd's controls in their own submenu, and Quit.
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
        ForEach(menu.snapshot.sections) { section in
            Section(section.title) {
                ForEach(section.rows) { row in
                    Button {
                        model.openWindowAction = { openWindow(id: MainWindow.id) }
                        model.open(session: row.session.id)
                    } label: {
                        // A static native image: the animated working spinner would refresh the menu on every
                        // frame, which closes an open submenu (pilotd) before it can be used.
                        Label(row.session.title, menuIcon: row.session.status.icon)
                    }
                    .help(row.signal?.label ?? row.session.status.rawValue)
                    .accessibilityLabel(row.accessibilityLabel)
                }
            }
        }
        Divider()
        Button("Open Pilot") {
            openWindow(id: MainWindow.id)
            model.showMainWindow()
        }
        .keyboardShortcut("o")
        Menu("pilotd") {
            Text(menu.snapshot.daemonText)
            Divider()
            Button("Restart pilotd") { Task { await model.daemon.restart() } }
                .disabled(menu.snapshot.lifecycleBusy)
            Button("Stop pilotd") { Task { await model.daemon.stop() } }
                .disabled(menu.snapshot.lifecycleBusy)
            Button("Open pilotd Log") { NSWorkspace.shared.open(model.daemon.logURL) }
        }
        Divider()
        Button(menu.snapshot.waitingToInstall ? "Quit Pilot (pause agents and update)" : "Quit Pilot (agents keep running)") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}

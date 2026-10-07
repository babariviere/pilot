import AppKit
import PilotCore
import SwiftUI

struct MenuBarContent: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var daemon = AppModel.shared.daemon
    @ObservedObject private var client = AppModel.shared.client
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(statusText)
        Divider()
        ForEach(client.sessions.prefix(8)) { session in
            Button("\(symbol(for: session.state)) \(session.title)") {
                model.openWindowAction = { openWindow(id: MainWindow.id) }
                model.open(session: session.id)
            }
        }
        if !client.sessions.isEmpty { Divider() }
        Button("Open Pilot") {
            openWindow(id: MainWindow.id)
            model.showMainWindow()
        }
        .keyboardShortcut("o")
        Divider()
        Button("Restart pilotd") { Task { await daemon.restart() } }
        Button("Stop pilotd") { Task { await daemon.stop() } }
        Button("Open pilotd Log") { NSWorkspace.shared.open(daemon.logURL) }
        Divider()
        Button("Quit Pilot (agents keep running)") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private var statusText: String {
        switch daemon.status {
        case .running:
            let working = client.workingCount
            return working == 0 ? "pilotd running · idle" : "pilotd running · \(working) working"
        case .starting, .unknown: return "pilotd starting…"
        case .stopped: return "pilotd stopped"
        case .failed: return "pilotd failed"
        }
    }

    private func symbol(for state: String) -> String {
        switch state {
        case "working", "starting": "●"
        case "failed": "✕"
        case "idle": "○"
        default: "·"
        }
    }
}

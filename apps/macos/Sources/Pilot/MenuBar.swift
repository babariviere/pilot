import AppKit
import PilotCore
import SwiftUI

struct MenuBarContent: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var daemon = AppModel.shared.daemon
    @ObservedObject private var client = AppModel.shared.client
    @ObservedObject private var updater = AppUpdater.shared
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(statusText)
        Divider()
        ForEach(client.sessions.prefix(8)) { session in
            Button {
                model.openWindowAction = { openWindow(id: MainWindow.id) }
                model.open(session: session.id)
            } label: {
                Label {
                    Text("\(session.title)\(model.isUnread(session) ? " •" : "")")
                } icon: {
                    Image(systemName: "circle.fill")
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(session.status.color)
                }
            }
            .help(session.status.rawValue)
            .accessibilityLabel("\(session.title), \(session.status.rawValue)\(model.isUnread(session) ? ", unread" : "")")
            PullRequestBadge(session: session)
        }
        if !client.sessions.isEmpty { Divider() }
        Button("Open Pilot") {
            openWindow(id: MainWindow.id)
            model.showMainWindow()
        }
        .keyboardShortcut("o")
        Divider()
        Button("Restart pilotd") { Task { await daemon.restart() } }
            .disabled(daemon.lifecycleBusy)
        Button("Stop pilotd") { Task { await daemon.stop() } }
            .disabled(daemon.lifecycleBusy)
        Button("Open pilotd Log") { NSWorkspace.shared.open(daemon.logURL) }
        Divider()
        Button(updater.waitingToInstall ? "Quit Pilot (update waits for idle)" : "Quit Pilot (agents keep running)") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private var statusText: String {
        switch daemon.status {
        case .running:
            let working = client.workingCount
            let unread = client.sessions.filter { model.isUnread($0) }.count
            let needsInput = client.sessions.filter { $0.status == .needsInput }.count
            var activity: [String] = []
            if working > 0 { activity.append("\(working) working") }
            if needsInput > 0 { activity.append("\(needsInput) need input") }
            if unread > 0 { activity.append("\(unread) unread") }
            return "pilotd running · \(activity.isEmpty ? "idle" : activity.joined(separator: " · "))"
        case .starting, .unknown: return "pilotd starting…"
        case .stopped: return "pilotd stopped"
        case .failed: return "pilotd failed"
        }
    }

}

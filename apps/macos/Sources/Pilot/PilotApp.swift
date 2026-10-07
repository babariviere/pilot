import AppKit
import SwiftUI

@main
struct PilotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel.shared
    @StateObject private var settings = AppSettings.shared
    @StateObject private var updater = AppUpdater.shared

    var body: some Scene {
        Window("Pilot", id: MainWindow.id) {
            MainWindow()
                .environmentObject(model)
                .environment(\.pilotFonts, settings.fonts)
                .frame(minWidth: 860, minHeight: 520)
        }
        .defaultSize(width: 1280, height: 820)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { Task { await updater.check() } }
                    .disabled(!updater.canCheck)
            }
            CommandGroup(replacing: .newItem) {
                Button("New Session") { model.newSession(in: model.draftProjectId) }
                    .keyboardShortcut("n", modifiers: .command)
                Button("Add Project…") { model.addProject() }
                    .keyboardShortcut("o", modifiers: [.command, .shift])
            }
            CommandGroup(after: .toolbar) {
                Button("Toggle Changes") { model.toggleInspector(.changes) }
                    .keyboardShortcut("d", modifiers: [.command, .shift])
                    .disabled(model.selectedSessionId == nil)
                Button("Toggle Terminal") { model.toggleInspector(.terminal) }
                    .keyboardShortcut("j", modifiers: .command)
                    .disabled(model.selectedSessionId == nil)
            }
        }

        Settings {
            SettingsView()
                .environmentObject(model)
        }

        MenuBarExtra {
            MenuBarContent()
                .environmentObject(model)
        } label: {
            MenuBarLabel(client: model.client)
        }
    }
}

private struct MenuBarLabel: View {
    @ObservedObject var client: PilotClient

    var body: some View {
        Image(nsImage: PlaneImage.menuBar(working: client.workingCount > 0))
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Closing the window keeps Pilot in the menu bar. Quitting Pilot never stops pilotd:
    /// the daemon is a launchd agent, so agents keep working with no app running.
    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        false
    }

    func applicationDidFinishLaunching(_: Notification) {
        // Light theme only, for now.
        NSApp.appearance = NSAppearance(named: .aqua)
        if Bundle.main.bundleIdentifier == nil, let icon = PlaneImage.developmentIcon {
            NSApp.applicationIconImage = icon
        }
        Task { @MainActor in
            if Snapshot.runIfRequested() { return }
            AppModel.shared.start()
            AppUpdater.shared.start()
        }
    }

    func applicationShouldTerminate(_: NSApplication) -> NSApplication.TerminateReply {
        AppUpdater.shared.shouldDelayTermination() ? .terminateCancel : .terminateNow
    }
}

import AppKit
import SwiftUI

@main
struct PilotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel.shared
    @StateObject private var settings = AppSettings.shared

    var body: some Scene {
        Window("Pilot", id: MainWindow.id) {
            MainWindow()
                .environmentObject(model)
                .environment(\.pilotFonts, settings.fonts)
                .frame(minWidth: 860, minHeight: 520)
        }
        .defaultSize(width: 1280, height: 820)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Session") { model.newSession(in: model.draftProjectId) }
                    .keyboardShortcut("n", modifiers: .command)
                Button("Add Project…") { model.addProject() }
                    .keyboardShortcut("o", modifiers: [.command, .shift])
            }
            CommandGroup(after: .toolbar) {
                Button(model.terminalVisible ? "Hide Terminal" : "Show Terminal") {
                    model.terminalVisible.toggle()
                }
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
        Image(systemName: client.workingCount > 0 ? "airplane.circle.fill" : "airplane")
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
        Task { @MainActor in
            if Snapshot.runIfRequested() { return }
            AppModel.shared.start()
        }
    }
}

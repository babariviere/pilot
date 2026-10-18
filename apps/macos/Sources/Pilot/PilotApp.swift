import AppKit
import PilotTelemetry
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
                .quietFocus()
                .keyboardCueSource()
                .environmentObject(model)
                .environment(\.openURL, BrowserLinkOpener.action)
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
                Button("New Session") { model.newChatInScope() }
                    .keyboardShortcut("n", modifiers: .command)
                Button("Add Project…") { model.addProject() }
                    .keyboardShortcut("o", modifiers: [.command, .shift])
                Button("Import GitHub Project…") { model.importGitHubProject() }
            }
            CommandGroup(after: .toolbar) {
                Button("Back") { model.goBack() }
                    .keyboardShortcut(.leftArrow, modifiers: .command)
                    .disabled(!model.navigationHistory.canGoBack)
                Button("Forward") { model.goForward() }
                    .keyboardShortcut(.rightArrow, modifiers: .command)
                    .disabled(!model.navigationHistory.canGoForward)
                Divider()
                Button("Toggle Changes") { model.toggleInspector(.changes) }
                    .keyboardShortcut("d", modifiers: [.command, .shift])
                    .disabled(model.selectedSessionId == nil || model.selectedSession?.isAsk == true)
                Button("Toggle Terminal") { model.toggleInspector(.terminal) }
                    .keyboardShortcut("j", modifiers: .command)
                    .disabled(model.selectedSessionId == nil || model.selectedSession?.isAsk == true)
                Button("Toggle Artifacts") { model.toggleInspector(.artifacts) }
                    .disabled(model.selectedSessionId == nil)
                Button("Toggle Links") { model.toggleInspector(.links) }
                    .disabled(model.selectedSessionId == nil)
                Divider()
                Button("Open Latest Pull Request") { model.openLatestPullRequest() }
                    .keyboardShortcut("p", modifiers: [.command, .shift])
                    .disabled(model.selectedSession?.latestPullRequest == nil)
                Button("Merge Latest Pull Request…") { model.mergeLatestPullRequest() }
                    .keyboardShortcut("m", modifiers: [.command, .shift])
                    .disabled(model.latestPullRequestMergeTarget == nil)
                Divider()
                Button("Stop Agent") { model.stopSelectedChat() }
                    .keyboardShortcut(".", modifiers: .command)
                    .disabled(!model.canStopSelectedChat)
            }
            SidebarScopeCommands(model: model, client: model.client)
            KeyboardNavigationCommands(model: model)
            KeyboardShortcutsCommands(model: model)
        }

        Window("Keyboard Shortcuts", id: KeyboardShortcuts.windowID) {
            KeyboardShortcutsView()
                .quietFocus()
                .keyboardCueSource()
                .environment(\.pilotFonts, settings.fonts)
        }
        .windowResizability(.contentSize)

        Settings {
            SettingsView()
                .quietFocus()
                .keyboardCueSource()
                .environmentObject(model)
        }
        .defaultSize(width: 780, height: 580)
        .windowResizability(.contentMinSize)

        MenuBarExtra {
            MenuBarContent(model: model)
                .quietFocus()
        } label: {
            Image(nsImage: PlaneImage.menuBar)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var terminationTask: Task<Void, Never>?
    private var telemetryObservers: [NSObjectProtocol] = []
    private var finishedTermination = false
    /// Closing the window keeps Pilot in the menu bar. Quitting Pilot never stops pilotd:
    /// the daemon is a launchd agent, so agents keep working with no app running.
    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        false
    }

    func applicationDidFinishLaunching(_: Notification) {
        AppSettings.shared.applyAppearance()
        let workspace = NSWorkspace.shared.notificationCenter
        telemetryObservers = [
            workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in
                PilotTelemetry.shared.applicationWillSleep()
            },
            workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
                PilotTelemetry.shared.applicationDidWake()
            },
        ]
        if Bundle.main.bundleIdentifier == nil, let icon = PlaneImage.developmentIcon {
            NSApp.applicationIconImage = icon
        }
        Task { @MainActor in
            if Snapshot.runIfRequested() { return }
            ArtifactInlineCache.enablePersistence()
            AppModel.shared.start()
            AppUpdater.shared.start()
        }
    }

    func applicationShouldTerminate(_: NSApplication) -> NSApplication.TerminateReply {
        AppModel.shared.flushDrafts()
        ArtifactInlineCache.flush()
        if AppUpdater.shared.shouldDelayTermination() { return .terminateCancel }
        if finishedTermination { return .terminateNow }
        if terminationTask == nil {
            terminationTask = Task { @MainActor in
                await AppModel.shared.hosts.disconnectAll()
                await PilotTelemetry.shared.shutdown()
                finishedTermination = true
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }

    func applicationDidResignActive(_: Notification) {
        AppModel.shared.flushDrafts()
    }
}

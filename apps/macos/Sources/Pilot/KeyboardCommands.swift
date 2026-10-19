import AppKit
import PilotCore
import SwiftUI

/// The item a keyboard list highlights. ⌘K labels its actions with it and revalidates it before acting.
enum KeyboardTarget: Equatable {
    case session(id: String, reference: HostResourceRef?)
    case missionTask(missionId: String, taskId: String)
    /// A Linear ticket or Slack message row, named for the palette's label.
    case trackedItem(id: String, title: String, linked: Bool)
}

extension AppModel {
    /// Performs a route the keyboard router reserved. Returns false to deliver the key normally.
    func performKeyboardRoute(_ route: KeyboardRoute) -> Bool {
        switch route {
        case .focusComposer:
            return focusComposer()
        case .commandPalette:
            showCommandPalette()
            return true
        case .toggleTerminal:
            guard canToggleTerminal else { return false }
            toggleInspector(.terminal)
            return true
        case .pass:
            return false
        }
    }

    /// ⌘L: the chat or new-chat composer, or the open question's answers. Nothing happens where there is none.
    @discardableResult
    func focusComposer() -> Bool { !isPreviousControlSelected && keyboard.focus(.composer) }

    var canToggleTerminal: Bool { !isPreviousControlSelected && selectedSessionId != nil && selectedSession?.isAsk != true }

    /// No sheet, confirmation or palette is over the window.
    var hasNoModal: Bool {
        missionSheet == nil && renamingSession == nil && mergingPullRequest == nil && artifactLink == nil
            && !showingCommandPalette && pendingMissionDeletionId == nil
    }

    /// ⌘.: only the open chat, only while its agent works, and never under a dialog.
    var canStopSelectedChat: Bool {
        !isPreviousControlSelected && hasNoModal && selectedSession?.isWorking == true && selectedSession?.isReadOnlyHistory != true
    }

    func stopSelectedChat() {
        guard canStopSelectedChat, let id = selectedSessionId else { return }
        stopSession(id)
    }

    /// Opens the palette already searching, as `/model` does for the composer's model choices.
    func showCommandPalette(query: String) {
        guard !showingCommandPalette else { return }
        pendingPaletteQuery = query
        showCommandPalette()
        if !showingCommandPalette { pendingPaletteQuery = nil }
    }

    /// Shows an inspector pane (never hides it, unlike the toolbar toggle) and moves focus into it.
    @discardableResult
    func openInspector(_ tab: InspectorTab) -> Bool {
        guard !isPreviousControlSelected else { return false }
        guard let session = selectedSession, tab.isAvailable(for: session) else { return false }
        inspectorTab = tab
        inspectorVisible = true
        keyboard.focusAfterNavigation(.inspector)
        return true
    }

    /// The mission on screen: the open mission page, or the open chat's mission.
    var currentMissionId: String? { selectedMissionId ?? selectedSession?.missionId }

    /// The local daemon's global Control chat, once pilotd has created it.
    var controlChat: SessionSummary? { client.sessions.first(where: \.isControl) }

    /// The Go menu or the palette: the local Control chat, with its composer focused. Its sidebar row shows in every
    /// scope, so the scope stays.
    func openControlChat() {
        guard let control = controlChat else { return }
        reveal(session: control.id)
        keyboard.focusAfterNavigation(.composer)
    }

    /// Whether a Go menu destination applies here. Unavailable ones never guess a project or mission.
    func canGo(to destination: GoDestination) -> Bool {
        switch destination {
        case .home, .inbox, .archive, .slack, .linear: true
        case .overview: sidebarScope != nil
        case .mission, .tasks, .brief: currentMissionId != nil
        case .control: controlChat != nil
        }
    }

    func go(to destination: GoDestination) {
        guard canGo(to: destination) else { return }
        switch destination {
        case .home: openHome()
        case .inbox: showInbox()
        case .overview: openOverview()
        case .archive: showArchive(in: focusedProject?.id)
        case .slack: jump(to: .slack)
        case .linear: jump(to: .linear)
        case .control: openControlChat()
        case .mission, .tasks, .brief:
            guard let missionId = currentMissionId else { return }
            let tab: MissionTab = destination == .tasks ? .tasks : destination == .brief ? .brief : .overview
            let context = selectedMissionId == nil ? hosts.selection.map { HostViewContext(host: $0.host, hosts: hosts) } : nil
            openMission(missionId, tab: tab, context: context)
        }
    }

    /// The highlighted chat, when it still exists and is not archived away from its actions.
    var keyboardTargetSession: (session: SessionSummary, reference: HostResourceRef?)? {
        guard case let .session(id, reference) = keyboardTarget else { return nil }
        if let reference, reference.host != localHost {
            return hosts.sessions.first { $0.ref == reference }.map { ($0.value, reference) }
        }
        return client.session(id).map { ($0, nil) }
    }
}

/// The Go menu: history, region focus and destinations. Region keys are also read before embedded content (see
/// `KeyboardRouter`). Destinations have no key of their own; the menu and ⌘K reach them.
struct KeyboardNavigationCommands: Commands {
    @ObservedObject var model: AppModel

    var body: some Commands {
        CommandMenu("Go") {
            // The same history as ⌘← and ⌘→ in the View menu, on keys that text fields don't use for moving the caret.
            Button("Back") { model.goBack() }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(!model.navigationHistory.canGoBack)
            Button("Forward") { model.goForward() }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(!model.navigationHistory.canGoForward)
            Divider()
            Button("Focus Composer") { model.focusComposer() }
                .keyboardShortcut("l", modifiers: .command)
            Divider()
            ForEach(GoDestination.allCases, id: \.self) { destination in
                Button(destination.menuTitle) { model.go(to: destination) }
                    .disabled(!model.canGo(to: destination))
            }
        }
    }
}

extension GoDestination {
    var menuTitle: String {
        switch self {
        case .home: "Home"
        case .inbox: "Inbox"
        case .overview: "Project Overview"
        case .mission: "Mission Overview"
        case .tasks: "Mission Tasks"
        case .brief: "Mission Brief"
        case .archive: "Archive"
        case .slack: "Slack Triage"
        case .linear: "Linear Queue"
        case .control: "Control Chat"
        }
    }
}

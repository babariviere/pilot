import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func trackedRowRequestsRunOnceForTheirRow() {
    let requests = TrackedItemRequests()
    requests.send(.startChat, to: "a")
    #expect(requests.take(requests.latest, for: "b") == nil)
    #expect(requests.take(requests.latest, for: "a") == .startChat)
    #expect(requests.take(requests.latest, for: "a") == nil, "a row realized later never replays it")
}

@Test @MainActor func highlightedTicketsOfferStartWithoutTheContextMenu() throws {
    let model = AppModel(projectFolderDefaults: UserDefaults(suiteName: "tracked-keys-\(UUID())")!)
    let catalog = CommandPaletteCatalog(model: model, openSettings: {}, openKeyboardShortcuts: {})
    model.keyboardTarget = .trackedItem(id: "t1", title: "ENG-1 Fix export", linked: false)
    let target = try #require(catalog.targetActions())
    #expect(target.title == "Highlighted: ENG-1 Fix export")
    #expect(target.entries.map(\.item.title) == ["Start chat", "Start mission…", "Dismiss or restore"])
    try #require(target.entries.first).perform()
    #expect(model.trackedItemRequests.latest?.itemId == "t1")
    #expect(model.trackedItemRequests.latest?.command == .startChat, "it opens the prefilled form; nothing is sent")
    model.keyboardTarget = .trackedItem(id: "t2", title: "Linked", linked: true)
    #expect(try #require(catalog.targetActions()).entries.first?.item.title == "Open linked chat or mission")
}

@Test @MainActor func aBoardSelectionGetsALabeledActionGroupWhenNoRowIsHighlighted() throws {
    _ = NSApplication.shared
    var dismissed = 0
    let view = Text("Board").selectionCommands(revision: 1) {
        ("Login fails", [ComposerCommand(id: "dismiss", title: "Dismiss", icon: .dismiss) { dismissed += 1 }])
    }
    let hosting = NSHostingView(rootView: view)
    hosting.frame = NSRect(x: 0, y: 0, width: 200, height: 40)
    let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    defer {
        window.contentView = nil
        window.close()
    }
    for _ in 0..<20 where AppModel.shared.keyboard.selectionCommands?.title != "Login fails" {
        hosting.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    // Views register with the app's model, so its palette reads the selection.
    let shared = CommandPaletteCatalog(model: AppModel.shared, openSettings: {}, openKeyboardShortcuts: {})
    let previous = AppModel.shared.keyboardTarget
    AppModel.shared.keyboardTarget = nil
    defer { AppModel.shared.keyboardTarget = previous }
    let target = try #require(shared.targetActions())
    #expect(target.title == "Selected: Login fails")
    try #require(target.entries.first).perform()
    #expect(dismissed == 1)
}

@Test @MainActor func trayAndSchedulingCommandsNeedNoPointer() {
    var opened = 0
    let command = ComposerCommandText.sendLaterAtTime { opened += 1 }
    #expect(command.title == "Send later: At a time…")
    command.perform()
    #expect(opened == 1, "opens the composer's own date sheet, which still asks to confirm")
}

/// Native controls inside Settings and dialogs are Tab stops only with macOS Keyboard navigation on. That is platform
/// behavior, so the reference says so instead of Pilot replacing native controls.
@Test func theReferenceDocumentsWhenNativeControlsNeedKeyboardNavigation() {
    let entries = KeyboardShortcuts.groups.flatMap(\.entries)
    let entry = entries.first { $0.title.hasPrefix("Reach toggles, pickers and buttons") }
    #expect(entry?.keys == "⇥ with Keyboard navigation on")
    #expect(KeyboardShortcuts.filtered("keyboard navigation").flatMap(\.entries).contains { $0.title == entry?.title })
}

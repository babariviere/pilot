import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test func keyboardShortcutsReferenceHasStableGroupsAndCommonActions() {
    let groups = KeyboardShortcuts.groups
    #expect(Set(groups.map(\.id)).count == groups.count)
    let entries = groups.flatMap(\.entries)
    #expect(Set(entries.map(\.id)).count == entries.count)
    #expect(entries.allSatisfy { !$0.title.isEmpty && !$0.keys.isEmpty })
    let keys = Dictionary(uniqueKeysWithValues: entries.map { ($0.title, $0.keys) })
    #expect(keys["Show keyboard shortcuts"] == KeyboardShortcuts.hint)
    #expect(keys["Open command palette"] == "⌘K")
    #expect(keys["Queue a follow-up"] == "⌥↩")
    #expect(keys["Toggle terminal"] == "⌘J")
    #expect(KeyboardShortcuts.key.character == "?")
    #expect(KeyboardShortcuts.modifiers == .command)
}

@Test @MainActor func keyboardShortcutsCanBeFoundAndOpenedFromThePaletteWithoutAProject() throws {
    let defaults = UserDefaults(suiteName: "shortcuts-palette-\(UUID().uuidString)")!
    let model = AppModel(projectFolderDefaults: defaults)
    var opened = 0
    let catalog = CommandPaletteCatalog(model: model, openSettings: {}, openKeyboardShortcuts: { opened += 1 })
    let entries = catalog.entries()
    let shortcut = try #require(entries.first { $0.item.id == "page:shortcuts" })
    #expect(shortcut.shortcut == KeyboardShortcuts.hint)
    for query in ["shortcuts", "keyboard", "help", "hotkeys"] {
        let results = CommandPalette.results(for: query, items: entries.map(\.item))
        #expect(results.flatMap(\.items).contains { $0.id == shortcut.item.id })
    }
    #expect(opened == 0)
    shortcut.perform()
    #expect(opened == 1)
}

@Test @MainActor func keyboardShortcutsReferenceKeepsABoundedWindowInBothAppearances() throws {
    for scheme in [ColorScheme.light, .dark] {
        let renderer = ImageRenderer(content: KeyboardShortcutsView().environment(\.colorScheme, scheme))
        let image = try #require(renderer.cgImage)
        #expect(image.width == 540)
        #expect(image.height == 620)
    }
}

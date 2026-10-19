import Foundation
import PilotCore
import Testing
@testable import Pilot

@MainActor
private func model() -> AppModel {
    let model = AppModel(projectFolderDefaults: UserDefaults(suiteName: "palette-first-\(UUID())")!)
    let project = Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)
    model.client.loadFixture(projects: [project], sessions: (0..<8).map { index in
        SessionSummary(id: "c\(index)", title: "Chat \(index)", cwd: "/tmp", projectId: "p1", createdAt: 1,
                       updatedAt: Double(10 - index), state: "idle")
    })
    return model
}

@Test @MainActor func emptyPaletteLeadsWithPagesAndKeepsFewRecentChats() {
    let model = model()
    let catalog = CommandPaletteCatalog(model: model, openSettings: {}, openKeyboardShortcuts: {})
    let sections = CommandPalette.results(for: "", items: catalog.entries().map(\.item))
    #expect(sections.first?.title == "Pages")
    let recent = sections.first { $0.title == "Recent chats" }
    #expect(recent?.items.count == CommandPaletteCatalog.recentChats)
    #expect(CommandPaletteCatalog.recentChats <= 3)
    let titles = sections.map(\.title)
    if let pages = titles.firstIndex(of: "Pages"), let chats = titles.firstIndex(of: "Recent chats") {
        #expect(pages < chats)
    }
}

@Test @MainActor func shortcutHelpIsSearchableFromThePaletteAndTheReference() throws {
    let model = model()
    var opened = 0
    let catalog = CommandPaletteCatalog(model: model, openSettings: {}, openKeyboardShortcuts: { opened += 1 })
    let entries = catalog.entries()
    let found = CommandPalette.results(for: "queue follow", items: entries.map(\.item)).flatMap(\.items)
    let help = try #require(found.first { $0.id.hasPrefix("help:") })
    #expect(help.title == "Queue a follow-up")
    try #require(entries.first { $0.item.id == help.id }).perform()
    #expect(opened == 1)
    #expect(KeyboardShortcuts.filtered("").count == KeyboardShortcuts.groups.count)
    let filtered = KeyboardShortcuts.filtered("composer")
    #expect(filtered.flatMap(\.entries).map(\.title).contains("Focus composer or question"))
    #expect(KeyboardShortcuts.filtered("⌘L").flatMap(\.entries).contains { $0.keys == "⌘L" })
    #expect(KeyboardShortcuts.filtered("zzzz").isEmpty)
}

@MainActor
private func modelWithControl() -> AppModel {
    let model = model()
    var control = SessionSummary(id: "ctl", title: "Control", cwd: "", createdAt: 1, updatedAt: 0, state: "idle",
                                 mode: .ask, pinned: true)
    control.control = true
    model.client.loadFixture(projects: model.client.projects, sessions: model.client.sessions + [control])
    return model
}

@Test @MainActor func controlChatIsAlwaysSuggestedWithThePagesNotTheRecentChats() throws {
    let model = modelWithControl()
    let catalog = CommandPaletteCatalog(model: model, openSettings: {}, openKeyboardShortcuts: {})
    let entries = catalog.entries()
    let control = try #require(entries.first { $0.session?.isControl == true })
    #expect(control.item.kind == .page)
    #expect(control.item.suggested)
    #expect(control.icon == .controlChat)
    #expect(control.shortcut == nil, "the Control chat has no letter sequence; the Go menu and palette reach it")
    #expect(entries.filter { $0.session?.isControl == true }.count == 1)

    let sections = CommandPalette.results(for: "", items: entries.map(\.item))
    let pages = try #require(sections.first { $0.title == "Pages" })
    #expect(pages.items.prefix(3).map(\.id).contains(control.item.id))
    // It is the oldest chat, yet it shows, and the recent chats keep all their places.
    let recent = try #require(sections.first { $0.title == "Recent chats" })
    #expect(recent.items.count == CommandPaletteCatalog.recentChats)
    #expect(!recent.items.contains { $0.id == control.item.id })

    for query in ["control", "pilot"] {
        let found = CommandPalette.results(for: query, items: entries.map(\.item)).flatMap(\.items)
        #expect(found.contains { $0.id == control.item.id }, "\(query)")
    }
}

@Test @MainActor func paletteHasNoControlEntryWithoutTheControlChat() {
    let model = model()
    let catalog = CommandPaletteCatalog(model: model, openSettings: {}, openKeyboardShortcuts: {})
    #expect(!catalog.entries().contains { $0.icon == .controlChat })
    #expect(!model.canGo(to: .control))
}

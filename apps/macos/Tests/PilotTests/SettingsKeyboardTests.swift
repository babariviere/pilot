import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test func settingsPagesMoveInSidebarOrderAndStopAtTheEnds() {
    let projects = [Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1),
                    Project(id: "p2", name: "dotfiles", path: "/tmp/dotfiles", createdAt: 1)]
    let order = SettingsTab.ordered(projects: projects)
    #expect(order.first == .appearance)
    #expect(order.suffix(2) == [.project("p1"), .project("p2")])
    #expect(SettingsTab.moving(from: .appearance, by: -1, in: order) == .appearance)
    #expect(SettingsTab.moving(from: .appearance, by: 1, in: order) == .notifications)
    #expect(SettingsTab.moving(from: .devboxes, by: 1, in: order) == .project("p1"), "general pages lead into projects")
    #expect(SettingsTab.moving(from: .project("p2"), by: 1, in: order) == .project("p2"))
    #expect(SettingsTab.moving(from: .project("gone"), by: 1, in: order) == .appearance, "a removed project falls back")
}

@Test @MainActor func everySettingsPageIsReachableFromThePalette() throws {
    let model = AppModel(projectFolderDefaults: UserDefaults(suiteName: "settings-keys-\(UUID())")!)
    model.client.loadFixture(projects: [Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)], sessions: [])
    var opened = 0
    let catalog = CommandPaletteCatalog(model: model, openSettings: { opened += 1 }, openKeyboardShortcuts: {})
    let entries = catalog.entries()
    for tab in SettingsTab.general {
        let entry = try #require(entries.first { $0.item.title == "\(tab.title) settings" })
        entry.perform()
        #expect(model.settingsTab == tab)
    }
    let project = try #require(entries.first { $0.item.id == "page:settings:project:p1" })
    project.perform()
    #expect(model.settingsTab == .project("p1"))
    #expect(opened == SettingsTab.general.count + 1)
    let found = CommandPalette.results(for: "energy", items: entries.map(\.item)).flatMap(\.items)
    #expect(found.contains { $0.title == "Energy settings" })
}

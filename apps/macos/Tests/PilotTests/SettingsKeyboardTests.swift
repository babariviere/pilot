import AppKit
import PilotCore
import SwiftUI
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

@Test(arguments: [0, 1, 2, 3], [ColorScheme.light, .dark])
@MainActor func settingsNavigationDrawsOneRingOnlyWhileItsParentIsFocused(selection: Int, scheme: ColorScheme) throws {
    let titles = ["Appearance", "Notifications", "pilot", "dotfiles"]
    func render(focused: Bool) throws -> NSBitmapImageRep {
        let renderer = ImageRenderer(content: VStack(spacing: 1) {
            ForEach(titles.indices, id: \.self) { index in
                SidebarNavRow(title: titles[index], icon: index < 2 ? .appearance : .project,
                              selected: selection == index, parentFocused: focused, action: {}) {
                    EmptyView()
                }
            }
        }
        .padding(10)
        .frame(width: 210)
        .background(Theme.sidebar)
        .environment(\.colorScheme, scheme))
        return NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
    }

    let quiet = try render(focused: false)
    let focused = try render(focused: true)
    #expect(quiet.pixelsWide == focused.pixelsWide)
    #expect(quiet.pixelsHigh == focused.pixelsHigh)
    for index in titles.indices {
        var changed = 0
        // Sample each row's sides, clear of neighbouring rings' vertical outsets.
        for y in (13 + index * 29)..<(35 + index * 29) {
            for x in 0..<quiet.pixelsWide {
                if quiet.colorAt(x: x, y: y) != focused.colorAt(x: x, y: y) { changed += 1 }
            }
        }
        if index == selection {
            #expect(changed > 100, "the selected row needs a visible keyboard focus ring")
        } else {
            #expect(changed == 0, "unselected rows must not inherit their parent's focus ring")
        }
    }
}

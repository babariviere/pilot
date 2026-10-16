import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func taskStatusMenusListEveryStatusAsText() throws {
    guard #available(macOS 14.4, *) else { return }
    _ = NSApplication.shared
    for selected in MissionTaskStatus.allCases {
        let content = MissionTaskStatusMenuItems(selected: selected) { _ in }
        let inline = NSHostingMenu(rootView: content)
        inline.update()
        let contextual = NSHostingMenu(rootView: Menu("Status") { content })
        contextual.update()
        let parent = try #require(contextual.items.first)
        let submenu = try #require(parent.submenu)
        submenu.update()
        for menu in [inline as NSMenu, submenu] {
            #expect(menu.items.map(\.title) == MissionTaskStatus.allCases.map(\.label))
            for (item, status) in zip(menu.items, MissionTaskStatus.allCases) {
                #expect(item.image == nil, "Unexpected menu icon for \(status.label)")
                #expect(item.isEnabled == (status != selected))
            }
        }
    }
}

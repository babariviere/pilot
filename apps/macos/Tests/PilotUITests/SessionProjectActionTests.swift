import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test(arguments: [false, true]) @MainActor
func chatProjectMenuOpensOverviewWithoutChangingScope(archived: Bool) throws {
    guard #available(macOS 14.4, *) else { return }
    _ = NSApplication.shared
    let model = AppModel()
    let project = Project(id: "project", name: "Project", path: "/repository", createdAt: 1)
    let chat = SessionSummary(id: "chat", title: "Chat", cwd: "/repository",
                              projectId: project.id, createdAt: 1, updatedAt: 1, state: "idle",
                              archivedAt: archived ? 2 : nil)
    model.client.loadFixture(projects: [project], sessions: [chat])
    model.selectedSessionId = chat.id
    let scope = model.sidebarScope
    let menu = NSHostingMenu(rootView: SessionProjectAction(session: chat).environmentObject(model))
    menu.update()
    #expect(menu.items.map(\.title) == ["Go to project"])
    let item = try #require(menu.items.first)
    let action = try #require(item.action)
    let target = try #require(item.target)
    #expect(NSApp.sendAction(action, to: target, from: item))
    #expect(model.selectedProjectId == project.id)
    #expect(model.selectedSessionId == nil)
    #expect(model.sidebarScope == scope)
}

@Test(arguments: [nil, "removed-project"] as [String?]) @MainActor
func chatProjectMenuIsAbsentWithoutAnAvailableProject(projectId: String?) {
    guard #available(macOS 14.4, *) else { return }
    _ = NSApplication.shared
    let model = AppModel()
    model.client.loadFixture(projects: [], sessions: [])
    let chat = SessionSummary(id: "chat", title: "Chat", cwd: "/repository",
                              projectId: projectId, createdAt: 1, updatedAt: 1, state: "idle")
    let menu = NSHostingMenu(rootView: SessionProjectAction(session: chat).environmentObject(model))
    menu.update()
    #expect(menu.items.isEmpty)
}

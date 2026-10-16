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
    let local = HostRef(hostId: "local", daemonId: "daemon", lineageId: "lineage")
    try model.registerLocal(local)
    let project = Project(id: "project", name: "Project", path: "/repository", createdAt: 1)
    let chat = SessionSummary(id: "chat", title: "Chat", cwd: "/repository",
                              projectId: project.id, createdAt: 1, updatedAt: 1, state: "idle",
                              archivedAt: archived ? 2 : nil)
    model.client.loadFixture(projects: [project], sessions: [chat])
    try model.hosts.install(model.client, host: local)
    model.selectedSessionId = chat.id
    let scope = model.sidebarScope
    let menu = NSHostingMenu(rootView: SessionProjectAction(session: chat).environmentObject(model)
        .environment(\.hostViewContext, HostViewContext(host: local, hosts: model.hosts)))
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
func chatProjectMenuIsAbsentWithoutAnAvailableProject(projectId: String?) throws {
    guard #available(macOS 14.4, *) else { return }
    _ = NSApplication.shared
    let model = AppModel()
    model.client.loadFixture(projects: [], sessions: [])
    let local = HostRef(hostId: "local", daemonId: "fixture-daemon", lineageId: "fixture-history")
    try model.registerLocal(local)
    try model.hosts.install(model.client, host: local)
    let chat = SessionSummary(id: "chat", title: "Chat", cwd: "/repository",
                              projectId: projectId, createdAt: 1, updatedAt: 1, state: "idle")
    let menu = NSHostingMenu(rootView: SessionProjectAction(session: chat).environmentObject(model)
        .environment(\.hostViewContext, HostViewContext(host: local, hosts: model.hosts)))
    menu.update()
    #expect(menu.items.isEmpty)
}

import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func sidebarFolderMutationsPersistWithoutChangingProjectsOrSessions() throws {
    let suite = "SidebarFolderTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let app = AppModel(projectFolderDefaults: defaults)
    let project = Project(id: "project", name: "Repository", path: "/projects/repository", createdAt: 1)
    let session = SessionSummary(id: "session", title: "Task", cwd: "/workspace", projectId: project.id,
                                 createdAt: 1, updatedAt: 2, state: "idle")
    app.client.loadFixture(projects: [project], sessions: [session])
    app.selectedSessionId = session.id

    let created = app.projectFolders.create(name: "Work")
    let folder = try #require(created)
    app.projectFolders.move(projectId: project.id, to: folder.id)
    app.projectFolders.setExpanded(false, folderId: folder.id)
    app.projectFolders.rename(folder.id, name: "Office")
    let reopened = AppModel(projectFolderDefaults: defaults)
    #expect(reopened.projectFolders == app.projectFolders)
    #expect(reopened.projectFolders.folders.first?.name == "Office")
    #expect(reopened.projectFolders.folderId(for: project.id) == folder.id)
    #expect(reopened.projectFolders.collapsed.contains(folder.id))

    app.projectFolders.remove(folder.id)
    #expect(AppModel(projectFolderDefaults: defaults).projectFolders == ProjectFolders())
    #expect(app.client.projects == [project])
    #expect(app.client.sessions == [session])
    #expect(app.selectedSessionId == session.id)
}

@Test @MainActor func sidebarFolderEditorRejectsBlanksAndResetsBetweenActions() {
    let editor = ProjectFolderEditorState()
    editor.begin(projectId: "project")
    #expect(editor.presented)
    #expect(editor.folderId == nil)
    #expect(editor.projectId == "project")
    #expect(!editor.valid)
    editor.name = " \n\t "
    #expect(!editor.valid)
    editor.name = " Work "
    #expect(editor.valid)

    editor.begin(ProjectFolder(id: "folder", name: "Personal"))
    #expect(editor.folderId == "folder")
    #expect(editor.projectId == nil)
    #expect(editor.name == "Personal")
    #expect(editor.valid)

    editor.begin()
    #expect(editor.folderId == nil)
    #expect(editor.projectId == nil)
    #expect(editor.name.isEmpty)
    #expect(!editor.valid)
}

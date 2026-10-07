import PilotCore
import Testing
@testable import Pilot

private func debugSource(path: String? = "/custom/pilot/sessions/source", archived: Bool = false) -> SessionSummary {
    SessionSummary(id: "source", title: "Broken tool call", cwd: "/projects/unrelated", projectId: "other",
                   createdAt: 1, updatedAt: 2, state: "failed", archivedAt: archived ? 3 : nil, sessionPath: path)
}

private let pilotProject = Project(id: "pilot", name: "Pilot", path: "/projects/pilot", createdAt: 1)
private let otherProject = Project(id: "other", name: "Other", path: "/projects/unrelated", createdAt: 1)

@Test @MainActor func debugSessionPrefillsPilotWithoutStartingWork() {
    let app = AppModel()
    let source = debugSource(archived: true)
    app.client.loadFixture(projects: [otherProject, pilotProject], sessions: [source])
    app.selectedSessionId = source.id
    app.showingArchive = true
    app.debugSession(source)

    #expect(app.selectedSessionId == nil)
    #expect(!app.showingArchive)
    #expect(app.draftProjectId == pilotProject.id)
    #expect(app.draftMessage?.contains("Session ID: source") == true)
    #expect(app.draftMessage?.contains("Session data path: /custom/pilot/sessions/source") == true)
    #expect(app.draftMessage?.contains("Session working directory: /projects/unrelated") == true)
    #expect(app.draftMessage?.contains("Issue / reason:") == true)
    #expect(app.sessionActionError == nil)
    #expect(app.client.sessions == [source])
}

@Test @MainActor func debugSessionReportsMissingOrAmbiguousPilotProject() {
    let app = AppModel()
    let source = debugSource()
    app.client.loadFixture(projects: [otherProject], sessions: [source])
    app.selectedSessionId = source.id
    app.debugSession(source)
    #expect(app.selectedSessionId == source.id)
    #expect(app.draftMessage == nil)
    #expect(app.sessionActionError?.contains("Add a project named pilot") == true)

    let duplicate = Project(id: "duplicate", name: "pilot", path: "/another/pilot", createdAt: 1)
    app.client.loadFixture(projects: [pilotProject, duplicate], sessions: [source])
    app.debugSession(source)
    #expect(app.selectedSessionId == source.id)
    #expect(app.draftMessage == nil)
    #expect(app.sessionActionError?.contains("More than one") == true)
}

@Test @MainActor func debugSessionDoesNotGuessDataPathFromWorkingDirectory() {
    let app = AppModel()
    let source = debugSource(path: nil)
    app.client.loadFixture(projects: [pilotProject], sessions: [source])
    app.selectedSessionId = source.id
    app.debugSession(source)
    #expect(app.selectedSessionId == source.id)
    #expect(app.draftMessage == nil)
    #expect(app.sessionActionError?.contains("data path") == true)
}

@Test @MainActor func newSessionPrefillIsConsumedOnceWithoutErasingOrdinaryDrafts() {
    let app = AppModel()
    let form = NewSessionForm()
    form.folder = "/wrong/folder"
    form.model = "previous/model"
    form.tab = .running
    form.error = "Old error"
    app.newSession(in: pilotProject.id, message: "Debug this session")
    form.consumeDraft(from: app)
    #expect(form.message == "Debug this session")
    #expect(form.folder.isEmpty)
    #expect(form.model.isEmpty)
    #expect(form.tab == .newTask)
    #expect(form.error == nil)
    #expect(app.draftMessage == nil)

    form.message += " because the tool failed"
    form.consumeDraft(from: app)
    #expect(form.message == "Debug this session because the tool failed")
    app.newSession(in: otherProject.id)
    form.consumeDraft(from: app)
    #expect(form.message == "Debug this session because the tool failed")
    #expect(app.draftMessage == nil)

    // Navigating away before the prefill mounts must not leak it into an ordinary task.
    app.newSession(in: pilotProject.id, message: "Stale prefill")
    app.newSession(in: otherProject.id)
    #expect(app.draftMessage == nil)
}

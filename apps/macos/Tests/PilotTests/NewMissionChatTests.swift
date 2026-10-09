import Foundation
import PilotCore
import Testing
@testable import Pilot

private let project = Project(id: "p", name: "Code", path: "/tmp/code", workspace: "direct", createdAt: 1)
private let mission = Mission(id: "m", projectId: "p", title: "Redesign", goal: "Ship it", createdAt: 1, updatedAt: 1)

@Test @MainActor func newMissionChatOpensEmptyComposerWithLockedProjectAndNoTask() throws {
    let app = AppModel()
    app.client.loadFixture(projects: [project], sessions: [])
    app.selectedMissionId = mission.id
    app.newSessionForm.message = "Old draft"
    app.newSessionForm.folder = "/tmp/other"
    app.newSessionForm.mode = .ask
    app.newSessionForm.workspace = .clone
    app.newSessionForm.pendingBaseBranch = "old"
    let previous = app.newSessionForm.revision
    app.newSession(in: mission)
    let form = app.newSessionForm
    form.consumeDraft(from: app) // Mounting the composer preserves the selected mission.
    #expect(app.selectedMissionId == nil && app.selectedSessionId == nil)
    #expect(app.draftProjectId == project.id)
    #expect(form.mission == mission && form.folder.isEmpty && form.message.isEmpty)
    #expect(form.mode == .build && form.workspace == nil && form.pendingBaseBranch == nil)
    #expect(form.revision != previous)
    #expect(!form.completeSubmission(revision: previous))
    #expect(!form.canStart(in: project))
    form.message = "Tackle tasks 1 to 5"
    #expect(form.canStart(in: project))
    #expect(!form.canStart(in: nil)) // Never fall back to another project or folder.
    let other = Project(id: "other", name: "Other", path: "/tmp/other", createdAt: 1)
    #expect(!form.canStart(in: other))
    let request = form.spawnRequest(in: project)
    let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
    #expect(json["missionId"] as? String == mission.id)
    #expect(json["projectId"] as? String == project.id)
    #expect(json["message"] as? String == form.message)
    #expect(json["cwd"] == nil && json["taskId"] == nil)
    form.chooseMode(.ask)
    #expect(form.spawnRequest(in: project).missionId == mission.id)
    #expect(form.spawnRequest(in: project).mode == .ask)
    let decoded = try JSONDecoder().decode(SpawnRequest.self, from: JSONEncoder().encode(request))
    #expect(decoded.missionId == mission.id)
    #expect(form.completeSubmission(revision: form.revision))
    #expect(form.mission == nil)
}

@Test @MainActor func dedicatedChatDraftRetainsMissionAcrossNavigationAndRestart() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("mission-draft-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let app = AppModel(draftStore: DraftStore(directory: root))
    app.newSession(in: mission)
    app.newSessionForm.message = "Work through the open tasks"
    app.selectedSessionId = "another"
    app.newSession(in: nil)
    app.newSessionForm.consumeDraft(from: app)
    #expect(app.newSessionForm.mission == mission)
    app.flushDrafts()
    let restored = AppModel(draftStore: DraftStore(directory: root))
    restored.newSessionForm.consumeDraft(from: restored)
    #expect(restored.newSessionForm.mission == mission)
    #expect(restored.newSessionForm.message == app.newSessionForm.message)
    #expect(restored.newSessionForm.spawnRequest(in: project).missionId == mission.id)
}

@Test @MainActor func ordinaryNewChatClearsMissionAndInactiveMissionCannotOpenComposer() {
    let app = AppModel()
    app.newSession(in: mission)
    app.newSession(in: project.id)
    #expect(app.newSessionForm.mission == nil)
    app.selectedMissionId = "done"
    let done = Mission(id: "done", projectId: "p", title: "Done", goal: "", status: .done, createdAt: 1, updatedAt: 1)
    app.newSession(in: done)
    #expect(app.selectedMissionId == done.id)
    #expect(app.newSessionForm.mission == nil)
}

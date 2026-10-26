import Foundation
import PilotCore
import Testing
@testable import Pilot

private let attachmentProject = Project(id: "p", name: "Code", path: "/tmp/code", workspace: "direct", createdAt: 1)
private let attachmentMission = Mission(id: "m", projectId: "p", title: "Improve chat", goal: "Polish", createdAt: 1, updatedAt: 1)

@Test @MainActor func removingMissionAttachmentPreservesDraftAndPersistsRemoval() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("mission-draft-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let app = AppModel(draftStore: DraftStore(directory: root))
    app.newSession(in: attachmentMission)
    let form = app.newSessionForm
    form.message = "Keep my draft 私 👩‍💻"
    form.model = "provider/model"
    form.mode = .ask
    let revision = form.revision
    #expect(form.removeMissionAttachment(pendingCreate: false))
    #expect(form.mission == nil)
    #expect(form.message == "Keep my draft 私 👩‍💻")
    #expect(form.model == "provider/model" && form.mode == .ask)
    #expect(form.revision == revision)
    #expect(app.draftProjectId == attachmentProject.id)
    #expect(form.canChooseExecutionHost)
    #expect(form.spawnRequest(in: attachmentProject).missionId == nil)
    #expect(form.spawnRequest(in: attachmentProject).projectId == attachmentProject.id)
    app.flushDrafts()
    let restored = AppModel(draftStore: DraftStore(directory: root))
    #expect(restored.newSessionForm.mission == nil)
    #expect(restored.newSessionForm.message == form.message)
    #expect(restored.draftProjectId == attachmentProject.id)
}

@Test @MainActor func removingMissionAttachmentCannotRetargetAnAdmittedStart() {
    let form = NewSessionForm()
    form.mission = attachmentMission
    form.message = "Frozen draft"
    form.busy = true
    #expect(!form.removeMissionAttachment(pendingCreate: false))
    form.busy = false
    form.pendingOperationId = "uncertain-start"
    #expect(!form.removeMissionAttachment(pendingCreate: false))
    form.pendingOperationId = nil
    #expect(!form.removeMissionAttachment(pendingCreate: true))
    #expect(form.mission?.id == attachmentMission.id)
    #expect(form.spawnRequest(in: attachmentProject).missionId == attachmentMission.id)
    #expect(form.message == "Frozen draft")
}

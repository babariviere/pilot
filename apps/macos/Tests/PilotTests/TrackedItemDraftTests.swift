import Foundation
import PilotCore
import Testing
@testable import Pilot

private let project = Project(id: "p", name: "Code", path: "/tmp/code", workspace: "direct", createdAt: 1)
private let ticket = TrackedItemBinding(itemId: "item-1", projectId: "p", label: "ENG-123")

private func draftRoot() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("tracked-draft-\(UUID())")
}

@MainActor private func ticketDraft(_ app: AppModel) {
    app.newSession(in: project.id, message: "Fix ENG-123")
    app.newSessionForm.consumeDraft(from: app)
    app.newSessionForm.trackedItem = ticket
}

@Test @MainActor func trackedTicketDraftSurvivesRestart() throws {
    let root = draftRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let app = AppModel(draftStore: DraftStore(directory: root))
    ticketDraft(app)
    app.flushDrafts()

    let restored = AppModel(draftStore: DraftStore(directory: root))
    restored.newSessionForm.consumeDraft(from: restored)
    #expect(restored.newSessionForm.trackedItem == ticket)
    #expect(restored.newSessionForm.message == "Fix ENG-123")
    #expect(restored.newSessionForm.hasUnsubmittedDraft)
    // The restored ticket still locks the project.
    let other = Project(id: "other", name: "Other", path: "/tmp/other", workspace: "direct", createdAt: 1)
    #expect(restored.newSessionForm.canStart(in: project))
    #expect(!restored.newSessionForm.canStart(in: other))
}

@Test @MainActor func changingTrackedTicketSavesTheDraft() throws {
    let root = draftRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let app = AppModel(draftStore: DraftStore(directory: root))
    ticketDraft(app)
    app.flushDrafts()
    // Only the ticket changes, so the new snapshot comes from observing it.
    app.newSessionForm.trackedItem = nil
    app.flushDrafts()
    #expect(try DraftStore(directory: root).load().newTask.trackedItem == nil)
    app.newSessionForm.trackedItem = ticket
    app.flushDrafts()
    #expect(try DraftStore(directory: root).load().newTask.trackedItem == ticket)
}

@Test @MainActor func legacyDraftWithoutTrackedTicketDecodesWithoutOne() throws {
    let root = draftRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let legacy = """
    {"version":1,"chats":{},"newTask":{"message":"Old draft","attachments":[],"folder":"","model":"","runningTab":false}}
    """
    try Data(legacy.utf8).write(to: root.appendingPathComponent("drafts.json"))

    let drafts = try DraftStore(directory: root).load()
    #expect(drafts.newTask.trackedItem == nil)
    #expect(drafts.newTask.message == "Old draft")
    let app = AppModel(draftStore: DraftStore(directory: root))
    #expect(app.newSessionForm.trackedItem == nil)
    #expect(app.newSessionForm.message == "Old draft")
}

@Test @MainActor func submittingOrResettingClearsThePersistedTicket() throws {
    let root = draftRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let app = AppModel(draftStore: DraftStore(directory: root))
    ticketDraft(app)
    #expect(app.newSessionForm.completeSubmission(revision: app.newSessionForm.revision))
    #expect(app.newSessionForm.trackedItem == nil)
    app.flushDrafts()
    #expect(AppModel(draftStore: DraftStore(directory: root)).newSessionForm.trackedItem == nil)

    ticketDraft(app)
    app.newSessionForm.resetChatContext()
    #expect(app.newSessionForm.trackedItem == nil)
    app.flushDrafts()
    #expect(AppModel(draftStore: DraftStore(directory: root)).newSessionForm.trackedItem == nil)
}

@Test @MainActor func scheduledChatCarriesTheTrackedTicket() throws {
    let form = NewSessionForm()
    form.message = "Fix ENG-123"
    let request = form.spawnRequest(in: project)
    guard case let .chat(_, none) = form.scheduleTarget(request) else { Issue.record("Expected a chat target"); return }
    #expect(none == nil)
    let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(form.scheduleTarget(request))) as? [String: Any]
    #expect(plain?.keys.contains("trackedItemId") == false)

    form.trackedItem = ticket
    let target = form.scheduleTarget(request)
    // Captured before the async create: later form changes must not alter it.
    form.trackedItem = nil
    guard case let .chat(spawn, trackedItemId) = target else { Issue.record("Expected a chat target"); return }
    #expect(trackedItemId == ticket.itemId)
    #expect(spawn.projectId == project.id)
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(target)) as? [String: Any]
    #expect(json?["trackedItemId"] as? String == ticket.itemId)
    let decoded = try JSONDecoder().decode(ScheduleTarget.self, from: JSONEncoder().encode(target))
    guard case let .chat(_, decodedId) = decoded else { Issue.record("Expected a chat target"); return }
    #expect(decodedId == ticket.itemId)
}

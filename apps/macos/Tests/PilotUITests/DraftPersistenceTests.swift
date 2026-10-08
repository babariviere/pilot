import AppKit
import Foundation
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private func persistenceDirectory() -> URL {
    FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
        .appendingPathComponent("Draft Tests \(UUID().uuidString)", isDirectory: true)
}

@MainActor private func persistenceStore(_ root: URL) -> DraftStore {
    DraftStore(directory: root.appendingPathComponent("Drafts"), attachmentDirectory: root.appendingPathComponent("Attachments"))
}

@MainActor private func persistencePNG() throws -> Data {
    let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 3,
                                              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                              isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
    return try #require(bitmap.representation(using: .png, properties: [:]))
}

@Test @MainActor func draftTextQueueEditsAndTaskSelectionsPersistWithoutWaitingForAppShutdown() async throws {
    let root = persistenceDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let app = AppModel(draftStore: persistenceStore(root))
    let first = app.composer(for: "first/with unsafe filename characters")
    // The editor writes directly into its isolated state, not through ComposerState.draft.
    first.draftState.draft = "  Unfinished reply\nKeep whitespace and 🛩️  "
    let queued = try #require(QueuedMessage(json: .object([
        "id": .number(7), "mode": .string("followUp"), "content": .string("Queued message"),
    ])))
    first.selectQueuedMessage(queued)
    first.queueEditing.draft = "Unfinished queued edit"
    app.composer(for: "second").draft = "Another reply"
    app.draftProjectId = "project"
    let form = app.newSessionForm
    form.message = "Unfinished new task"
    form.model = "provider/model"
    form.folder = "/tmp/project"
    form.tab = .running
    await form.branches.load(scope: "project:/tmp/project") {
        RemoteBranchList(branches: ["main", "release"], defaultBranch: "main")
    }
    form.branches.select("release", for: "project:/tmp/project")

    // Open a fresh store while the first app is still alive. No termination flush is required.
    let restored = AppModel(draftStore: persistenceStore(root))
    let reply = restored.composer(for: "first/with unsafe filename characters")
    #expect(reply.draft == first.draft)
    #expect(reply.queueEditing.selected == queued)
    #expect(reply.queueEditing.draft == "Unfinished queued edit")
    #expect(restored.composer(for: "second").draft == "Another reply")
    #expect(restored.newSessionForm.message == form.message)
    #expect(restored.newSessionForm.folder == form.folder)
    #expect(restored.newSessionForm.model == form.model)
    #expect(restored.newSessionForm.tab == .running)
    #expect(restored.draftProjectId == "project")
    #expect(restored.newSessionForm.branches.selection(for: "project:/tmp/project") == "release")
    #expect(restored.selectedSessionId == nil)
    #expect(restored.client.sessions.isEmpty)
    #expect(restored.sessionActionError == nil)

    await restored.newSessionForm.branches.load(scope: "project:/tmp/project") {
        RemoteBranchList(branches: ["main", "release"], defaultBranch: "main")
    }
    #expect(restored.newSessionForm.branches.selected == "release")
    await restored.newSessionForm.branches.load(scope: "project:/tmp/project") {
        RemoteBranchList(branches: ["main"], defaultBranch: "main")
    }
    #expect(restored.newSessionForm.branches.selected == nil)
    #expect(AppModel(draftStore: persistenceStore(root)).newSessionForm.branches.selected == nil)
    reply.draft = ""
    reply.cancelQueueEdit()
    #expect(try persistenceStore(root).load().chats["first/with unsafe filename characters"] == nil)
    #expect(restored.newSessionForm.completeSubmission(revision: restored.newSessionForm.revision))
    #expect(AppModel(draftStore: persistenceStore(root)).newSessionForm.message.isEmpty)
    let directory = root.appendingPathComponent("Drafts")
    let permissions = try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber
    let filePermissions = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("drafts.json").path)[.posixPermissions] as? NSNumber
    #expect(permissions?.intValue == 0o700)
    #expect(filePermissions?.intValue == 0o600)
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path) == ["drafts.json"])
}

@Test @MainActor func draftImagesSurviveTeardownAndSubmittedImagesRemainProtectedAfterRestoring() throws {
    let root = persistenceDirectory()
    let board = NSPasteboard.withUniqueName()
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: root)
    }
    board.setData(try persistencePNG(), forType: .png)
    var app: AppModel? = AppModel(draftStore: persistenceStore(root))
    let images = root.appendingPathComponent("Attachments")
    #expect((app!.composer(for: "chat").attachments.paste(from: board, directory: images)) == true)
    #expect((app!.newSessionForm.attachments.paste(from: board, directory: images)) == true)
    let unsentURL = try #require(app!.composer(for: "chat").attachments.items.first?.url)
    let submittedURL = try #require(app!.newSessionForm.attachments.items.first?.url)
    try app!.newSessionForm.attachments.retainForHistory()
    app = nil
    #expect(FileManager.default.fileExists(atPath: unsentURL.path))
    #expect(FileManager.default.fileExists(atPath: submittedURL.path))

    let restored = AppModel(draftStore: persistenceStore(root))
    let chat = restored.composer(for: "chat")
    let unsent = try #require(chat.attachments.items.first)
    let submitted = try #require(restored.newSessionForm.attachments.items.first)
    #expect(unsent.url == unsentURL)
    #expect(submitted.url == submittedURL)
    #expect(submitted.submitted)
    #expect(unsent.preview.size.width <= 192 && unsent.preview.size.height <= 192)
    #expect(chat.canSend(changingModel: false))
    chat.attachments.remove(unsent.id)
    restored.newSessionForm.attachments.remove(submitted.id)
    #expect(!FileManager.default.fileExists(atPath: unsentURL.path))
    #expect(FileManager.default.fileExists(atPath: submittedURL.path))
    let again = AppModel(draftStore: persistenceStore(root))
    #expect(again.composer(for: "chat").attachments.items.isEmpty)
    #expect(again.newSessionForm.attachments.items.isEmpty)
}

@Test @MainActor func unreadableDraftSnapshotsAreReportedAndNeverOverwrittenByNewEdits() throws {
    let root = persistenceDirectory()
    let directory = root.appendingPathComponent("Drafts")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let file = directory.appendingPathComponent("drafts.json")
    for data in [Data("broken json".utf8), try JSONEncoder().encode(StoredDrafts(version: 99))] {
        try data.write(to: file)
        let app = AppModel(draftStore: persistenceStore(root))
        #expect(app.sessionActionError?.contains("persist message drafts") == true)
        app.composer(for: "chat").draft = "Keep the new draft in memory"
        #expect(app.composer(for: "chat").draft == "Keep the new draft in memory")
        #expect(try Data(contentsOf: file) == data)
        app.sessionActionError = nil
        app.composer(for: "chat").draft += " without repeatedly alerting"
        #expect(app.sessionActionError == nil)
        #expect(try Data(contentsOf: file) == data)
    }
}

@Test @MainActor func missingImagesAndPathsOutsideAttachmentStorageDoNotDiscardDraftText() throws {
    let root = persistenceDirectory()
    let images = root.appendingPathComponent("Attachments")
    try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let safeURL = images.appendingPathComponent("safe.png")
    let outsideURL = root.appendingPathComponent("outside.png")
    let symlinkURL = images.appendingPathComponent("symlink.png")
    let data = try persistencePNG()
    try data.write(to: safeURL)
    try data.write(to: outsideURL)
    try FileManager.default.createSymbolicLink(at: symlinkURL, withDestinationURL: outsideURL)
    let snapshots = [safeURL, outsideURL, symlinkURL, images.appendingPathComponent("missing.png")]
        .map { StoredImage(id: UUID(), url: $0, submitted: false) }
    let store = persistenceStore(root)
    try store.save(StoredDrafts(chats: ["chat": StoredChatDraft(text: "Keep this text", attachments: snapshots)]))
    let app = AppModel(draftStore: persistenceStore(root))
    let chat = app.composer(for: "chat")
    #expect(chat.draft == "Keep this text")
    #expect(chat.attachments.items.map(\.url) == [safeURL])
    chat.attachments.remove(try #require(chat.attachments.items.first?.id))
    #expect(FileManager.default.fileExists(atPath: outsideURL.path))
    #expect(AppModel(draftStore: persistenceStore(root)).composer(for: "chat").draft == "Keep this text")
}

@Test @MainActor func aPendingDebugPrefillPersistsBeforeTheHomeViewConsumesIt() throws {
    let root = persistenceDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let app = AppModel(draftStore: persistenceStore(root))
    app.newSessionForm.message = "Earlier draft"
    app.newSession(in: "pilot", message: "Debug this session")
    let restored = AppModel(draftStore: persistenceStore(root))
    #expect(restored.draftProjectId == "pilot")
    #expect(restored.draftMessage == "Debug this session")
    restored.newSessionForm.consumeDraft(from: restored)
    #expect(restored.newSessionForm.message == "Debug this session")
    #expect(restored.draftMessage == nil)
    restored.newSessionForm.message += " because the tool failed"
    let again = AppModel(draftStore: persistenceStore(root))
    #expect(again.draftMessage == nil)
    #expect(again.newSessionForm.message == "Debug this session because the tool failed")
}

@Test @MainActor func failedDraftWritesKeepTextInMemoryWithoutRetainingUnpersistedImages() throws {
    let root = persistenceDirectory()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let board = NSPasteboard.withUniqueName()
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: root)
    }
    // Load successfully, then prevent the draft directory from being created.
    var app: AppModel? = AppModel(draftStore: persistenceStore(root))
    try Data("Not a directory".utf8).write(to: root.appendingPathComponent("Drafts"))
    app!.composer(for: "chat").draft = "Keep typing even if saving fails"
    #expect(app!.composer(for: "chat").draft == "Keep typing even if saving fails")
    #expect(app!.sessionActionError != nil)
    board.setData(try persistencePNG(), forType: .png)
    #expect((app!.composer(for: "chat").attachments.paste(from: board, directory: root.appendingPathComponent("Attachments"))) == true)
    let url = try #require(app!.composer(for: "chat").attachments.items.first?.url)
    app = nil
    #expect(!FileManager.default.fileExists(atPath: url.path))
}

private func blockDraftWrites(_ root: URL) throws {
    try FileManager.default.moveItem(at: root.appendingPathComponent("Drafts"), to: root.appendingPathComponent("SavedDrafts"))
    try Data("Not a directory".utf8).write(to: root.appendingPathComponent("Drafts"))
}

private func restoreDraftWrites(_ root: URL) throws {
    try FileManager.default.removeItem(at: root.appendingPathComponent("Drafts"))
    try FileManager.default.moveItem(at: root.appendingPathComponent("SavedDrafts"), to: root.appendingPathComponent("Drafts"))
}

@Test @MainActor func failedRemovalWritesDoNotDeleteImagesReferencedByTheLastSavedSnapshot() throws {
    let root = persistenceDirectory()
    let board = NSPasteboard.withUniqueName()
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: root)
    }
    board.setData(try persistencePNG(), forType: .png)
    var app: AppModel? = AppModel(draftStore: persistenceStore(root))
    #expect((app!.composer(for: "chat").attachments.paste(from: board, directory: root.appendingPathComponent("Attachments"))) == true)
    let id = try #require(app!.composer(for: "chat").attachments.items.first?.id)
    let url = try #require(app!.composer(for: "chat").attachments.items.first?.url)
    try blockDraftWrites(root)
    app!.composer(for: "chat").attachments.remove(id)
    #expect(app!.sessionActionError != nil)
    #expect(FileManager.default.fileExists(atPath: url.path))
    app = nil
    try restoreDraftWrites(root)
    let restored = AppModel(draftStore: persistenceStore(root))
    #expect(restored.composer(for: "chat").attachments.items.map(\.url) == [url])
    restored.composer(for: "chat").attachments.remove(id)
    #expect(!FileManager.default.fileExists(atPath: url.path))
}

@Test @MainActor func historyRetentionSurvivesFailedDraftWritesAndAStaleUnsubmittedSnapshot() throws {
    let root = persistenceDirectory()
    let board = NSPasteboard.withUniqueName()
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: root)
    }
    board.setData(try persistencePNG(), forType: .png)
    var app: AppModel? = AppModel(draftStore: persistenceStore(root))
    #expect((app!.composer(for: "chat").attachments.paste(from: board, directory: root.appendingPathComponent("Attachments"))) == true)
    let url = try #require(app!.composer(for: "chat").attachments.items.first?.url)
    try blockDraftWrites(root)
    try app!.composer(for: "chat").attachments.retainForHistory()
    app!.composer(for: "chat").attachments = ImageAttachments()
    app = nil
    try restoreDraftWrites(root)
    #expect(try persistenceStore(root).load().chats["chat"]?.attachments.first?.submitted == false)
    let restored = AppModel(draftStore: persistenceStore(root))
    let image = try #require(restored.composer(for: "chat").attachments.items.first)
    #expect(image.submitted)
    restored.composer(for: "chat").attachments.remove(image.id)
    #expect(FileManager.default.fileExists(atPath: url.path))
    #expect(FileManager.default.fileExists(atPath: url.appendingPathExtension("submitted").path))
}

@Test @MainActor func imageRetentionFailsBeforeSubmissionIfItsHistoryMarkerCannotBeWritten() throws {
    let root = persistenceDirectory()
    let board = NSPasteboard.withUniqueName()
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: root)
    }
    board.setData(try persistencePNG(), forType: .png)
    let app = AppModel(draftStore: persistenceStore(root))
    #expect((app.composer(for: "chat").attachments.paste(from: board, directory: root.appendingPathComponent("Attachments"))) == true)
    let image = try #require(app.composer(for: "chat").attachments.items.first)
    try FileManager.default.createDirectory(at: image.url.appendingPathExtension("submitted"), withIntermediateDirectories: true)
    #expect(throws: (any Error).self) { try app.composer(for: "chat").attachments.retainForHistory() }
    #expect(!image.submitted)
    #expect(app.composer(for: "chat").attachments.items.count == 1)
    #expect(FileManager.default.fileExists(atPath: image.url.path))
}

@Test @MainActor func restoredBranchWaitsForProjectDiscoveryAndRemembersTheEffectiveDefaultProject() throws {
    _ = NSApplication.shared
    let root = persistenceDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    try persistenceStore(root).save(StoredDrafts(newTask: StoredTaskDraft(message: "Unfinished task",
        branchScope: "project:/tmp/project", baseBranch: "release")))
    let app = AppModel(draftStore: persistenceStore(root))
    app.client.fixtureModels = ModelList(models: [])
    app.client.fixtureBranches = RemoteBranchList(branches: ["main", "release"], defaultBranch: "main")
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 400),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    let hosting = NSHostingView(rootView: TaskComposer(form: app.newSessionForm, client: app.client).environmentObject(app))
    window.contentView = hosting
    hosting.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    #expect(app.newSessionForm.branches.selected == "release")
    #expect(try persistenceStore(root).load().newTask.baseBranch == "release")
    app.client.loadFixture(projects: [Project(id: "project", name: "Project", path: "/tmp/project", createdAt: 1)], sessions: [])
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    hosting.layoutSubtreeIfNeeded()
    #expect(app.newSessionForm.branches.selected == "release")
    #expect(app.draftProjectId == "project")
    #expect(try persistenceStore(root).load().newTask.projectId == "project")
    #expect(try persistenceStore(root).load().newTask.baseBranch == "release")
    app.client.loadFixture(projects: [], sessions: [])
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    #expect(app.newSessionForm.branches.selected == nil)
}

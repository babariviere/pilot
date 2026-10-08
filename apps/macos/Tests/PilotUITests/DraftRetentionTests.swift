import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func chatDraftsAreIsolatedAndSurviveNavigationWithQueuedEdits() {
    let app = AppModel()
    let first = app.composer(for: "first")
    first.draft = "  Keep this\nunfinished reply  "
    let queued = QueuedMessage(json: .object([
        "id": .number(1), "mode": .string("followUp"), "content": .string("Queued"),
    ]))!
    first.selectQueuedMessage(queued)
    first.queueEditing.draft = "Unfinished queued edit"
    app.selectedSessionId = "second"
    let second = app.composer(for: "second")
    #expect(second !== first)
    #expect(second.draft.isEmpty)
    second.draft = "Different reply"
    app.newSession(in: nil)
    app.showArchive()
    app.selectedSessionId = "first"
    #expect(app.composer(for: "first") === first)
    #expect(first.draft == "  Keep this\nunfinished reply  ")
    #expect(first.queueEditing.selected?.id == queued.id)
    #expect(first.queueEditing.draft == "Unfinished queued edit")
    #expect(app.composer(for: "second").draft == "Different reply")
    // Clearing a submitted draft must not restore an older cached copy.
    first.draft = ""
    #expect(app.composer(for: "first").draft.isEmpty)
    #expect(AppModel().composer(for: "first").draft.isEmpty)
}

@Test @MainActor func newTaskFormKeepsItsInputsAndBranchWhenLeavingHome() async {
    let app = AppModel()
    let form = app.newSessionForm
    app.draftProjectId = "chosen-project"
    form.message = "Unfinished task"
    form.folder = "/tmp/project"
    form.model = "provider/model"
    form.tab = .running
    await form.branches.load(scope: "project") {
        RemoteBranchList(branches: ["main", "release"], defaultBranch: "main")
    }
    form.branches.select("release", for: "project")
    app.selectedSessionId = "chat"
    app.showArchive()
    app.newSession(in: nil)
    form.consumeDraft(from: app)
    #expect(app.newSessionForm === form)
    #expect(app.draftProjectId == "chosen-project")
    #expect(form.message == "Unfinished task")
    #expect(form.folder == "/tmp/project")
    #expect(form.model == "provider/model")
    #expect(form.tab == .running)
    #expect(form.branches.selection(for: "project") == "release")
}

@Test @MainActor func completingAnOlderSpawnDoesNotEraseANewerDebugPrefill() {
    let app = AppModel()
    let form = app.newSessionForm
    form.message = "Submitted task"
    let submittedRevision = form.revision
    app.newSession(in: "pilot", message: "Debug another session")
    // The earlier request may finish before Home mounts and consumes the prefill.
    #expect(!form.completeSubmission(revision: submittedRevision))
    #expect(app.draftMessage == "Debug another session")
    form.consumeDraft(from: app)
    #expect(!form.completeSubmission(revision: submittedRevision))
    #expect(form.message == "Debug another session")
    #expect(form.completeSubmission(revision: form.revision))
    #expect(form.message.isEmpty)
    #expect(form.attachments.items.isEmpty)
}

@MainActor
private func draftEditor(in view: NSView) -> SubmitTextView? {
    if let editor = view as? SubmitTextView { return editor }
    return view.subviews.compactMap { draftEditor(in: $0) }.first
}

/// Replace the entire hosting tree, as navigation and closing/reopening the window do.
@MainActor
private func mountDraftView<V: View>(_ view: V, app: AppModel, window: NSWindow) throws -> SubmitTextView {
    let hosting = NSHostingView(rootView: view.environmentObject(app))
    window.contentView = hosting
    hosting.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    hosting.layoutSubtreeIfNeeded()
    return try #require(draftEditor(in: hosting))
}

@Test @MainActor func mountedChatAndHomeEditorsRestoreTextAndImagesAfterTheirViewsAreDestroyed() throws {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 700),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    let app = AppModel()
    let first = SessionSummary(id: "first", title: "First", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle")
    let second = SessionSummary(id: "second", title: "Second", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle")
    func chat(_ session: SessionSummary) -> SessionDetail {
        SessionDetail(session: session, feed: SessionFeed(sessionId: session.id, transcript: Transcript()))
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    func attach(to attachments: inout ImageAttachments, name: String) throws -> URL {
        let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2,
                                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                                  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let data = try #require(bitmap.representation(using: .png, properties: [:]))
        let url = directory.appendingPathComponent(name)
        try data.write(to: url)
        attachments.items.append(PastedImage(id: UUID(), url: url, preview: try #require(NSImage(data: data))))
        return url
    }
    var editor = try mountDraftView(chat(first), app: app, window: window)
    editor.string = "First unsent reply\nwith a second line"
    editor.didChangeText()
    let chatImage = try attach(to: &app.composer(for: first.id).attachments, name: "chat.png")

    editor = try mountDraftView(chat(second), app: app, window: window)
    #expect(editor.string.isEmpty)
    editor.string = "Second unsent reply"
    editor.didChangeText()

    editor = try mountDraftView(HomeView(), app: app, window: window)
    editor.string = "Unsent new task"
    editor.didChangeText()
    let taskImage = try attach(to: &app.newSessionForm.attachments, name: "task.png")
    window.contentView = NSView() // Neither composer remains mounted.

    editor = try mountDraftView(chat(first), app: app, window: window)
    #expect(editor.string == "First unsent reply\nwith a second line")
    #expect(app.composer(for: first.id).attachments.items.map(\.url) == [chatImage])
    #expect(FileManager.default.fileExists(atPath: chatImage.path))
    editor = try mountDraftView(chat(second), app: app, window: window)
    #expect(editor.string == "Second unsent reply")
    #expect(app.composer(for: second.id).attachments.items.isEmpty)
    editor = try mountDraftView(HomeView(), app: app, window: window)
    #expect(editor.string == "Unsent new task")
    #expect(app.newSessionForm.attachments.items.map(\.url) == [taskImage])
    #expect(FileManager.default.fileExists(atPath: taskImage.path))
}

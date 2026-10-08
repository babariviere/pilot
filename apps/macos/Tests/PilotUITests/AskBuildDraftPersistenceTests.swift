import Foundation
import PilotCore
import Testing
@testable import Pilot

private let draftProject = Project(id: "code", name: "Code", path: "/tmp/code", workspace: "direct", createdAt: 1)

private func askDraftDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("ask-drafts-\(UUID().uuidString)", isDirectory: true)
}

@Test @MainActor func unfinishedAskDraftKeepsIntentAcrossNavigationAndRestart() async throws {
    let root = askDraftDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let app = AppModel(draftStore: DraftStore(directory: root))
    app.draftProjectId = draftProject.id
    let form = app.newSessionForm
    form.message = "Explain this branch"
    form.chooseMode(.ask)
    form.workspace = .clone
    let scope = BranchSelectorState.scope(project: draftProject, mode: .ask, workspace: .clone)!
    await form.branches.load(scope: scope, mode: .ask) { RemoteBranchList(branches: ["topic"], defaultBranch: "topic") }
    form.branches.select("topic", for: scope)
    app.selectedSessionId = "another-chat"
    app.showArchive()
    app.newSession(in: nil)
    form.consumeDraft(from: app)
    #expect(form.mode == .ask && form.workspace == .clone)
    #expect(form.branches.selection(for: scope) == "topic")
    #expect(app.draftProjectId == draftProject.id)
    app.flushDrafts()
    let restored = AppModel(draftStore: DraftStore(directory: root))
    restored.newSessionForm.consumeDraft(from: restored)
    #expect(restored.newSessionForm.message == "Explain this branch")
    #expect(restored.newSessionForm.mode == .ask && restored.newSessionForm.workspace == .clone)
    #expect(restored.newSessionForm.branches.mode == .ask)
    #expect(restored.newSessionForm.branches.selection(for: scope) == "topic")
    await restored.newSessionForm.branches.load(scope: scope, mode: .ask) { RemoteBranchList(branches: ["topic"]) }
    #expect(restored.newSessionForm.branches.selection(for: scope) == "topic")
    restored.flushDrafts()
}

@Test @MainActor func submittingAskResetsNextChatAndPersistedDefaultsToBuild() throws {
    let root = askDraftDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let app = AppModel(draftStore: DraftStore(directory: root))
    app.draftProjectId = draftProject.id
    let form = app.newSessionForm
    form.message = "Ask question"
    form.mode = .ask
    form.workspace = .clone
    form.pendingBaseBranch = "topic"
    #expect(form.completeSubmission(revision: form.revision))
    #expect(form.message.isEmpty && form.mode == .build && form.workspace == nil)
    #expect(form.pendingBaseBranch == nil && form.branches.selected == nil)
    app.newSession(in: nil)
    form.consumeDraft(from: app)
    #expect(form.mode == .build && app.draftProjectId == draftProject.id)
    app.flushDrafts()
    let restored = AppModel(draftStore: DraftStore(directory: root))
    #expect(restored.newSessionForm.mode == .build && restored.newSessionForm.workspace == nil)
    #expect(restored.newSessionForm.message.isEmpty && restored.newSessionForm.pendingBaseBranch == nil)
}

@Test @MainActor func buildHandoffSourceSurvivesRestartAndCannotFallbackAfterBranchDisappears() async throws {
    let root = askDraftDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let app = AppModel(draftStore: DraftStore(directory: root))
    let ask = SessionSummary(id: "ask", title: "Plan", cwd: draftProject.path, projectId: draftProject.id,
                             createdAt: 1, updatedAt: 2, state: "idle", sessionPath: "/tmp/sessions/ask",
                             mode: .ask, sourceBranch: "origin/literal", sourceCommit: "abcdef")
    app.client.loadFixture(projects: [draftProject], sessions: [ask])
    app.newSessionForm.message = "Earlier Ask draft"
    app.newSessionForm.mode = .ask
    let previousRevision = app.newSessionForm.revision
    app.buildWithContext(from: ask, rows: [.user(id: "u", text: "Plan it"), .text(id: "a", text: "The plan")])
    #expect(!app.newSessionForm.completeSubmission(revision: previousRevision))
    // The app can close before Home consumes the one-shot prefill.
    app.flushDrafts()
    let restored = AppModel(draftStore: DraftStore(directory: root))
    #expect(restored.draftBaseBranch == "origin/literal" && restored.draftWorkspace == .clone)
    restored.newSessionForm.consumeDraft(from: restored)
    let form = restored.newSessionForm
    #expect(form.mode == .build && form.workspace == .clone)
    #expect(form.message.contains("Ask session ID: ask") && form.message.contains("Assistant:\nThe plan"))
    #expect(form.pendingBaseBranch == "origin/literal" && !form.canStart(in: draftProject))
    let scope = BranchSelectorState.scope(project: draftProject, mode: .build, workspace: .clone)!
    await form.branches.load(scope: scope) { RemoteBranchList(branches: ["main", "origin/literal"]) }
    form.resolvePendingBaseBranch(scope: scope, branches: form.branches)
    #expect(form.canStart(in: draftProject))
    // Keep the handoff source durable even after successful origin validation.
    restored.flushDrafts()
    let again = AppModel(draftStore: DraftStore(directory: root))
    let saved = again.newSessionForm
    #expect(saved.pendingBaseBranch == "origin/literal" && saved.mode == .build && saved.workspace == .clone)
    #expect(!saved.canStart(in: draftProject))
    await saved.branches.load(scope: scope) { RemoteBranchList(branches: ["main"]) }
    saved.resolvePendingBaseBranch(scope: scope, branches: saved.branches)
    #expect(saved.pendingBaseBranch == "origin/literal" && !saved.canStart(in: draftProject))
    saved.branches.select(nil, for: scope)
    saved.chooseBaseBranch(nil)
    #expect(saved.canStart(in: draftProject))
    #expect(again.draftProjectId == draftProject.id)
    again.flushDrafts()
}

@Test @MainActor func checkoutHandoffDoesNotInheritRetainedProjectsDestination() throws {
    let root = askDraftDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let app = AppModel(draftStore: DraftStore(directory: root))
    app.draftProjectId = draftProject.id
    let ask = SessionSummary(id: "cwd-ask", title: "Checkout", cwd: "/tmp/other", createdAt: 1, updatedAt: 2,
                             state: "idle", mode: .ask)
    app.buildWithContext(from: ask, rows: [])
    app.flushDrafts()
    let restored = AppModel(draftStore: DraftStore(directory: root))
    restored.newSessionForm.consumeDraft(from: restored)
    #expect(restored.draftProjectId == nil)
    #expect(restored.newSessionForm.folder == ask.cwd && restored.newSessionForm.mode == .build)
    #expect(restored.newSessionForm.pendingBaseBranch == nil)
    restored.flushDrafts()
}

@Test @MainActor func legacyTaskDraftDefaultsToBuildAndMigratesBranchScope() async throws {
    let data = Data(#"{"message":"Legacy task","attachments":[],"folder":"","model":"","projectId":"code","branchScope":"code:/tmp/code","baseBranch":"topic","runningTab":false}"#.utf8)
    let saved = try JSONDecoder().decode(StoredTaskDraft.self, from: data)
    #expect(saved.mode == nil && saved.workspace == nil && saved.pendingBaseBranch == nil)
    let branches = BranchSelectorState()
    branches.restoreSelection(scope: saved.branchScope, branch: saved.baseBranch)
    let scope = BranchSelectorState.scope(project: draftProject, mode: .build, workspace: .clone)!
    await branches.load(scope: scope) { RemoteBranchList(branches: ["topic"]) }
    #expect(branches.mode == .build && branches.selection(for: scope) == "topic")
}

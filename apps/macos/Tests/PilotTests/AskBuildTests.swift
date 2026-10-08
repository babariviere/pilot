import AppKit
@testable import PilotCore
import Testing
@testable import Pilot

private let askProject = Project(id: "ask-project", name: "Code", path: "/tmp/code", workspace: "direct", createdAt: 1)

@Test @MainActor func branchScopesIncludeModeAndEffectiveBuildWorkspace() async {
    let buildDirect = BranchSelectorState.scope(project: askProject, mode: .build, workspace: nil)
    #expect(buildDirect == nil)
    let buildClone = BranchSelectorState.scope(project: askProject, mode: .build, workspace: .clone)
    let ask = BranchSelectorState.scope(project: askProject, mode: .ask, workspace: .direct)
    #expect(buildClone != nil && ask != nil && buildClone != ask)
    #expect(BranchSelectorState.scope(project: nil, mode: .build, workspace: .clone) == nil)
    let state = BranchSelectorState()
    let list = RemoteBranchList(branches: ["main", "origin/literal"], defaultBranch: "main")
    await state.load(scope: buildClone) { list }
    state.select("origin/literal", for: buildClone!)
    await state.load(scope: ask, mode: .ask) { list }
    #expect(state.mode == .ask)
    #expect(state.selection(for: ask) == nil) // Current checkout, not origin's default.
    state.select("main", for: ask!)
    #expect(state.selection(for: ask) == "main") // Explicit default-origin snapshot.
    state.select(nil, for: ask!)
    #expect(state.selection(for: ask) == nil)
    await state.load(scope: buildClone) { list }
    #expect(state.selection(for: buildClone) == nil) // Build's existing default-base behavior.
}

@Test @MainActor func buildHandoffPreservesAskAndOnlyCopiesDiscussion() {
    let app = AppModel()
    let ask = SessionSummary(id: "a", title: "Explore", cwd: askProject.path, projectId: askProject.id,
                             createdAt: 1, updatedAt: 2, state: "parked", archivedAt: 3, sessionPath: "/tmp/sessions/a",
                             mode: .ask, sourceBranch: "origin/literal", sourceCommit: "abcdef")
    app.client.loadFixture(projects: [askProject], sessions: [ask])
    app.selectedSessionId = ask.id
    let artifact = ArtifactReference(id: "plan", sessionId: ask.id, title: "Implementation plan", revision: 2)
    app.buildWithContext(from: ask, rows: [
        .user(id: "u", text: "How does it work?"), .text(id: "a", text: "A useful explanation."),
        .thinking(id: "t", text: "Hidden thinking", streaming: false),
        .notice(id: "n", text: "Tool output should not be context"),
        .error(id: "e", text: "Error output"),
        .artifact(id: "artifact", reference: artifact),
        .tools(id: "tool", items: [ToolItem(id: "t", name: "artifact", arguments: .string("Internal args"),
                                          status: .done, output: "Internal tool output", artifact: artifact)]),
    ])
    #expect(app.selectedSessionId == nil)
    #expect(app.client.session(ask.id) == ask)
    #expect(app.draftProjectId == askProject.id)
    #expect(app.draftBaseBranch == "origin/literal")
    #expect(app.draftWorkspace == .clone)
    #expect(app.draftMessage?.contains("User:\nHow does it work?") == true)
    #expect(app.draftMessage?.contains("Assistant:\nA useful explanation.") == true)
    #expect(app.draftMessage?.contains("Hidden thinking") == false)
    #expect(app.draftMessage?.contains("Tool output") == false)
    #expect(app.draftMessage?.contains("Internal args") == false)
    #expect(app.draftMessage?.contains("Internal tool output") == false)
    #expect(app.draftMessage?.contains("Ask session ID: a") == true)
    #expect(app.draftMessage?.contains("Ask session data path: /tmp/sessions/a") == true)
    #expect(app.draftMessage?.contains("Pinned revision path: /tmp/sessions/a/artifacts/plan/2.json") == true)
    #expect(app.draftMessage?.components(separatedBy: "Artifact: Implementation plan").count == 2)
    let form = NewSessionForm()
    form.mode = .ask
    form.consumeDraft(from: app)
    #expect(form.mode == .build)
    #expect(form.workspace == .clone)
    #expect(form.pendingBaseBranch == "origin/literal")
    #expect(app.draftMessage == nil)
    #expect(app.draftBaseBranch == nil && app.draftWorkspace == nil && app.draftCwd == nil)
}

@Test @MainActor func checkoutHandoffAndFreshChatsDefaultToBuildWithoutOriginGuess() {
    let app = AppModel()
    let checkout = SessionSummary(id: "a", title: "Checkout", cwd: "/tmp/local", createdAt: 1, updatedAt: 2,
                                 state: "idle", mode: .ask, sourceCommit: "abcdef")
    app.buildWithContext(from: checkout, rows: [])
    #expect(app.draftBaseBranch == nil)
    #expect(app.draftCwd == checkout.cwd)
    let form = NewSessionForm()
    form.consumeDraft(from: app)
    #expect(form.mode == .build && form.folder == checkout.cwd)
    form.mode = .ask
    form.workspace = .clone
    app.newSession(in: askProject.id)
    form.consumeDraft(from: app)
    #expect(form.mode == .build && form.workspace == nil)
    #expect(form.effectiveWorkspace(for: askProject) == .direct)
    #expect(form.effectiveWorkspace(for: nil) == .direct)
    #expect(form.pendingBaseBranch == nil)
    #expect(app.draftProjectId == askProject.id)
}

@Test @MainActor func unavailableHandoffBranchBlocksUntilExplicitBranchOrModeChoice() async {
    let form = NewSessionForm()
    form.message = "Implement this plan"
    form.workspace = .clone
    form.pendingBaseBranch = "gone"
    let branches = BranchSelectorState()
    let scope = BranchSelectorState.scope(project: askProject, mode: .build, workspace: .clone)!
    await branches.load(scope: scope) { RemoteBranchList(branches: ["main"], defaultBranch: "main") }
    form.resolvePendingBaseBranch(scope: scope, branches: branches)
    #expect(!form.canStart(in: askProject))
    #expect(form.pendingBaseBranch == "gone" && form.error != nil)
    // BranchMenu invokes this callback even when selecting the already-default nil base.
    branches.select(nil, for: scope)
    form.chooseBaseBranch(nil)
    #expect(form.canStart(in: askProject) && form.error == nil)
    form.pendingBaseBranch = "gone"
    form.resolvePendingBaseBranch(scope: scope, branches: branches)
    branches.select("main", for: scope)
    form.chooseBaseBranch("main")
    #expect(form.canStart(in: askProject) && branches.selection(for: scope) == "main")
    form.pendingBaseBranch = "gone"
    form.chooseMode(.ask)
    #expect(form.canStart(in: askProject) && form.pendingBaseBranch == nil && form.error == nil)
}

@Test @MainActor func askCannotToggleInspectorOrPollWriteWorkspaceMetadata() async {
    let app = AppModel()
    let ask = SessionSummary(id: "a", title: "Ask", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "idle", mode: .ask)
    app.client.loadFixture(projects: [], sessions: [ask])
    app.selectedSessionId = ask.id
    app.toggleInspector(.terminal)
    #expect(!app.inspectorVisible)
    app.toggleInspector(.changes)
    #expect(!app.inspectorVisible)
    let metadata = SessionRepositoryModel()
    await metadata.load(ask, client: app.client)
    #expect(metadata.summary == nil && metadata.error == nil)
    #expect(!InspectorTab.changes.isAvailable(for: ask))
    #expect(!InspectorTab.terminal.isAvailable(for: ask))
    #expect(InspectorTab.artifacts.isAvailable(for: ask))
    app.toggleInspector(.artifacts)
    #expect(app.inspectorVisible && app.inspectorTab == .artifacts)
    app.toggleInspector(.terminal)
    #expect(app.inspectorVisible && app.inspectorTab == .artifacts)
    app.toggleInspector(.artifacts)
    #expect(!app.inspectorVisible)
}

@Test @MainActor func nilCompletionDirectoryDisablesLocalPathSuggestions() {
    let editor = SubmitTextView()
    editor.string = "@/tmp/"
    editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
    editor.completionDirectory = nil
    editor.complete(nil)
    #expect(editor.string == "@/tmp/")
}

@Test @MainActor func finishedFixtureFeedCanPrepareBuildHandoff() {
    let feed = SessionFeed(sessionId: "ask", transcript: Transcript())
    feed.start()
    #expect(feed.hasSnapshot && !feed.loading && !feed.presentation.streaming)
}

@Test @MainActor func cachedAskRowsRequireFreshSnapshotBeforeHandoff() {
    var cached = TranscriptPresentation()
    cached.rows = [.user(id: "u", text: "Question"), .text(id: "a", text: "Cached explanation")]
    cached.streaming = true
    let client = PilotClient()
    let feed = SessionFeed(sessionId: "ask", client: client, initialPresentation: cached)
    let cache = SessionFeedCache()
    cache.retain(feed, sessionId: "ask")
    #expect(cache.feed(sessionId: "ask", client: client) === feed)
    feed.start()
    #expect(feed.presentation.rows == cached.rows)
    #expect(!feed.hasSnapshot && !feed.loading && !feed.presentation.streaming)
    feed.stop()
    #expect(!feed.isSubscribed)
}

@Test @MainActor func askClipboardFallbackDoesNotReenableCheckoutCompletion() {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    board.setString("Copied context @/tmp/", forType: .string)
    let editor = SubmitTextView()
    editor.isRichText = false
    editor.completionDirectory = nil
    editor.onPasteImages = { _ in false }
    #expect(editor.readSelection(from: board, type: .string))
    let copied = editor.string
    #expect(copied == "Copied context @/tmp/")
    editor.complete(nil)
    #expect(editor.string == copied && editor.pathPicker == nil)
    #expect(editor.completionDirectory == nil)
}

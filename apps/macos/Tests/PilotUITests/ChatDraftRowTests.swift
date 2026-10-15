import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func chatRowsFollowUnsentDraftsLive() {
    let app = AppModel()
    let composer = app.composer(for: "chat")
    #expect(app.chatDraft("chat") == nil)
    composer.draft = "  Check the sidebar\nthen the Inbox "
    #expect(app.chatDraft("chat")?.text == "Check the sidebar\nthen the Inbox")
    composer.draft = " \n "
    #expect(app.chatDraft("chat") == nil, "Whitespace-only drafts count as empty")
    #expect(app.chatDraft(nil) == nil)
}

@Test @MainActor func theFocusedComposersRowWaitsUntilFocusMovesOn() {
    let app = AppModel()
    let open = app.composer(for: "open")
    let other = app.composer(for: "other")
    other.draft = "Later"
    open.draft = "Started earlier"
    open.draftState.onEditingChanged?(true)
    #expect(app.chatDraft("open") == nil)
    open.draft = "Started earlier, still typing"
    #expect(app.chatDraft("open") == nil)
    // Focusing another chat's composer shows the first chat's draft again.
    other.draftState.onEditingChanged?(true)
    #expect(app.chatDraft("open")?.text == "Started earlier, still typing")
    #expect(app.chatDraft("other") == nil)
    other.draft = ""
    other.draftState.onEditingChanged?(false)
    #expect(app.chatDraft("other") == nil, "A sent message leaves no draft")
    #expect(app.chatDraft("open")?.text == "Started earlier, still typing")
}

@Test func unsentDraftUsesAnOutlinedPencilOfItsOwn() {
    #expect(PilotIcon.unsentDraft.systemName == "pencil.line")
    #expect(PilotIcon.unsentDraft.stateFillName == nil)
    #expect(PilotIcon.unsentDraft.systemName != PilotIcon.edit.systemName)
    #expect(PilotIcon.unsentDraft.systemName != PilotIcon.draft.systemName)
}

@Test @MainActor func inboxAccessibilityReadsTheParentsModelBeforeTheDetailIsMounted() {
    let app = AppModel()
    let session = SessionSummary(id: "draft-chat", title: "Chat", cwd: "/repository", branch: "fix/draft",
                                 createdAt: 1, updatedAt: 1, state: "idle")
    // Parents build their accessibility labels before SwiftUI installs this child view's environment.
    let detail = InboxRowDetail(session: session, reason: "Needs review")
    let original = detail.accessibilityText(using: app)
    #expect(original.contains("Needs review"))
    #expect(original.contains("fix/draft"))

    let composer = app.composer(for: session.id)
    composer.draft = "Check the result\nand preserve the second line"
    let drafted = detail.accessibilityText(using: app)
    #expect(drafted.contains("Unsent draft: Check the result\nand preserve the second line"))
    #expect(drafted.contains("Needs review"), "VoiceOver also keeps the details hidden visually by the draft")

    composer.draftState.onEditingChanged?(true)
    #expect(detail.accessibilityText(using: app) == original, "The focused draft stays hidden here too")
    composer.draftState.onEditingChanged?(false)
    #expect(detail.accessibilityText(using: app) == drafted)

    let noChat = InboxRowDetail(reason: "Blocked task")
    #expect(noChat.accessibilityText(using: app).contains("Blocked task"))

    let pr = DashboardPullRequest(number: 42, url: "https://github.com/acme/app/pull/42", title: "Fix",
                                  sessionId: session.id, sessionTitle: session.title, checkedAt: 1)
    let prDetail = InboxRowDetail(session: session, pullRequest: pr)
    #expect(!prDetail.accessibilityText(using: app).contains("Unsent draft"), "PR rows keep their own metadata")
    #expect(prDetail.accessibilityText(using: app).contains("42"))
}

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

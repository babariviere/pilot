import Testing
@testable import Pilot

@Test @MainActor func modelSwitchingBlocksSendWithoutLosingTheDraft() {
    let state = ComposerState()
    state.draft = "  Follow up on the fix.  "
    #expect(state.canSend(changingModel: false))
    #expect(!state.canSend(changingModel: true))
    #expect(state.draft == "  Follow up on the fix.  ")
    #expect(state.canSend(changingModel: false))
    state.draft = " \n "
    #expect(!state.canSend(changingModel: false))
}

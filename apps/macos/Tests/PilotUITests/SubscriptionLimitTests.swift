import PilotCore
import Testing
@testable import Pilot

private let catalog = ModelList(models: [
    ModelOption(id: "anthropic/opus", provider: "anthropic", name: "Opus"),
    ModelOption(id: "anthropic/sonnet", provider: "anthropic", name: "Sonnet"),
    ModelOption(id: "openai-codex/gpt", provider: "openai-codex", name: "GPT"),
])

private func chat(id: String = "old", state: String = "working", working: Bool? = false, forced: Bool? = nil,
                  paused: Bool = true, continuedTo: String? = nil) -> SessionSummary {
    var session = SessionSummary(id: id, title: "Chat", cwd: "/work", createdAt: 1, updatedAt: 2, state: state,
                                 model: "anthropic/opus", working: working)
    if paused {
        session.subscriptionPause = SubscriptionPause(
            windows: [SubscriptionPauseWindow(provider: .anthropic, label: "5h", usedPercent: 96)], forced: forced
        )
    }
    session.continuedTo = continuedTo
    return session
}

@MainActor
private func picker(
    continueModel: @escaping (String, ContinueModelRequest) async throws -> SessionSummary,
    changeModel: @escaping (String, ChangeModelRequest) async throws -> Void = { _, _ in
        Issue.record("A pick near the limit must confirm first")
    },
    shown: @escaping @MainActor (SessionSummary) -> Void
) -> ChatModelPickerState {
    ChatModelPickerState(cwd: "/work", changeModel: changeModel, cachedModels: { _ in catalog },
                         fetchModels: { _ in catalog }, continueModel: continueModel, showContinuedChat: shown)
}

@Test @MainActor func pickingAnotherProviderWhilePausedConfirmsThenSelectsTheNewChat() async {
    var requests: [(String, ContinueModelRequest)] = []
    var shown: [String] = []
    let state = picker(continueModel: { id, request in
        requests.append((id, request))
        return chat(id: "new", state: "starting", working: true, paused: false)
    }, shown: { shown.append($0.id) })
    let session = chat()

    // Queued messages held behind the pause do not lock the picker.
    #expect(!state.canChange(session: session, working: true))
    #expect(state.canPick(session: session, working: true))
    #expect(state.pick("openai-codex/gpt", session: session, working: true) == nil)
    #expect(state.continuation == ContinuationDraft(sessionId: "old", model: "openai-codex/gpt"))
    #expect(state.continuationKind(session: session, model: "openai-codex/gpt") == .newChat)
    #expect(requests.isEmpty)

    await state.confirmContinuation(session: session)?.value
    #expect(requests.count == 1)
    #expect(requests.first?.0 == "old")
    #expect(requests.first?.1 == ContinueModelRequest(model: "openai-codex/gpt"))
    #expect(shown == ["new"])
    #expect(state.continuation == nil)
    #expect(!state.continuing)
}

@Test @MainActor func sameProviderContinuationStaysOnTheChat() async {
    var shown: [String] = []
    let state = picker(continueModel: { id, _ in chat(id: id, paused: false) }, shown: { shown.append($0.id) })
    let session = chat()
    state.beginContinuation(session: session, working: false)
    #expect(state.continuation?.model == nil)
    // Nothing to confirm until a different model is chosen.
    #expect(state.confirmContinuation(session: session) == nil)
    state.continuation?.model = "anthropic/sonnet"
    #expect(state.continuationKind(session: session, model: "anthropic/sonnet") == .sameChat)
    await state.confirmContinuation(session: session)?.value
    #expect(shown.isEmpty)
    #expect(state.continuation == nil)
}

@Test @MainActor func failedContinuationKeepsTheSheetWithItsError() async {
    struct Rejected: Error {}
    let state = picker(continueModel: { _, _ in throw Rejected() }, shown: { _ in Issue.record("Nothing to show") })
    let session = chat()
    state.beginContinuation(session: session, model: "openai-codex/gpt", working: false)
    await state.confirmContinuation(session: session)?.value
    #expect(state.continuation?.model == "openai-codex/gpt")
    #expect(state.continuationError != nil)
}

@Test @MainActor func continuedChatsAreReadOnlyAndIdleChatsSwitchDirectly() async {
    var changes: [ChangeModelRequest] = []
    let state = picker(continueModel: { _, _ in
        Issue.record("No continuation without a pause")
        return chat()
    }, changeModel: { _, request in changes.append(request) }, shown: { _ in })

    let continued = chat(state: "idle", working: nil, paused: false, continuedTo: "new")
    #expect(!state.canChange(session: continued, working: false))
    #expect(!state.canContinue(session: continued, working: false))
    #expect(!state.canPick(session: continued, working: false))
    state.beginContinuation(session: continued, working: false)
    #expect(state.continuation == nil)

    // Away from any limit, the chip keeps its plain model switch.
    let idle = chat(state: "idle", working: nil, paused: false)
    await state.pick("openai-codex/gpt", session: idle, working: false)?.value
    #expect(changes.map(\.model) == ["openai-codex/gpt"])
    #expect(state.continuation == nil)

    // A working chat without a pause cannot continue either.
    let busy = chat(state: "working", working: true, paused: false)
    #expect(!state.canContinue(session: busy, working: true))

    // pilotd accepts a continuation only under an unforced pause, so idle and forced chats switch directly.
    #expect(!state.canContinue(session: idle, working: false))
    let forced = chat(state: "idle", working: nil, forced: true)
    #expect(!state.canContinue(session: forced, working: false))
    state.beginContinuation(session: forced, working: false)
    #expect(state.continuation == nil)
    await state.pick("anthropic/sonnet", session: forced, working: false)?.value
    #expect(changes.map(\.model) == ["openai-codex/gpt", "anthropic/sonnet"])
    #expect(state.continuation == nil)
}

@Test @MainActor func forceTogglesBackAndReportsFailures() async {
    var sent: [Bool] = []
    let force = SubscriptionForceState(setForce: { _, value in sent.append(value) })
    #expect(await force.toggle(session: chat()) == nil)
    #expect(await force.toggle(session: chat(working: true, forced: true)) == nil)
    #expect(sent == [true, false])
    #expect(await force.toggle(session: chat(continuedTo: "new")) == nil)
    #expect(sent == [true, false])

    struct Offline: Error {}
    let failing = SubscriptionForceState(setForce: { _, _ in throw Offline() })
    #expect(await failing.toggle(session: chat()) != nil)
    #expect(!failing.busy)
}

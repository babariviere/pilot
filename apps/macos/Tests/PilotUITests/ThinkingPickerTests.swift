import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private func thinkingSession(state: String = "idle", model: String? = "provider/model",
                             thinking: String? = "low", archivedAt: Double? = nil) -> SessionSummary {
    SessionSummary(id: "s", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: state,
                   model: model, archivedAt: archivedAt, thinking: thinking)
}

@MainActor private func thinkingCatalog() -> ModelList {
    ModelList(models: [
        ModelOption(id: "provider/model", provider: "provider", name: "Model", reasoning: true,
                    thinking: "low", thinkingLevels: ["off", "low", "high", "xhigh"]),
        ModelOption(id: "provider/plain", provider: "provider", name: "Plain", thinkingLevels: ["off"]),
        ModelOption(id: "provider/old", provider: "provider", name: "Old", reasoning: true),
    ])
}

@Test @MainActor func thinkingChoicesUseOnlyTheCurrentModelsAdvertisedCapabilities() {
    let state = ChatModelPickerState()
    state.models = thinkingCatalog()
    #expect(state.thinkingLevels(for: thinkingSession()) == ["off", "low", "high", "xhigh"])
    #expect(state.thinkingLevels(for: thinkingSession(model: "provider/plain")) == ["off"])
    #expect(state.thinkingLevels(for: thinkingSession(model: "provider/old")).isEmpty)
    #expect(state.thinkingLevels(for: thinkingSession(model: "missing/model")).isEmpty)
    #expect(state.thinkingLevels(for: thinkingSession(model: nil)).isEmpty)
}

@Test @MainActor func thinkingChangesKeepTheModelAndSharePendingSendAdmission() async {
    let composer = ComposerState()
    composer.draft = "Keep this draft"
    var requests: [ChangeModelRequest] = []
    var picker: ChatModelPickerState!
    picker = ChatModelPickerState { id, request in
        #expect(id == "s")
        #expect(picker.changing)
        #expect(!composer.canSend(changingModel: picker.changing))
        #expect(!picker.canChange(session: thinkingSession(), working: false))
        #expect(picker.selectModel("provider/plain", session: thinkingSession(), working: false) == nil)
        #expect(picker.selectThinking("off", session: thinkingSession(), working: false) == nil)
        requests.append(request)
    }
    picker.models = thinkingCatalog()
    let pending = picker.selectThinking("high", session: thinkingSession(), working: false)
    #expect(pending != nil)
    #expect(picker.changing)
    await pending?.value
    #expect(!picker.changing)
    #expect(picker.error == nil)
    #expect(requests.count == 1)
    #expect(requests.first?.model == "provider/model")
    #expect(requests.first?.thinking == "high")
    #expect(composer.draft == "Keep this draft")
    #expect(composer.canSend(changingModel: picker.changing))

    await picker.selectModel("provider/plain", session: thinkingSession(), working: false)?.value
    #expect(requests.last?.model == "provider/plain")
    #expect(requests.last?.thinking == nil)
    await picker.selectThinking("off", session: thinkingSession(), working: false)?.value
    #expect(requests.last?.thinking == "off")
}

@Test @MainActor func thinkingAndModelChangesRejectBusyArchivedFailedAndNoOpSelections() async {
    let picker = ChatModelPickerState { _, _ in Issue.record("Unexpected model change") }
    picker.models = thinkingCatalog()
    for session in [thinkingSession(state: "working"), thinkingSession(state: "starting"),
                    thinkingSession(state: "failed"), thinkingSession(archivedAt: 3)] {
        #expect(!picker.canChange(session: session, working: false))
        #expect(picker.selectThinking("high", session: session, working: false) == nil)
        #expect(picker.selectModel("provider/plain", session: session, working: false) == nil)
    }
    // The composer folds both a working transcript and queued messages into this flag.
    #expect(picker.selectThinking("high", session: thinkingSession(), working: true) == nil)
    #expect(picker.selectModel("provider/plain", session: thinkingSession(), working: true) == nil)
    #expect(picker.selectThinking("low", session: thinkingSession(), working: false) == nil)
    #expect(picker.selectModel("provider/model", session: thinkingSession(), working: false) == nil)
    #expect(picker.selectModel("missing/model", session: thinkingSession(), working: false) == nil)
    #expect(picker.selectThinking("max", session: thinkingSession(), working: false) == nil)
    #expect(picker.selectThinking("high", session: thinkingSession(model: "provider/plain"), working: false) == nil)
    #expect(picker.selectThinking("off", session: thinkingSession(model: "provider/plain"), working: false) == nil)
    #expect(picker.selectThinking("high", session: thinkingSession(model: "provider/old"), working: false) == nil)
    #expect(picker.selectThinking("high", session: thinkingSession(model: nil), working: false) == nil)
    #expect(!picker.changing)
}

@Test @MainActor func failedThinkingChangeShowsErrorAndAllowsRetryWithoutOptimisticChanges() async {
    var attempts = 0
    let picker = ChatModelPickerState { _, _ in
        attempts += 1
        if attempts == 1 { throw ClientError("Thinking change rejected") }
    }
    picker.models = thinkingCatalog()
    let session = thinkingSession()
    await picker.selectThinking("high", session: session, working: false)?.value
    #expect(picker.error == "Thinking change rejected")
    #expect(!picker.changing)
    #expect(session.thinking == "low")
    await picker.selectThinking("high", session: session, working: false)?.value
    #expect(picker.error == nil)
    #expect(attempts == 2)
    #expect(!picker.changing)
}

@Test @MainActor func modelAndThinkingControlsStackAtNarrowWidths() {
    _ = NSApplication.shared
    let picker = ChatModelPickerState()
    picker.models = ModelList(models: [
        ModelOption(id: "provider/model", provider: "provider", name: "A very long model display name for a narrow composer",
                    thinkingLevels: ["off", "low", "high", "xhigh"]),
    ])
    let session = thinkingSession(thinking: "xhigh")
    func size(width: CGFloat) -> NSSize {
        let view = ChatModelControls(session: session, working: false, state: picker)
            .frame(width: width, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
        let hosting = NSHostingView(rootView: view)
        return hosting.fittingSize
    }
    let wide = size(width: 600)
    let narrow = size(width: 240)
    #expect(abs(narrow.width - 240) < 0.01)
    #expect(narrow.height > wide.height * 1.8)
    #expect(wide.height > 0)
}

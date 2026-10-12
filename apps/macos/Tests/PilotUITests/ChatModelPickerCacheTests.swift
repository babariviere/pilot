import AppKit
import Combine
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private struct Offline: Error {}

private func catalog(_ ids: String...) -> ModelList {
    ModelList(models: ids.map { ModelOption(id: "p/\($0)", provider: "p", name: $0) })
}

@Test @MainActor func modelPickerHasCachedPresentationBeforeItsFirstRender() async {
    let cached = ModelList(models: [
        ModelOption(id: "p/raw-id", provider: "p", name: "Friendly model name", thinkingLevels: ["low", "high"]),
    ])
    var fetches = 0
    for cwd in ["/first-chat", "/second-chat", "/first-chat"] {
        let picker = ChatModelPickerState(
            cwd: cwd,
            cachedModels: { scope in
                #expect(scope == cwd)
                return cached
            },
            fetchModels: { _ in
                fetches += 1
                return cached
            }
        )
        let session = SessionSummary(id: cwd, title: "Chat", cwd: cwd, createdAt: 1, updatedAt: 2,
                                     state: "idle", model: "p/raw-id")
        // No task or appearance callback has run yet.
        #expect(picker.models == cached)
        #expect(picker.displayName(for: session.model) == "Friendly model name")
        #expect(picker.providers == ["p"])
        #expect(picker.modelsByProvider["p"] == cached.models)
        #expect(picker.thinkingLevels(for: session) == ["low", "high"])

        var updates = 0
        let observation = picker.objectWillChange.sink { updates += 1 }
        await picker.loadModels(cwd: cwd)
        #expect(updates == 0)
        withExtendedLifetime(observation) {}
    }
    #expect(fetches == 3)
}

@Test @MainActor func modelPickerStillLoadsWhenTheInitialScopeIsNotCached() async {
    var fetches = 0
    let picker = ChatModelPickerState(
        cwd: "/new-chat", cachedModels: { _ in nil }, fetchModels: { _ in
            fetches += 1
            return catalog("fresh")
        }
    )
    #expect(fetches == 0)
    #expect(picker.models.models.isEmpty)
    #expect(picker.displayName(for: "p/fresh") == "fresh")
    await picker.loadModels(cwd: "/new-chat")
    #expect(fetches == 1)
    #expect(picker.models == catalog("fresh"))
}

@Test @MainActor func modelPickerDoesNotReadACacheScopeWithoutASession() {
    let picker = ChatModelPickerState(cachedModels: { _ in
        Issue.record("No scope should be read without a session")
        return catalog("unrelated")
    })
    #expect(picker.models.models.isEmpty)
    #expect(picker.displayName(for: nil) == "Model")
}

@Test @MainActor func cachedModelControlsKeepTheirFirstRenderSizeWithALargeCatalog() async {
    _ = NSApplication.shared
    let cached = ModelList(models: (0..<1000).map {
        ModelOption(id: "p/model-\($0)", provider: "p", name: "A long friendly model display name \($0)",
                    thinkingLevels: ["low", "high", "xhigh"])
    })
    let session = SessionSummary(id: "large", title: "Chat", cwd: "/large", createdAt: 1, updatedAt: 2,
                                 state: "idle", model: "p/model-999", thinking: "xhigh")
    for width in [240.0, 600.0] {
        let picker = ChatModelPickerState(cwd: session.cwd, cachedModels: { _ in cached }, fetchModels: { _ in cached })
        let hosting = NSHostingView(rootView: ChatModelControls(session: session, working: false, state: picker)
            .frame(width: width, alignment: .leading).fixedSize(horizontal: false, vertical: true))
        let initialSize = hosting.fittingSize
        #expect(picker.displayName(for: session.model) == "A long friendly model display name 999")
        #expect(picker.thinkingLevels(for: session) == ["low", "high", "xhigh"])
        await picker.loadModels(cwd: session.cwd)
        #expect(hosting.fittingSize == initialSize)
    }
}

@Test @MainActor func modelPickerShowsTheCachedListBeforeRevalidating() async {
    var seenBeforeFetch: ModelList?
    var picker: ChatModelPickerState!
    picker = ChatModelPickerState(
        changeModel: { _, _ in },
        cachedModels: { cwd in
            #expect(cwd == "/work")
            return catalog("cached")
        },
        fetchModels: { _ in
            seenBeforeFetch = picker.models
            return catalog("cached", "fresh")
        }
    )
    await picker.loadModels(cwd: "/work")
    #expect(seenBeforeFetch == catalog("cached"))
    #expect(picker.models == catalog("cached", "fresh"))
    #expect(picker.error == nil)
}

@Test @MainActor func modelPickerKeepsTheCachedListWhenRevalidationFails() async {
    let cachedPicker = ChatModelPickerState(
        changeModel: { _, _ in }, cachedModels: { _ in catalog("cached") }, fetchModels: { _ in throw Offline() }
    )
    await cachedPicker.loadModels(cwd: "/work")
    #expect(cachedPicker.models == catalog("cached"))
    #expect(cachedPicker.error == nil)

    let uncached = ChatModelPickerState(
        changeModel: { _, _ in }, cachedModels: { _ in nil }, fetchModels: { _ in throw Offline() }
    )
    await uncached.loadModels(cwd: "/work")
    #expect(uncached.models.models.isEmpty)
    #expect(uncached.error != nil)
}

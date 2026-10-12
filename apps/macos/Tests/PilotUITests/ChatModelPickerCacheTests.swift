import PilotCore
import Testing
@testable import Pilot

private struct Offline: Error {}

private func catalog(_ ids: String...) -> ModelList {
    ModelList(models: ids.map { ModelOption(id: "p/\($0)", provider: "p", name: $0) })
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

import Foundation
import PilotCore
import Testing
@testable import Pilot

private let scopeLocal = HostRef(hostId: "local", daemonId: "mac", lineageId: "mac-history")
private let scopeRemote = HostRef(hostId: "box", daemonId: "linux", lineageId: "linux-history")
private let scopeBaseline = ScopedModelsBaseline(patterns: ["provider/original"], hash: "original")

@Test func scopedModelsPreservesLiteralOrderDuplicatesSuffixesAndObservedEmptyAll() throws {
    let patterns = ["provider/model:high", " model * ", "provider/model:high", "unknown/literal"]
    let selection = ScopedModelsSelection(patterns: patterns)
    try selection.validate()
    var state = ScopedModelsState()
    try state.save(selection, on: scopeLocal, baseline: scopeBaseline)
    let decoded = try JSONDecoder().decode(ScopedModelsState.self, from: JSONEncoder().encode(state))
    #expect(decoded == state)
    #expect(decoded.desired?.patterns == patterns)
    let oldAll = ScopedModelsBaseline(patterns: [], hash: "empty-array")
    #expect(oldAll.displaysAll)
    #expect(oldAll.patterns == [])
    #expect(oldAll.selection == .all)
    #expect(oldAll.patterns != oldAll.selection.patterns, "Exact readback must distinguish [] from explicit null")
    #expect(throws: ScopedModelsFailure.self) { try ScopedModelsSelection(patterns: []).validate() }
    #expect(throws: ScopedModelsFailure.self) { try ScopedModelsSelection(patterns: [String(repeating: "é", count: 129)]).validate() }
    try ScopedModelsSelection(patterns: [String(repeating: "é", count: 128)]).validate()
}

@Test func scopedModelsNewIntentDoesNotRebaseConflictsOrUndoPersistentLeave() throws {
    var state = ScopedModelsState()
    try state.save(.init(patterns: ["first"]), on: scopeLocal, baseline: scopeBaseline)
    state.edit(scopeRemote) { $0.baseline = scopeBaseline; $0.participates = true }
    state.edit(scopeRemote) { $0.status = .conflict; $0.observed = .init(patterns: ["elsewhere"], hash: "new") }
    try state.save(.init(patterns: ["second"]), on: scopeLocal)
    #expect(state.entry(scopeRemote)?.baseline == scopeBaseline)
    #expect(state.entry(scopeRemote)?.status == .conflict)
    let archived = state.entry(scopeRemote)
    state.leave(scopeLocal)
    try state.save(.all, on: scopeLocal)
    #expect(state.entry(scopeLocal)?.status == .divergent)
    #expect(state.entry(scopeRemote) == archived)
    #expect(throws: ScopedModelsFailure.self) { try state.save(.all, on: scopeRemote) }

}

@Test func scopedModelsStorePersistsIntentAndOutcomesBeforeDispatchAndFencesCorruption() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = ScopedModelsStore(directory: directory)
    let empty = try await store.load()
    #expect(empty.desired == nil && empty.revision == 0)
    #expect(!FileManager.default.fileExists(atPath: directory.path))
    let saved = try await store.update { try $0.save(.all, on: scopeLocal, baseline: scopeBaseline) }
    #expect(saved.revision == 1)
    let second = ScopedModelsStore(directory: directory)
    let restored = try await second.load()
    #expect(restored == saved)
    let url = directory.appendingPathComponent("scoped-models.json")
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    let corrupt = Data("not-json".utf8)
    try corrupt.write(to: url)
    let broken = ScopedModelsStore(directory: directory)
    do { _ = try await broken.load(); Issue.record("Corruption must fence reads") } catch {}
    do { _ = try await broken.update { try $0.save(.all, on: scopeLocal) }; Issue.record("Corruption must fence writes") } catch {}
    #expect(try Data(contentsOf: url) == corrupt)
}

@Test @MainActor func scopedModelsEditorKeepsLiteralPatternsUntilExplicitEdits() {
    let editor = ScopedModelsEditor()
    editor.initialize(.init(patterns: ["unknown/*:high", " space ", "unknown/*:high"]))
    #expect(!editor.edited)
    editor.initialize(.all)
    #expect(editor.patterns == ["unknown/*:high", " space ", "unknown/*:high"])
    editor.move(1, by: -1)
    #expect(editor.selection.patterns == [" space ", "unknown/*:high", "unknown/*:high"])
    editor.setAll(true)
    #expect(editor.selection.patterns == nil)
    editor.setAll(false)
    #expect(editor.patterns.count == 3)
    editor.select("new/provider-model", selected: true)
    #expect(editor.patterns == [" space ", "unknown/*:high", "unknown/*:high", "new/provider-model"])
    editor.select("new/provider-model", selected: false)
    #expect(editor.patterns == [" space ", "unknown/*:high", "unknown/*:high"])
}

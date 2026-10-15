import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func localDraftMigrationIsDurableAndNeverAdoptsCollidingRemoteDrafts() throws {
    let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
        .appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    func store() -> DraftStore {
        DraftStore(directory: root.appendingPathComponent("Drafts"), attachmentDirectory: root.appendingPathComponent("Images"))
    }
    let local = HostRef(hostId: "local", daemonId: "same", lineageId: "history")
    let remote = HostRef(hostId: "box", daemonId: "same", lineageId: "history")
    let localRef = HostResourceRef(host: local, kind: .session, localId: "same")
    let remoteRef = HostResourceRef(host: remote, kind: .session, localId: "same")
    let app = AppModel(draftStore: store())
    let legacy = app.composer(for: "same")
    legacy.draft = "Local unsent reply"
    let remoteComposer = try app.composer(for: remoteRef)
    remoteComposer.draft = "Remote unsent reply"
    try app.registerLocal(local)
    #expect(app.composer(for: "same") === legacy)
    #expect(try app.composer(for: localRef) === legacy)
    #expect(try app.composer(for: remoteRef) === remoteComposer)
    legacy.draft = "Edited after migration"
    try app.selectSession(remoteRef)
    #expect(app.selectedSessionId == nil)
    #expect(app.hosts.selection == remoteRef)
    app.flushDrafts()
    let saved = try store().load()
    #expect(saved.chats["same"] == nil)
    #expect(saved.chats[localRef.storageKey]?.text == "Edited after migration")
    #expect(saved.chats[remoteRef.storageKey]?.text == "Remote unsent reply")
    let offline = AppModel(draftStore: store())
    #expect(offline.localHost == local)
    #expect(offline.composer(for: "same").draft == "Edited after migration")
    #expect(try offline.composer(for: remoteRef).draft == "Remote unsent reply")
    #expect(offline.hosts.selection == remoteRef)
    #expect(offline.client.sessions.isEmpty)
}

@Test @MainActor func corruptQualifiedDraftKeysBlockPersistenceRatherThanOverwriteOriginalData() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let original = Data(#"{"version":1,"chats":{"hostref1:broken":{"text":"keep","attachments":[],"queueEditing":{}}},"newTask":{}}"#.utf8)
    let file = root.appendingPathComponent("drafts.json")
    try original.write(to: file)
    let store = DraftStore(directory: root)
    #expect(throws: (any Error).self) { try store.load() }
    #expect(throws: (any Error).self) { try store.save(StoredDrafts()) }
    #expect(try Data(contentsOf: file) == original)
}


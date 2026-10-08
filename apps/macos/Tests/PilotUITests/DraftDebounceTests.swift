import AppKit
import Foundation
import Testing
@testable import Pilot

private final class DraftWriteProbe {
    private let lock = NSLock()
    private var records: [(String, Bool)] = []
    let started = DispatchSemaphore(value: 0)
    let proceed = DispatchSemaphore(value: 0)
    var blockFirstWrite = false

    func write(_ drafts: StoredDrafts, _ directory: URL) throws {
        lock.lock()
        let first = records.isEmpty
        records.append((drafts.newTask.message, Thread.isMainThread))
        lock.unlock()
        if first && blockFirstWrite {
            started.signal()
            guard proceed.wait(timeout: .now() + 5) == .success else {
                throw NSError(domain: "DraftWriteProbe", code: 1)
            }
        }
        try DraftStore.write(drafts, to: directory)
    }

    var messages: [String] {
        lock.lock()
        defer { lock.unlock() }
        return records.map { $0.0 }
    }

    var wroteOnMainThread: Bool {
        lock.lock()
        defer { lock.unlock() }
        return records.contains { $0.1 }
    }
}

@Test @MainActor func draftDebounceCoalescesWritesAndFlushPublishesLatestExactlyOnceOffMain() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let probe = DraftWriteProbe()
    let store = DraftStore(directory: root, debounceInterval: 60, writeSnapshot: probe.write)
    var completions: [Int] = []
    for revision in 0..<100 {
        try store.scheduleSave(StoredDrafts(newTask: StoredTaskDraft(message: "\(revision)"))) { result in
            #expect(Thread.isMainThread)
            #expect((try? result.get()) != nil)
            completions.append(revision)
        }
    }
    #expect(probe.messages.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("drafts.json").path))
    store.flush()
    store.flush()
    #expect(probe.messages == ["99"])
    #expect(!probe.wroteOnMainThread)
    #expect(completions == [99])
    #expect(try DraftStore(directory: root).load().newTask.message == "99")
}

@Test @MainActor func lifecycleFlushDrainsInFlightWriteBeforePublishingNewestDraft() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let probe = DraftWriteProbe()
    probe.blockFirstWrite = true
    let store = DraftStore(directory: root, debounceInterval: 0, writeSnapshot: probe.write)
    var completions: [String] = []
    try store.scheduleSave(StoredDrafts(newTask: StoredTaskDraft(message: "first"))) { result in
        #expect((try? result.get()) != nil)
        completions.append("first")
    }
    #expect(probe.started.wait(timeout: .now() + 2) == .success)
    // Scheduling a newer revision cannot wait for the older disk write.
    try store.scheduleSave(StoredDrafts(newTask: StoredTaskDraft(message: "latest"))) { result in
        #expect((try? result.get()) != nil)
        completions.append("latest")
    }
    probe.proceed.signal()
    store.flush()
    store.flush()
    #expect(probe.messages == ["first", "latest"])
    #expect(completions == ["first", "latest"])
    #expect(try DraftStore(directory: root).load().newTask.message == "latest")
}

@Test @MainActor func immediateDraftSaveAlsoPublishesOffMainBeforeReturning() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let probe = DraftWriteProbe()
    let store = DraftStore(directory: root, writeSnapshot: probe.write)
    try store.save(StoredDrafts(newTask: StoredTaskDraft(message: "immediate")))
    #expect(!probe.wroteOnMainThread)
    #expect(probe.messages == ["immediate"])
    #expect(try DraftStore(directory: root).load().newTask.message == "immediate")
}

@Test @MainActor func draftsPublishAfterDebounceWithoutWaitingForLifecycleFlush() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let probe = DraftWriteProbe()
    let store = DraftStore(directory: root, debounceInterval: 0.01, writeSnapshot: probe.write)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        do {
            try store.scheduleSave(StoredDrafts(newTask: StoredTaskDraft(message: "automatic"))) { result in
                #expect(Thread.isMainThread)
                continuation.resume(with: result)
            }
        } catch { continuation.resume(throwing: error) }
    }
    #expect(!probe.wroteOnMainThread)
    #expect(probe.messages == ["automatic"])
    #expect(try DraftStore(directory: root).load().newTask.message == "automatic")
}

@Test @MainActor func removedPendingAttachmentStaysReservedUntilTheNewestSnapshotSucceeds() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let attachmentDirectory = root.appendingPathComponent("Attachments")
    try FileManager.default.createDirectory(at: attachmentDirectory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = attachmentDirectory.appendingPathComponent("pending.png")
    try Data("test attachment".utf8).write(to: url)
    let app = AppModel(draftStore: DraftStore(directory: root.appendingPathComponent("Drafts"),
                                             attachmentDirectory: attachmentDirectory, debounceInterval: 60))
    let image = PastedImage(id: UUID(), url: url, preview: NSImage(size: .zero))
    let composer = app.composer(for: "chat")
    composer.attachments = ImageAttachments(items: [image])
    composer.attachments.remove(image.id)
    #expect(FileManager.default.fileExists(atPath: url.path))
    app.flushDrafts()
    #expect(!FileManager.default.fileExists(atPath: url.path))
    #expect(try DraftStore(directory: root.appendingPathComponent("Drafts")).load().chats["chat"] == nil)
}

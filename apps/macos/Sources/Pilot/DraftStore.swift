import AppKit
import Darwin
import Foundation
import ImageIO
import PilotCore

struct StoredDrafts: Codable {
    var version: Int = 1
    var chats: [String: StoredChatDraft] = [:]
    var newTask: StoredTaskDraft = StoredTaskDraft()
}

struct StoredChatDraft: Codable {
    var text: String = ""
    var attachments: [StoredImage] = []
    var queueEditing: QueuedMessageEditing = QueuedMessageEditing()
}

struct StoredTaskDraft: Codable {
    var message: String = ""
    var attachments: [StoredImage] = []
    var folder: String = ""
    var model: String = ""
    var projectId: String? = nil
    var pendingMessage: String? = nil
    var branchScope: String? = nil
    var baseBranch: String? = nil
    var runningTab: Bool = false
    /// Optional so draft files from before Ask/Build still decode as Build.
    var mode: ChatMode? = nil
    var workspace: WorkspaceMode? = nil
    /// Required handoff source, retained even after origin validation succeeds.
    var pendingBaseBranch: String? = nil
    var pendingCwd: String? = nil
    var pendingWorkspace: WorkspaceMode? = nil
    var mission: Mission? = nil
}

struct StoredImage: Codable {
    var id: UUID
    var url: URL
    var submitted: Bool

    init(id: UUID, url: URL, submitted: Bool) {
        self.id = id
        self.url = url
        self.submitted = submitted
    }

    @MainActor
    init(_ image: PastedImage) {
        self.init(id: image.id, url: image.url, submitted: image.submitted)
    }
}

/// A failed read must never turn into an empty snapshot overwriting the original file.
@MainActor
final class DraftStore {
    nonisolated static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Pilot/Drafts", isDirectory: true)
    }

    private let directory: URL
    private let attachmentDirectory: URL
    private var didLoad = false
    private var loadError: Error?
    private let writer = DraftWriter()
    private var pendingSave: DraftWriter.Request?
    private var pendingWork: DispatchWorkItem?
    private var outstanding: [DraftWriter.Request] = []
    private let debounceInterval: TimeInterval
    private let writeSnapshot: (StoredDrafts, URL) throws -> Void

    init(directory: URL = DraftStore.directory, attachmentDirectory: URL = ImageAttachments.directory,
         debounceInterval: TimeInterval = 0.3,
         writeSnapshot: ((StoredDrafts, URL) throws -> Void)? = nil) {
        self.directory = directory
        self.attachmentDirectory = attachmentDirectory
        self.debounceInterval = debounceInterval
        self.writeSnapshot = writeSnapshot ?? Self.write
    }

    func load() throws -> StoredDrafts {
        if let loadError { throw loadError }
        do {
            let data: Data
            do {
                data = try Data(contentsOf: directory.appendingPathComponent("drafts.json"))
            } catch let error as NSError where error.domain == NSCocoaErrorDomain
                && (error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError) {
                didLoad = true
                return StoredDrafts()
            }
            let drafts = try JSONDecoder().decode(StoredDrafts.self, from: data)
            guard drafts.version == 1 else {
                throw StoreError.unsupportedVersion(drafts.version)
            }
            didLoad = true
            return drafts
        } catch {
            loadError = error
            throw error
        }
    }

    func save(_ drafts: StoredDrafts) throws {
        flush()
        try validateSave(drafts)
        let request = DraftWriter.Request(drafts: drafts, directory: directory,
                                          write: writeSnapshot, completion: { _ in })
        writer.performAndWait(request)
        guard let (_, result) = request.takeCompleted() else {
            preconditionFailure("Synchronous draft write did not complete.")
        }
        try result.get()
    }

    private func validateSave(_ drafts: StoredDrafts) throws {
        if let loadError { throw loadError }
        // Also protect callers that save before explicitly loading.
        if !didLoad { _ = try load() }
        guard drafts.version == 1 else { throw StoreError.unsupportedVersion(drafts.version) }
    }

    /// Snapshots are captured on the main actor, but encoding and all writes run on one serial queue.
    /// Completion is delivered on the main actor, in write order, including during a lifecycle flush.
    func scheduleSave(_ drafts: StoredDrafts, completion: @escaping (Result<Void, Error>) -> Void) throws {
        try validateSave(drafts)
        pendingWork?.cancel()
        if let pendingSave, pendingSave.cancelIfUnstarted() {
            outstanding.removeAll { $0 === pendingSave }
        }
        let request = DraftWriter.Request(drafts: drafts, directory: directory,
                                          write: writeSnapshot, completion: completion)
        pendingSave = request
        outstanding.append(request)
        let work = DispatchWorkItem { [self, writer] in
            writer.perform(request)
            DispatchQueue.main.async { [self] in
                if pendingSave === request {
                    pendingSave = nil
                    pendingWork = nil
                }
                deliverCompletedWrites()
            }
        }
        pendingWork = work
        writer.queue.asyncAfter(deadline: .now() + debounceInterval, execute: work)
    }

    /// A durability boundary for window close, app deactivation/quit, and fixtures opening another store.
    /// Waits for any in-flight write, writes the latest pending snapshot once, then reports all results.
    func flush() {
        pendingWork?.cancel()
        if let pendingSave { writer.performAndWait(pendingSave) }
        pendingSave = nil
        pendingWork = nil
        deliverCompletedWrites()
    }

    private func deliverCompletedWrites() {
        // Never wait for another write in ordinary completions. Only explicit flush/save block.
        while let request = outstanding.first, let (completion, result) = request.takeCompleted() {
            outstanding.removeFirst()
            completion(result)
        }
    }

    nonisolated static func write(_ drafts: StoredDrafts, to directory: URL) throws {
        let data = try JSONEncoder().encode(drafts)
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true,
                                    attributes: [.posixPermissions: 0o700])
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)

        // Publish only a fully written, private file. Rename on the same filesystem is atomic.
        let temporary = directory.appendingPathComponent(".drafts-\(UUID().uuidString).json")
        defer { try? manager.removeItem(at: temporary) }
        try data.write(to: temporary, options: .withoutOverwriting)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        let destination = directory.appendingPathComponent("drafts.json")
        guard rename(temporary.path, destination.path) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
    }

    func restoreAttachments(_ images: [StoredImage]) -> ImageAttachments {
        let root = attachmentDirectory.standardizedFileURL.resolvingSymlinksInPath()
        let rootComponents = root.pathComponents
        let items = images.compactMap { stored -> PastedImage? in
            guard stored.url.isFileURL else { return nil }
            let url = stored.url.standardizedFileURL.resolvingSymlinksInPath()
            let components = url.pathComponents
            guard components.count > rootComponents.count,
                  components.starts(with: rootComponents),
                  FileManager.default.isReadableFile(atPath: url.path),
                  (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
                  let source = CGImageSourceCreateWithURL(url as CFURL, [
                      kCGImageSourceShouldCache: false,
                  ] as CFDictionary),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                      kCGImageSourceThumbnailMaxPixelSize: 192,
                  ] as CFDictionary) else { return nil }
            let image = PastedImage(id: stored.id, url: url,
                                    preview: NSImage(cgImage: thumbnail, size: .zero), submitted: stored.submitted)
            image.retainForDraft()
            return image
        }
        return ImageAttachments(items: items)
    }

    private enum StoreError: LocalizedError {
        case unsupportedVersion(Int)

        var errorDescription: String? {
            switch self {
            case .unsupportedVersion(let version):
                return "Draft storage version \(version) is not supported."
            }
        }
    }
}

/// A small request lock lets the main actor cancel unstarted
/// snapshots without waiting for disk I/O, or dropping the completion of an in-flight write.
private final class DraftWriter {
    final class Request {
        let drafts: StoredDrafts
        let directory: URL
        let write: (StoredDrafts, URL) throws -> Void
        private var completion: ((Result<Void, Error>) -> Void)?
        private var performed = false
        private var cancelled = false
        private var result: Result<Void, Error>?
        private let lock = NSLock()

        init(drafts: StoredDrafts, directory: URL, write: @escaping (StoredDrafts, URL) throws -> Void,
             completion: @escaping (Result<Void, Error>) -> Void) {
            self.drafts = drafts
            self.directory = directory
            self.write = write
            self.completion = completion
        }

        func cancelIfUnstarted() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard !performed else { return false }
            cancelled = true
            completion = nil
            return true
        }

        func claim() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard !performed, !cancelled else { return false }
            performed = true
            return true
        }

        func complete(_ result: Result<Void, Error>) {
            lock.lock()
            defer { lock.unlock() }
            self.result = result
        }

        func takeCompleted() -> (((Result<Void, Error>) -> Void), Result<Void, Error>)? {
            lock.lock()
            defer { lock.unlock() }
            guard let completion, let result else { return nil }
            self.completion = nil
            self.result = nil
            return (completion, result)
        }
    }

    let queue = DispatchQueue(label: "Pilot.draft-persistence", qos: .utility)

    /// DispatchQueue.sync may execute inline on the caller's main thread. Enqueue explicitly
    /// and wait only for the worker, never for a main-actor completion, at durability boundaries.
    func performAndWait(_ request: Request) {
        let finished = DispatchSemaphore(value: 0)
        queue.async { [self] in
            perform(request)
            finished.signal()
        }
        finished.wait()
    }

    func perform(_ request: Request) {
        guard request.claim() else { return }
        request.complete(Result { try request.write(request.drafts, request.directory) })
    }
}

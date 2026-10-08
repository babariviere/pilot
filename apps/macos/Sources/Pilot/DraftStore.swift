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

    init(directory: URL = DraftStore.directory, attachmentDirectory: URL = ImageAttachments.directory) {
        self.directory = directory
        self.attachmentDirectory = attachmentDirectory
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
        if let loadError { throw loadError }
        // Also protect callers that save before explicitly loading.
        if !didLoad { _ = try load() }
        guard drafts.version == 1 else { throw StoreError.unsupportedVersion(drafts.version) }
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

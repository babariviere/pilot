import CryptoKit
import Foundation

public struct StagedAttachmentRef: Codable, Equatable, Sendable {
    public let uploadId: String
    public let sha256: String
    public let bytes: Int
}
public struct AttachmentUpload: Codable, Equatable, Sendable {
    public let uploadId: String
    public let sha256: String
    public let bytes: Int
    public let origin: HostRef
}
public struct AttachmentChatPayload<Request: Codable & Sendable>: Codable, Sendable {
    public let request: Request
    public let attachments: [StagedAttachmentRef]
    public init(request: Request, attachments: [StagedAttachmentRef]) {
        self.request = request; self.attachments = attachments
    }
}
public struct HostedAttachment: Sendable {
    public let host: HostRef
    public let attachment: StagedAttachmentRef
    public init(host: HostRef, attachment: StagedAttachmentRef) { self.host = host; self.attachment = attachment }
}

public enum AttachmentTransfer {
    /// Hash in bounded chunks off the UI thread. Never upload an arbitrary user/workspace path.
    public static func prepare(file: URL, ownedDirectory: URL, uploadId: String, origin: HostRef) async throws -> AttachmentUpload {
        try await Task.detached(priority: .utility) {
            let root = ownedDirectory.standardizedFileURL.resolvingSymlinksInPath().pathComponents
            let canonical = file.standardizedFileURL.resolvingSymlinksInPath()
            guard canonical.pathComponents.count > root.count, canonical.pathComponents.starts(with: root),
                  (try canonical.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else {
                throw HostRoutingError.invalidReference
            }
            let handle = try FileHandle(forReadingFrom: canonical)
            defer { try? handle.close() }
            var hasher = SHA256()
            var size = 0
            while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
                try Task.checkCancellation()
                size += chunk.count
                guard size <= 100 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
                hasher.update(data: chunk)
            }
            return AttachmentUpload(uploadId: uploadId, sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined(),
                                    bytes: size, origin: origin)
        }.value
    }
}

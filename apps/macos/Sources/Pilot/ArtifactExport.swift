import AppKit
import PilotCore
import UniformTypeIdentifiers

/// Materialize the pinned source locally, including when pilotd is on another machine.
/// These files are exports, not paths into the daemon's private artifact store.
enum ArtifactExport {
    struct File {
        let name: String
        let data: Data
        let type: UTType
    }

    static func file(for revision: ArtifactRevision) throws -> File {
        let stem = String(revision.title.unicodeScalars.map {
            CharacterSet.alphanumerics.contains($0) || " -_".unicodeScalars.contains($0) ? String($0) : "_"
        }.joined().prefix(80)).trimmingCharacters(in: .whitespaces)
        let name = stem.isEmpty ? "Artifact" : stem
        switch revision.kind {
        case .html: return File(name: "\(name).html", data: Data(revision.source.utf8), type: .html)
        case .react: return File(name: "\(name).tsx", data: Data(revision.source.utf8),
                                 type: UTType(filenameExtension: "tsx") ?? .data)
        case .swiftui: return File(name: "\(name).swift", data: Data(revision.source.utf8), type: .swiftSource)
        case .image:
            let formats: [(String, String, UTType)] = [
                ("png", "png", .png), ("jpeg", "jpg", .jpeg), ("gif", "gif", .gif), ("webp", "webp", .webP)
            ]
            for (mime, ext, type) in formats {
                let prefix = "data:image/\(mime);base64,"
                if revision.source.hasPrefix(prefix),
                   let data = Data(base64Encoded: String(revision.source.dropFirst(prefix.count))),
                   !data.isEmpty, data.count <= 16 * 1024 * 1024 {
                    return File(name: "\(name).\(ext)", data: data, type: type)
                }
            }
            throw ClientError("Cannot export invalid image data")
        }
    }

    static func materialize(_ revision: ArtifactRevision, directory: URL? = nil) throws -> URL {
        let file = try file(for: revision)
        let root = try directory ?? FileManager.default.url(for: .cachesDirectory, in: .userDomainMask,
                                                            appropriateFor: nil, create: true)
            .appendingPathComponent("Pilot/ArtifactExports", isDirectory: true)
        // Encode IDs rather than trusting server-provided path components.
        func component(_ value: String) -> String { value.utf8.map { String(format: "%02x", $0) }.joined() }
        let folder = root.appendingPathComponent(component(revision.sessionId), isDirectory: true)
            .appendingPathComponent(component(revision.id), isDirectory: true)
            .appendingPathComponent("r\(revision.revision)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(file.name)
        try file.data.write(to: url, options: .atomic)
        return url
    }

    @MainActor static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    @MainActor static func save(_ file: File) throws -> Bool {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = file.name
        panel.allowedContentTypes = [file.type]
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        try file.data.write(to: url, options: .atomic)
        return true
    }
}

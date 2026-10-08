import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

final class PastedImage: Identifiable {
    let id: UUID
    let url: URL
    let preview: NSImage
    private var submitted = false

    init(id: UUID, url: URL, preview: NSImage) {
        self.id = id
        self.url = url
        self.preview = preview
    }

    func retainForHistory() { submitted = true }

    func discard() {
        if !submitted { try? FileManager.default.removeItem(at: url) }
    }

    deinit {
        // Dropping a draft cleans up staged images, never submitted ones.
        if !submitted { try? FileManager.default.removeItem(at: url) }
    }
}

/// Images are copied into app-owned storage, not temporary files or the user's project.
/// Sent files are retained so queued messages and durable history can still read them.
struct ImageAttachments {
    var items: [PastedImage] = []
    var error: String?

    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Pilot/Attachments", isDirectory: true)
    }

    static let pasteboardTypes: [NSPasteboard.PasteboardType] = {
        let preferred: [NSPasteboard.PasteboardType] = [.png, .tiff]
        let supported = (CGImageSourceCopyTypeIdentifiers() as? [String] ?? [])
            .filter { UTType($0)?.conforms(to: .image) == true }
            .map { NSPasteboard.PasteboardType($0) }
        return preferred + supported.filter { !preferred.contains($0) }
    }()

    /// Return false for ordinary text, letting NSTextView perform its normal paste.
    @MainActor
    mutating func paste(from pasteboard: NSPasteboard, directory: URL = Self.directory) -> Bool {
        let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if !urls.isEmpty {
            // Do not turn PDFs into images or silently drop non-images from a mixed selection.
            guard urls.allSatisfy({ (try? $0.resourceValues(forKeys: [.contentTypeKey]).contentType)?.conforms(to: .image) == true }) else {
                return false
            }
        } else if pasteboard.availableType(from: Self.pasteboardTypes) == nil {
            return false
        }
        var saved: [PastedImage] = []
        do {
            let maxBytes = 32 * 1024 * 1024
            let imageItems = (pasteboard.pasteboardItems ?? []).filter { $0.availableType(from: Self.pasteboardTypes) != nil }
            let incomingCount = urls.isEmpty ? imageItems.count : urls.count
            guard items.count + incomingCount <= 8 else { throw ClientError("Attach up to 8 images per message.") }
            var sources: [CGImageSource] = []
            for url in urls {
                guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= maxBytes,
                      let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
                    throw ClientError("The image file could not be read or exceeds 32 MiB.")
                }
                sources.append(source)
            }
            if urls.isEmpty {
                for item in imageItems {
                    guard let type = item.availableType(from: Self.pasteboardTypes) else { continue }
                    guard let data = item.data(forType: type), data.count <= maxBytes,
                          let source = CGImageSourceCreateWithData(data as CFData, nil) else {
                        throw ClientError("The clipboard image could not be read or exceeds 32 MiB.")
                    }
                    sources.append(source)
                }
            }
            guard !sources.isEmpty else { throw ClientError("The clipboard image could not be read.") }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            for source in sources {
                let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
                guard let width = properties?[kCGImagePropertyPixelWidth] as? Int,
                      let height = properties?[kCGImagePropertyPixelHeight] as? Int,
                      width > 0, height > 0, Double(width) * Double(height) <= 24_000_000 else {
                    throw ClientError("Images must be no larger than 24 megapixels.")
                }
                // Normalize EXIF orientation before writing PNG, which no longer has that metadata.
                guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                          kCGImageSourceCreateThumbnailFromImageAlways: true,
                          kCGImageSourceCreateThumbnailWithTransform: true,
                          kCGImageSourceThumbnailMaxPixelSize: max(width, height),
                      ] as CFDictionary),
                      let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]),
                      let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                          kCGImageSourceCreateThumbnailFromImageAlways: true,
                          kCGImageSourceCreateThumbnailWithTransform: true,
                          kCGImageSourceThumbnailMaxPixelSize: 192,
                      ] as CFDictionary) else {
                    throw ClientError("The clipboard image could not be converted to PNG.")
                }
                let id = UUID()
                let url = directory.appendingPathComponent("\(id.uuidString).png")
                try png.write(to: url, options: .atomic)
                saved.append(PastedImage(id: id, url: url, preview: NSImage(cgImage: thumbnail, size: .zero)))
            }
            items.append(contentsOf: saved)
            error = nil
        } catch {
            for image in saved { image.discard() }
            self.error = "Could not save pasted image: \(error.localizedDescription)"
        }
        return true
    }

    mutating func remove(_ id: UUID) {
        guard let image = items.first(where: { $0.id == id }) else { return }
        image.discard()
        items.removeAll { $0.id == id }
    }

    /// A lost HTTP response does not mean the daemon rejected the message. Once attempted,
    /// keep these files even if the restored attachment is removed from the draft.
    func retainForHistory() {
        for image in items { image.retainForHistory() }
    }

    func message(text: String) -> String {
        guard !items.isEmpty else { return text }
        let paths = items.map { "- `\($0.url.path)`" }.joined(separator: "\n")
        let instruction = "Attached images (use the read tool to view these files):\n\(paths)"
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? instruction : "\(trimmed)\n\n\(instruction)"
    }
}

struct ImageAttachmentPreviews: View {
    @Binding var attachments: ImageAttachments

    var body: some View {
        if !attachments.items.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(attachments.items) { image in
                        Image(nsImage: image.preview)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 96, height: 80)
                            .background(Theme.muted, in: RoundedRectangle(cornerRadius: 8))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(alignment: .topTrailing) {
                                Button { attachments.remove(image.id) } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(Theme.foreground, Theme.background)
                                }
                                .buttonStyle(.plain)
                                .padding(3)
                                .help("Remove image")
                                .accessibilityLabel("Remove attached image")
                            }
                            .accessibilityLabel("Attached image")
                    }
                }
                .padding(.vertical, 2)
            }
            .frame(height: 84)
        }
        if let error = attachments.error {
            Text(error).font(.caption).foregroundStyle(Theme.destructive)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

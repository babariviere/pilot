import AppKit
import ImageIO
import PilotCore

/// ImageIO decodes bounded inline bitmaps off-main. Animated images retain their native NSImage
/// representation instead of silently becoming their first frame. The expanded viewer is unchanged.
actor NativeArtifactImage {
    static let shared = NativeArtifactImage()
    final class Result: @unchecked Sendable {
        let image: NSImage
        let natural: CGSize
        init(image: NSImage, natural: CGSize) { self.image = image; self.natural = natural }
    }

    func decode(_ revision: ArtifactRevision, maxSide: Int) throws -> Result {
        let file = try ArtifactExport.file(for: revision)
        guard !Task.isCancelled,
              let source = CGImageSourceCreateWithData(file.data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0 else { throw ClientError("Cannot decode this image") }
        var natural = CGSize(width: width.doubleValue, height: height.doubleValue)
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        if (5...8).contains(orientation) { natural = CGSize(width: natural.height, height: natural.width) }
        if CGImageSourceGetCount(source) > 1, let image = NSImage(data: file.data) {
            image.size = natural
            return Result(image: image, natural: natural)
        }
        guard let bitmap = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(4096, max(1, maxSide)),
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary), !Task.isCancelled else { throw ClientError("Cannot decode this image") }
        return Result(image: NSImage(cgImage: bitmap, size: natural), natural: natural)
    }
}

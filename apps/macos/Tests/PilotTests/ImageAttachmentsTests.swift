import AppKit
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import Pilot

@MainActor
private func clipboardImage() throws -> NSBitmapImageRep {
    let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 3,
                                              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                              isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
    for x in 0..<4 {
        for y in 0..<3 { bitmap.setColor(.systemRed, atX: x, y: y) }
    }
    return bitmap
}

private func imageTestDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("Image Tests \(UUID().uuidString)", isDirectory: true)
}

@Test @MainActor func pngAndTiffPastesSaveReadableUniqueFilesAndKeepTextSeparate() throws {
    let board = NSPasteboard.withUniqueName()
    let directory = imageTestDirectory()
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: directory)
    }
    let bitmap = try clipboardImage()
    var attachments = ImageAttachments()
    for type: NSPasteboard.PasteboardType in [.png, .tiff] {
        board.clearContents()
        let data = try #require(type == .png ? bitmap.representation(using: .png, properties: [:]) : bitmap.tiffRepresentation)
        board.setData(data, forType: type)
        board.setString("Clipboard fallback text", forType: .string)
        #expect((attachments.paste(from: board, directory: directory)) == true)
        #expect(attachments.error == nil)
    }
    #expect(attachments.items.count == 2)
    #expect(Set(attachments.items.map(\.url)).count == 2)
    for item in attachments.items {
        let saved = try #require(NSBitmapImageRep(data: Data(contentsOf: item.url)))
        #expect(saved.pixelsWide == 4 && saved.pixelsHigh == 3)
        #expect(item.url.pathExtension == "png")
        #expect(item.url.path.hasPrefix(directory.path))
        #expect(attachments.message(text: "Explain this").contains(item.url.path))
    }
    #expect(attachments.message(text: " Explain this \n").hasPrefix("Explain this\n\nAttached images"))
    #expect(!attachments.message(text: "Explain this").contains("Clipboard fallback text"))
    #expect(attachments.message(text: " \n").hasPrefix("Attached images"))
    let first = attachments.items[0]
    attachments.remove(first.id)
    #expect(attachments.items.count == 1)
    #expect(!FileManager.default.fileExists(atPath: first.url.path))
    #expect(FileManager.default.fileExists(atPath: attachments.items[0].url.path))
}

@Test @MainActor func copiedImageFilesAreSnapshottedWithoutChangingTheirOriginals() throws {
    let board = NSPasteboard.withUniqueName()
    let directory = imageTestDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: directory)
    }
    let data = try #require(try clipboardImage().representation(using: .png, properties: [:]))
    let originals = [directory.appendingPathComponent("one.png"), directory.appendingPathComponent("two.png")]
    for url in originals { try data.write(to: url) }
    board.writeObjects(originals as [NSURL])
    var attachments = ImageAttachments()
    #expect((attachments.paste(from: board, directory: directory.appendingPathComponent("saved")) == true))
    #expect(attachments.items.count == 2)
    for url in originals { #expect(try Data(contentsOf: url) == data) }
    for url in originals { try FileManager.default.removeItem(at: url) }
    for image in attachments.items { #expect(NSImage(contentsOf: image.url) != nil) }
}

@Test @MainActor func ordinaryTextIsNotConsumedAndImageSaveFailuresAreRecoverable() throws {
    let board = NSPasteboard.withUniqueName()
    let directory = imageTestDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: directory)
    }
    var attachments = ImageAttachments()
    board.setString("normal text", forType: .string)
    #expect((attachments.paste(from: board, directory: directory)) == false)
    #expect(attachments.items.isEmpty && attachments.error == nil)
    #expect(attachments.message(text: " Unchanged \n") == " Unchanged \n")
    board.clearContents()
    board.setData(Data([0, 1, 2]), forType: .png)
    #expect((attachments.paste(from: board, directory: directory)) == true)
    #expect(attachments.error != nil && attachments.items.isEmpty)
    board.clearContents()
    board.setData(try #require(try clipboardImage().representation(using: .png, properties: [:])), forType: .png)
    let notDirectory = directory.appendingPathComponent("file")
    try Data().write(to: notDirectory)
    #expect((attachments.paste(from: board, directory: notDirectory)) == true)
    #expect(attachments.error != nil && attachments.items.isEmpty)
    #expect((attachments.paste(from: board, directory: directory)) == true)
    #expect(attachments.error == nil && attachments.items.count == 1)
}

@Test @MainActor func nativePasteActionsAttachImagesWithoutInsertingTextAndRespectReadOnlyEditors() throws {
    _ = NSApplication.shared
    let board = NSPasteboard.withUniqueName()
    let directory = imageTestDirectory()
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: directory)
    }
    board.setData(try #require(try clipboardImage().representation(using: .png, properties: [:])), forType: .png)
    let editor = SubmitTextView()
    editor.isRichText = false
    editor.string = "My draft"
    var attachments = ImageAttachments()
    editor.onPasteImages = { _ in attachments.paste(from: board, directory: directory) }
    #expect(editor.readablePasteboardTypes.contains(.png))
    #expect(editor.canPasteImageData(from: board))
    editor.paste(nil) // The responder action used by Edit > Paste and Command-V.
    editor.pasteAsPlainText(nil)
    #expect(attachments.items.count == 2)
    #expect(editor.string == "My draft")
    editor.isEditable = false
    #expect(!editor.canPasteImageData(from: board))
    editor.paste(nil)
    editor.pasteAsPlainText(nil)
    #expect(!editor.readSelection(from: board, type: .png))
    #expect(attachments.items.count == 2)
    editor.isEditable = true
    #expect(editor.readSelection(from: board, type: .png))
    #expect(attachments.items.count == 3)
    board.clearContents()
    board.setString(" pasted text", forType: .string)
    #expect(!editor.canPasteImageData(from: board))
    editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
    #expect(editor.readSelection(from: board, type: .string))
    #expect(editor.string == "My draft pasted text")
    #expect(attachments.items.count == 3)
}

@Test @MainActor func imageOnlyComposerMessagesCanSendAndSentFilesSurviveClearingTheDraft() throws {
    let board = NSPasteboard.withUniqueName()
    let directory = imageTestDirectory()
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: directory)
    }
    board.setData(try #require(try clipboardImage().representation(using: .png, properties: [:])), forType: .png)
    let state = ComposerState()
    #expect(!state.canSend(changingModel: false))
    #expect((state.attachments.paste(from: board, directory: directory)) == true)
    #expect(state.canSend(changingModel: false))
    #expect(!state.canSend(changingModel: true))
    let saved = state.attachments
    let message = saved.message(text: state.trimmed)
    state.attachments.retainForHistory()
    state.attachments = ImageAttachments()
    #expect(!state.canSend(changingModel: false))
    #expect(FileManager.default.fileExists(atPath: saved.items[0].url.path))
    #expect(message.contains(saved.items[0].url.path))
    // A failed send restores the saved attachments ahead of any newly pasted images.
    #expect((state.attachments.paste(from: board, directory: directory)) == true)
    state.attachments.items.insert(contentsOf: saved.items, at: 0)
    #expect(state.attachments.items.count == 2)
    #expect(state.attachments.items[0].id == saved.items[0].id)
    #expect(state.canSend(changingModel: false))
    state.attachments.remove(saved.items[0].id)
    #expect(FileManager.default.fileExists(atPath: saved.items[0].url.path))
}

@Test @MainActor func abandonedDraftsDeleteOnlyUnsubmittedImages() throws {
    let board = NSPasteboard.withUniqueName()
    let directory = imageTestDirectory()
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: directory)
    }
    board.setData(try #require(try clipboardImage().representation(using: .png, properties: [:])), forType: .png)
    var staged: ImageAttachments? = ImageAttachments()
    #expect((staged!.paste(from: board, directory: directory)) == true)
    let stagedURL = staged!.items[0].url
    staged = nil
    #expect(!FileManager.default.fileExists(atPath: stagedURL.path))
    var submitted: ImageAttachments? = ImageAttachments()
    #expect((submitted!.paste(from: board, directory: directory)) == true)
    let submittedURL = submitted!.items[0].url
    submitted!.retainForHistory()
    submitted = nil
    #expect(FileManager.default.fileExists(atPath: submittedURL.path))
}

@Test @MainActor func pdfsAndMixedFileSelectionsAreNotConvertedOrPartiallyConsumed() throws {
    _ = NSApplication.shared
    let board = NSPasteboard.withUniqueName()
    let directory = imageTestDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: directory)
    }
    let png = directory.appendingPathComponent("image.png")
    try #require(try clipboardImage().representation(using: .png, properties: [:])).write(to: png)
    let pdf = directory.appendingPathComponent("document.pdf")
    try Data("%PDF-1.4".utf8).write(to: pdf)
    var attachments = ImageAttachments()
    board.writeObjects([pdf as NSURL])
    #expect((attachments.paste(from: board, directory: directory)) == false)
    board.clearContents()
    board.writeObjects([png as NSURL, pdf as NSURL])
    #expect((attachments.paste(from: board, directory: directory)) == false)
    #expect(attachments.items.isEmpty && attachments.error == nil)
    board.setString("copied file paths", forType: .string)
    let editor = SubmitTextView()
    editor.isRichText = false
    editor.onPasteImages = { attachments.paste(from: $0, directory: directory) }
    #expect(editor.readSelection(from: board, type: .fileURL))
    #expect(editor.string == "copied file paths")
    board.clearContents()
    board.setData(Data("%PDF-1.4".utf8), forType: .pdf)
    #expect((attachments.paste(from: board, directory: directory)) == false)
}

@Test @MainActor func attachmentCountLimitDoesNotChangeAnExistingDraft() throws {
    let board = NSPasteboard.withUniqueName()
    let directory = imageTestDirectory()
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: directory)
    }
    board.setData(try #require(try clipboardImage().representation(using: .png, properties: [:])), forType: .png)
    var attachments = ImageAttachments()
    for _ in 0..<8 { #expect((attachments.paste(from: board, directory: directory)) == true) }
    #expect(attachments.items.count == 8 && attachments.error == nil)
    #expect((attachments.paste(from: board, directory: directory)) == true)
    #expect(attachments.items.count == 8 && attachments.error != nil)
    #expect(try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).count == 8)
}

@Test @MainActor func jpegOrientationIsNormalizedInBothSavedFileAndPreview() throws {
    let board = NSPasteboard.withUniqueName()
    let directory = imageTestDirectory()
    defer {
        board.releaseGlobally()
        try? FileManager.default.removeItem(at: directory)
    }
    let bitmap = try clipboardImage()
    let data = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, try #require(bitmap.cgImage), [kCGImagePropertyOrientation: 6] as CFDictionary)
    #expect(CGImageDestinationFinalize(destination))
    board.setData(data as Data, forType: NSPasteboard.PasteboardType(UTType.jpeg.identifier))
    var attachments = ImageAttachments()
    #expect((attachments.paste(from: board, directory: directory)) == true)
    let image = try #require(attachments.items.first)
    let saved = try #require(NSBitmapImageRep(data: Data(contentsOf: image.url)))
    #expect(saved.pixelsWide == 3 && saved.pixelsHigh == 4)
    #expect(image.preview.size.width == 3 && image.preview.size.height == 4)
}

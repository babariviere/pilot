import Foundation
import PilotCore
import Testing
import SwiftUI
@testable import Pilot

private func exportRevision(kind: ArtifactKind, source: String, revision: Int = 1,
                            sessionId: String = "session", title: String = "Saved / artifact") throws -> ArtifactRevision {
    let value: [String: Any] = [
        "id": "../artifact", "sessionId": sessionId, "title": title, "kind": kind.rawValue,
        "revision": revision, "createdAt": 1, "updatedAt": 2, "source": source, "html": "<h1>Preview</h1>",
        "libraries": []
    ]
    return try JSONDecoder().decode(ArtifactRevision.self, from: JSONSerialization.data(withJSONObject: value))
}

@Test func artifactExportsKeepEditableSourceAndUseSafeFilenames() throws {
    for (kind, ext) in [(ArtifactKind.html, "html"), (.react, "tsx"), (.swiftui, "swift")] {
        let source = "Editable source, not the compiled preview 🐦"
        let file = try ArtifactExport.file(for: exportRevision(kind: kind, source: source))
        #expect(file.name == "Saved _ artifact.\(ext)")
        #expect(String(data: file.data, encoding: .utf8) == source)
    }
    #expect(try ArtifactExport.file(for: exportRevision(kind: .html, source: "source", title: "   ")).name == "Artifact.html")
}

@Test func artifactImageExportsDecodeOriginalBytesAndPreserveFormat() throws {
    let bytes = Data([1, 2, 3, 4, 5])
    for (mime, ext) in [("png", "png"), ("jpeg", "jpg"), ("gif", "gif"), ("webp", "webp")] {
        let revision = try exportRevision(kind: .image, source: "data:image/\(mime);base64,\(bytes.base64EncodedString())")
        let file = try ArtifactExport.file(for: revision)
        #expect(file.data == bytes)
        #expect(file.name.hasSuffix(".\(ext)"))
    }
    for invalid in ["file:///etc/passwd", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,!", "data:image/png;base64,"] {
        #expect(throws: ClientError.self) { try ArtifactExport.file(for: exportRevision(kind: .image, source: invalid)) }
    }
}

@Test func artifactFullPathsMaterializePinnedFilesWithoutCrossingSessions() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let pinned = try exportRevision(kind: .html, source: "First", sessionId: "../../session")
    let first = try ArtifactExport.materialize(pinned, directory: root)
    #expect(first.path.hasPrefix(root.path + "/"))
    #expect(try String(contentsOf: first, encoding: .utf8) == "First")
    #expect(try ArtifactExport.materialize(pinned, directory: root) == first)
    let latest = try ArtifactExport.materialize(exportRevision(kind: .html, source: "Second", revision: 2,
                                                              sessionId: "../../session"), directory: root)
    let other = try ArtifactExport.materialize(exportRevision(kind: .html, source: "Other", sessionId: "other"), directory: root)
    #expect(latest != first && other != first && other != latest)
    #expect(try String(contentsOf: first, encoding: .utf8) == "First")
    #expect(try String(contentsOf: latest, encoding: .utf8) == "Second")
    #expect(try String(contentsOf: other, encoding: .utf8) == "Other")
}

@Test @MainActor func artifactScreenshotFailsCleanlyUntilPreviewIsReady() async {
    let state = ArtifactRenderState()
    do {
        _ = try await state.snapshotPNG()
        Issue.record("Unloaded preview must not produce a screenshot")
    } catch { #expect(error.localizedDescription == "Preview is not ready") }
}

@Test @MainActor func artifactHeaderUsesTheLoadedRevisionWithoutASecondBadge() throws {
    let state = ArtifactViewState()
    let render = ArtifactRenderState()
    let reference = ArtifactReference(id: "artifact", sessionId: "session", title: "Preview", revision: 1)
    let pinned = ArtifactViewerHeader(reference: reference, latest: false, state: state, render: render, close: {})
    let latest = ArtifactViewerHeader(reference: reference, latest: true, state: state, render: render, close: {})
    #expect(pinned.revisionText == "Revision 1")
    #expect(latest.revisionText == "Latest revision")
    state.revision = try exportRevision(kind: .swiftui, source: "SwiftUI source", revision: 2)
    #expect(latest.revisionText == "Revision 2")
    #expect(pinned.revisionText == "Revision 2")
}

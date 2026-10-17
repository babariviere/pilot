import Foundation
import Testing
@testable import PilotCore

private let artifactJSON = #"{"id":"a","sessionId":"s","title":"Chart","revision":2}"#

@Test func swiftUIArtifactProtocolRetainsEditableSourceAndNativeLanguage() throws {
    let json = #"{"id":"a","sessionId":"s","title":"Native card","kind":"swiftui","revision":1,"createdAt":1,"updatedAt":2,"source":"struct ArtifactView: View {}","html":"<img src='data:image/png;base64,test'>","libraries":[]}"#
    let revision = try JSONDecoder().decode(ArtifactRevision.self, from: Data(json.utf8))
    #expect(revision.kind == .swiftui)
    #expect(revision.kind.sourceLanguage == "swift")
    #expect(revision.source == "struct ArtifactView: View {}")
    #expect(revision.libraries.isEmpty)
    #expect(try JSONDecoder().decode(ArtifactRevision.self, from: JSONEncoder().encode(revision)) == revision)
    let update = try JSONValue.decode(Data("""
    {"type":"artifacts","sessionId":"s","artifacts":[{"id":"a","sessionId":"s","title":"Native card","kind":"swiftui","revision":1,"createdAt":1,"updatedAt":2}]}
    """.utf8))
    #expect(ArtifactListMessage.parse(update)?.artifacts.first?.kind == .swiftui)
    #expect(ArtifactKind.react.sourceLanguage == "jsx")
    #expect(ArtifactKind.html.sourceLanguage == "html")
}

@Test func imageArtifactProtocolDecodesAndRoundTrips() throws {
    let json = #"{"id":"a","sessionId":"s","title":"Image","kind":"image","revision":1,"createdAt":1,"updatedAt":2,"source":"data:image/png;base64,test","html":"<img>","libraries":[]}"#
    let revision = try JSONDecoder().decode(ArtifactRevision.self, from: Data(json.utf8))
    #expect(revision.kind == .image)
    #expect(revision.libraries.isEmpty)
    #expect(try JSONDecoder().decode(ArtifactRevision.self, from: JSONEncoder().encode(revision)) == revision)
    let update = try JSONValue.decode(Data("""
    {"type":"artifacts","sessionId":"s","artifacts":[{"id":"a","sessionId":"s","title":"Image","kind":"image","revision":1,"createdAt":1,"updatedAt":2}]}
    """.utf8))
    #expect(ArtifactListMessage.parse(update)?.artifacts.first?.kind == .image)
}

@Test func expandedArtifactViewerUsesMostOfTheScreenAndFitsSmallerDisplays() {
    let large = ArtifactViewerLayout.size(available: CGSize(width: 1440, height: 900))
    #expect(large == CGSize(width: 1296, height: 810))
    let small = ArtifactViewerLayout.size(available: CGSize(width: 800, height: 600))
    #expect(small == CGSize(width: 720, height: 540))
    #expect(small.width < 800 && small.height < 600)
    #expect(ArtifactViewerLayout.size(available: CGSize(width: 1440, height: 900), contentSize: CGSize(width: 1650, height: 1400))
            == CGSize(width: 1408, height: 868))
    #expect(ArtifactViewerLayout.size(available: CGSize(width: 1440, height: 900), contentSize: CGSize(width: 240, height: 120)) == large)
}

@Test func expandedArtifactViewerCapsDefaultWidthOnUltrawideDisplays() {
    let ultrawide = CGSize(width: 3840, height: 1000)
    #expect(ArtifactViewerLayout.size(available: ultrawide) == CGSize(width: 1600, height: 900))
    // A viewport-filling measurement after opening must not widen the sheet again.
    #expect(ArtifactViewerLayout.size(available: ultrawide, contentSize: CGSize(width: 1600, height: 400)).width == 1600)
    // Genuinely wide content still grows, up to the screen margin.
    #expect(ArtifactViewerLayout.size(available: ultrawide, contentSize: CGSize(width: 2400, height: 400)).width == 2400)
    #expect(ArtifactViewerLayout.size(available: ultrawide, contentSize: CGSize(width: 5000, height: 400)).width == 3808)
}

@Test func nativeImagePreviewOverridesSavedFullViewportSizingWithoutChangingRevision() throws {
    let html = "<html><body><style>body{padding:0}img{display:block;width:100%;height:100vh;object-fit:contain}</style><img src='data:image/png;base64,test'></body></html>"
    let revision = ArtifactRevision(id: "a", sessionId: "s", projectId: nil, title: "Image", kind: .image,
                                    revision: 1, createdAt: 1, updatedAt: 1, source: "image", html: html, libraries: [])
    let document = ArtifactPreviewDocument.document(revision)
    #expect(document.hasPrefix("<!doctype html><meta http-equiv=\"Content-Security-Policy\""))
    #expect(document.contains("connect-src 'none'"))
    #expect(document.contains(html))
    #expect(document.range(of: html)!.lowerBound < document.range(of: "pilot-artifact-preview-sizing")!.lowerBound)
    #expect(document.contains("width:auto!important;height:auto!important;max-width:100vw!important;max-height:100vh!important"))
    #expect(document.contains("place-items:center!important"))
    #expect(revision.html == html)
}

@Test func nativeSwiftUIPreviewUsesLogicalViewportRatherThanExpandingToViewer() {
    let revision = ArtifactRevision(id: "a", sessionId: "s", projectId: nil, title: "Native", kind: .swiftui,
                                    revision: 1, createdAt: 1, updatedAt: 1, source: "struct ArtifactView: View {}",
                                    html: "<img src='data:image/png;base64,test'>", libraries: [])
    let document = ArtifactPreviewDocument.document(revision)
    #expect(document.contains("width:auto!important;height:auto!important"))
    #expect(document.contains("max-width:min(100vw,var(--pilot-image-width,800px))!important;max-height:min(100vh,var(--pilot-image-height,600px))!important"))
    #expect(!document.contains(revision.source))
}

@Test func nativeHTMLAndReactPreviewsCenterMermaidWithoutChangingOtherSizing() {
    for kind in [ArtifactKind.html, .react] {
        let revision = ArtifactRevision(id: "a", sessionId: "s", projectId: nil, title: "UI", kind: kind,
                                        revision: 1, createdAt: 1, updatedAt: 1, source: "source",
                                        html: "<style>img{width:100%}</style><img><div id='artifact-root'></div>", libraries: [])
        let document = ArtifactPreviewDocument.document(revision)
        #expect(document.contains(":where(.mermaid) > svg{display:block;margin-inline:auto}"))
        #expect(document.contains(":where(body, #artifact-root) > :where(*){margin-inline:auto}"))
        #expect(document.contains(":where(body, #artifact-root) > :where(svg, canvas){display:block}"))
        #expect(document.range(of: "pilot-artifact-diagram-layout")!.lowerBound < document.range(of: revision.html)!.lowerBound)
        #expect(document.contains(revision.html))
        #expect(!document.contains("!important"))
    }
}

@Test func chatArtifactsOverrideOnlyThePageShellWithoutChangingPinnedRevisions() {
    for kind in [ArtifactKind.html, .react, .image, .swiftui] {
        let html = "<style>body{padding:16px;background:white;text-align:center}</style><div style='background:red'>Content</div>"
        let revision = ArtifactRevision(id: "a", sessionId: "s", projectId: nil, title: "Inline", kind: kind,
                                        revision: 1, createdAt: 1, updatedAt: 1, source: "source", html: html, libraries: [])
        let document = ArtifactPreviewDocument.document(revision, inline: true)
        #expect(document.contains("background:transparent!important;margin:0!important;padding:0!important;text-align:left!important"))
        #expect(document.contains("place-items:start!important"))
        #expect(document.contains(":where(.mermaid) > svg{margin-inline:0}"))
        #expect(document.contains(":where(body, #artifact-root) > :where(*){margin-inline:0}"))
        #expect(document.range(of: html)!.lowerBound < document.range(of: "pilot-artifact-chat-layout")!.lowerBound)
        #expect(document.contains("connect-src 'none'"))
        #expect(document.contains("<div style='background:red'>Content</div>"))
        #expect(revision.html == html)
        #expect(!ArtifactPreviewDocument.document(revision).contains("pilot-artifact-chat-layout"))
    }
}

@Test func inlineArtifactPreviewsFillTheReadingColumnAndStayBounded() {
    #expect(ArtifactViewerLayout.inlineColumnWidth == 760)
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 760) == CGSize(width: 760, height: 570))
    // Never wider than the reading column, however wide the window.
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 1200) == CGSize(width: 760, height: 570))
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 1800) == CGSize(width: 760, height: 570))
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: CGFloat.infinity) == CGSize(width: 760, height: 570))
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 320) == CGSize(width: 320, height: 360))
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 0) == CGSize(width: 0, height: 360))
}

@Test func inlineArtifactsHugContentHeightButNeverWidenPastTheColumn() {
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 760, contentSize: CGSize(width: 760, height: 700))
            == CGSize(width: 760, height: 700))
    // Wide content reflows to the column (or scrolls sideways inside); it never widens the card.
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 1800, contentSize: CGSize(width: 1650, height: 600))
            == CGSize(width: 760, height: 600))
    // Taller content stops at the 720 pt ceiling and scrolls inside the card.
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 1000, contentSize: CGSize(width: 1000, height: 1400))
            == CGSize(width: 760, height: 720))
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 760, contentSize: CGSize(width: 5000, height: 9000))
            == CGSize(width: 760, height: 720))
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 760, contentSize: CGSize(width: CGFloat.infinity, height: CGFloat.nan))
            == ArtifactViewerLayout.inlineSize(availableWidth: 760))
}

@Test func measuredInlineArtifactsCanShrinkBelowThePlaceholderWithoutNarrowingTheProseColumn() {
    for width: CGFloat in [320, 760, 1200, 1800] {
        let fallback = ArtifactViewerLayout.inlineSize(availableWidth: width)
        #expect(fallback.height >= 360)
        for height: CGFloat in [1, 48, 120, 240, 1600, 9000] {
            let measured = ArtifactViewerLayout.inlineSize(availableWidth: width, contentSize: CGSize(width: 240, height: height))
            #expect(measured.width == fallback.width)
            #expect(measured.height == min(720, max(48, height)))
        }
        for invalid in [CGSize.zero, CGSize(width: 240, height: -1), CGSize(width: CGFloat.nan, height: 120)] {
            #expect(ArtifactViewerLayout.inlineSize(availableWidth: width, contentSize: invalid) == fallback)
        }
    }
}

@Test func onlyMeasuredHTMLTallerThanTheInlineCeilingScrollsInside() {
    #expect(ArtifactViewerLayout.inlineMaxHeight == 720)
    #expect(!ArtifactViewerLayout.inlineScrollsInside(contentSize: nil))
    #expect(!ArtifactViewerLayout.inlineScrollsInside(contentSize: CGSize(width: 760, height: 720)))
    #expect(ArtifactViewerLayout.inlineScrollsInside(contentSize: CGSize(width: 760, height: 721)))
    #expect(!ArtifactViewerLayout.inlineScrollsInside(contentSize: CGSize(width: 760, height: CGFloat.nan)))
    #expect(!ArtifactViewerLayout.inlineScrollsInside(contentSize: CGSize(width: 760, height: 9000), image: true))
}

@Test func compactMeasurementsAcceptShrinkingContentAndIgnoreHostOnlyChanges() {
    var measurement = ArtifactContentMeasurement()
    #expect(measurement.record(content: CGSize(width: 760, height: 120), viewport: CGSize(width: 760, height: 570))
            == CGSize(width: 760, height: 120))
    #expect(measurement.record(content: CGSize(width: 760, height: 120), viewport: CGSize(width: 760, height: 120))
            == CGSize(width: 760, height: 120))
    #expect(measurement.record(content: CGSize(width: 760, height: 24), viewport: CGSize(width: 760, height: 120))
            == CGSize(width: 760, height: 24))
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 760, contentSize: measurement.preferredSize)
            == CGSize(width: 760, height: 48))
}

@Test func inlineImagesHugTheirAspectFittedSizeWithoutEnlarging() {
    // Tall images shrink to the height ceiling and the card narrows to match, leaving no empty bands.
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 760, contentSize: CGSize(width: 800, height: 1600), image: true)
            == CGSize(width: 360, height: 720))
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 760, contentSize: CGSize(width: 2000, height: 6000), image: true)
            == CGSize(width: 240, height: 720))
    // Wide images are bounded by the reading column.
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 800, contentSize: CGSize(width: 1600, height: 1000), image: true)
            == CGSize(width: 760, height: 475))
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 1800, contentSize: CGSize(width: 1600, height: 1000), image: true)
            == CGSize(width: 760, height: 475))
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 600, contentSize: CGSize(width: 1600, height: 1000), image: true)
            == CGSize(width: 600, height: 375))
    // Small images keep their natural size, with a clickable minimum.
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 1800, contentSize: CGSize(width: 200, height: 100), image: true)
            == CGSize(width: 200, height: 100))
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 1800, contentSize: CGSize(width: 16, height: 16), image: true)
            == CGSize(width: 48, height: 48))
    // Before measurement, images use the default placeholder box.
    #expect(ArtifactViewerLayout.inlineSize(availableWidth: 760, image: true) == ArtifactViewerLayout.inlineSize(availableWidth: 760))
}

@Test func contentMeasurementsIgnoreViewportFeedbackButAcceptRealContentChanges() {
    var measurement = ArtifactContentMeasurement()
    #expect(measurement.record(content: CGSize(width: 1200, height: 752), viewport: CGSize(width: 1200, height: 720))
            == CGSize(width: 1200, height: 752))
    for _ in 0..<5 {
        #expect(measurement.record(content: CGSize(width: 1200, height: 784), viewport: CGSize(width: 1200, height: 752))
                == CGSize(width: 1200, height: 752))
    }
    #expect(measurement.record(content: CGSize(width: 1700, height: 1400), viewport: CGSize(width: 1200, height: 752))
            == CGSize(width: 1700, height: 1400))
    #expect(measurement.record(content: CGSize(width: CGFloat.nan, height: 0), viewport: .zero)
            == CGSize(width: 1700, height: 1400))
}

@Test func intrinsicImageMeasurementsDoNotMistakeNaturalSizeChangesForHostResizing() {
    var measurement = ArtifactContentMeasurement()
    _ = measurement.record(content: CGSize(width: 800, height: 800), viewport: CGSize(width: 800, height: 600), intrinsicImage: true)
    #expect(measurement.record(content: CGSize(width: 800, height: 1000), viewport: CGSize(width: 800, height: 800), intrinsicImage: true)
            == CGSize(width: 800, height: 1000))
}

@Test func detachedArtifactMeasurementsDoNotReplaceTheRetainedSize() {
    var measurement = ArtifactContentMeasurement()
    let content = CGSize(width: 760, height: 1400)
    let measured = measurement.record(content: content, viewport: CGSize(width: 760, height: 720))
    #expect(measured == content)
    for viewport in [CGSize.zero, CGSize(width: 760, height: 0), CGSize(width: 0, height: 720)] {
        let detached = measurement.record(content: CGSize(width: 760, height: 1), viewport: viewport)
        #expect(detached == content)
    }
    let restored = measurement.record(content: content, viewport: CGSize(width: 760, height: 1400))
    #expect(restored == content)
}

@Test func recreatedArtifactsRetainTheirHeightWhileTheDOMRestarts() {
    let saved = CGSize(width: 760, height: 1495)
    let viewport = CGSize(width: 760, height: 1495)
    for _ in 0..<3 {
        var measurement = ArtifactContentMeasurement(retaining: saved)
        // Mermaid can briefly show its source or an incomplete SVG after a lazy remount.
        for height: CGFloat in [1, 316, 1495, 1495] {
            let result = measurement.record(content: CGSize(width: 760, height: height), viewport: viewport)
            #expect(result == saved)
        }
        // This is a startup gate, not a high-water mark: later live content may still shrink.
        let changed = measurement.record(content: CGSize(width: 760, height: 120), viewport: viewport)
        #expect(changed == CGSize(width: 760, height: 120))
    }
}

@Test func restoredArtifactMeasurementsCanSettleAtANewWidth() {
    var measurement = ArtifactContentMeasurement(retaining: CGSize(width: 760, height: 1495))
    let viewport = CGSize(width: 320, height: 1495)
    let content = CGSize(width: 320, height: 2100)
    let pending = measurement.record(content: content, viewport: viewport)
    #expect(pending == CGSize(width: 760, height: 1495))
    let settled = measurement.record(content: content, viewport: viewport)
    #expect(settled == content)
}

@Test func toolArtifactChangesRemainVisibleWithCachedSummaries() {
    let original = ToolItem(id: "call", name: "artifact", arguments: .object(["action": .string("create")]), status: .done, output: "")
    var cached = original
    cached.prepare(summary: original.summary)
    #expect(cached == original)
    cached.artifact = ArtifactReference(id: "a", sessionId: "s", title: "Chart", revision: 1)
    #expect(cached != original)
    let firstRevision = cached
    cached.artifact = ArtifactReference(id: "a", sessionId: "s", title: "Chart", revision: 2)
    #expect(cached != firstRevision)
    #expect(cached.summary == original.summary)
}

@Test func typedArtifactUpdatesDecodeValidAndEmptyReplacementLists() throws {
    let summary = #"{"id":"a","sessionId":"s","projectId":"p","title":"Chart","kind":"react","revision":3,"createdAt":1000,"updatedAt":2000}"#
    for artifacts in ["[\(summary)]", "[]"] {
        let data = Data("{\"type\":\"artifacts\",\"sessionId\":\"s\",\"artifacts\":\(artifacts)}".utf8)
        let parsed = try #require(ArtifactListMessage.parse(JSONValue.decode(data)))
        guard case let .artifacts(update) = try ServerUpdate.decode(data) else {
            Issue.record("Expected a typed artifacts update")
            continue
        }
        #expect(update == parsed)
        #expect(update.sessionId == "s")
        #expect(update.artifacts.count == (artifacts == "[]" ? 0 : 1))
        #expect(update.artifacts.first?.reference.revision == (artifacts == "[]" ? nil : 3))
    }
}

@Test func typedArtifactUpdatesRejectMalformedAndMismatchedOwners() throws {
    let summary = #"{"id":"a","sessionId":"s","title":"Chart","kind":"html","revision":1,"createdAt":1,"updatedAt":2}"#
    for json in [
        #"{"type":"artifacts","artifacts":[]}"#,
        #"{"type":"artifacts","sessionId":"s"}"#,
        #"{"type":"artifacts","sessionId":7,"artifacts":[]}"#,
        #"{"type":"artifacts","sessionId":"s","artifacts":{}}"#,
        #"{"type":"artifacts","sessionId":"s","artifacts":[null]}"#,
        #"{"type":"artifacts","sessionId":"s","artifacts":[{"id":"a","sessionId":"s"}]}"#,
        "{\"type\":\"artifacts\",\"sessionId\":\"other\",\"artifacts\":[\(summary)]}",
        "{\"type\":\"artifacts\",\"sessionId\":\"s\",\"artifacts\":[\(summary),\(summary.replacingOccurrences(of: "\"sessionId\":\"s\"", with: "\"sessionId\":\"other\""))]}",
    ] {
        #expect(try ServerUpdate.decode(Data(json.utf8)) == nil, "Must reject the whole update: \(json)")
    }
}

@Test func artifactReferencesUseStructuredMetadataAndPinRevision() throws {
    for metadata in [
        "\"details\":{\"artifact\":\(artifactJSON)}",
        "\"structuredContent\":{\"artifact\":\(artifactJSON)}",
        "\"details\":{\"__piNativeAdapter\":{\"details\":{\"artifact\":\(artifactJSON)}}}",
        "\"details\":{\"__piNativeAdapter\":{\"structuredContent\":{\"artifact\":\(artifactJSON)}}}",
    ] {
        let json = try JSONValue.decode(Data("{\"role\":\"toolResult\",\"toolCallId\":\"c\",\"content\":[],\(metadata)}".utf8))
        let message = ChatMessage(json: json)
        #expect(message.artifact == ArtifactReference(id: "a", sessionId: "s", title: "Chart", revision: 2))
        var transcript = Transcript()
        transcript.apply(try JSONValue.decode(Data("""
        {"type":"snapshot","entries":[
          {"id":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"artifact","arguments":{"action":"update"}}]}]},
          {"id":2,"kind":"pi.tool-result","model":[\(json.prettyPrinted)]}
        ]}
        """.utf8)))
        guard case let .tools(_, items) = transcript.rows.first?.unfolded.first else { Issue.record("Expected tool card"); continue }
        #expect(items.first?.artifact?.revision == 2)
        #expect(items.first?.status == .done)
    }
}

@Test func artifactReferencesIgnoreTextInvalidAndFailedResults() throws {
    let text = try JSONValue.decode(Data("{\"role\":\"toolResult\",\"content\":\(String(reflecting: artifactJSON))}".utf8))
    #expect(ChatMessage(json: text).artifact == nil)
    for revision in [0, -1] {
        let json = try JSONValue.decode(Data("{\"details\":{\"artifact\":{\"id\":\"a\",\"sessionId\":\"s\",\"title\":\"Chart\",\"revision\":\(revision)}}}".utf8))
        #expect(ArtifactReference.fromToolResult(json) == nil)
    }
    let failed = try JSONValue.decode(Data("{\"role\":\"toolResult\",\"isError\":true,\"details\":{\"artifact\":\(artifactJSON)}}".utf8))
    #expect(ChatMessage(json: failed).artifact == nil)
}

@Test func artifactProtocolAndWebSocketReplacementLists() throws {
    let summary = #"{"id":"a","sessionId":"s","projectId":"p","title":"Chart","kind":"react","revision":3,"createdAt":1000,"updatedAt":2000}"#
    let message = try JSONValue.decode(Data("{\"type\":\"artifacts\",\"sessionId\":\"s\",\"artifacts\":[\(summary)]}".utf8))
    let update = try #require(ArtifactListMessage.parse(message))
    #expect(update.sessionId == "s")
    #expect(update.artifacts.first?.reference.revision == 3)
    let empty = try JSONValue.decode(Data(#"{"type":"artifacts","sessionId":"s","artifacts":[]}"#.utf8))
    #expect(ArtifactListMessage.parse(empty)?.artifacts == [])
    let wrong = try JSONValue.decode(Data("{\"type\":\"artifacts\",\"sessionId\":\"other\",\"artifacts\":[\(summary)]}".utf8))
    #expect(ArtifactListMessage.parse(wrong) == nil)
    #expect(ArtifactListMessage.parse(.object(["type": .string("events")])) == nil)
    let revisionJSON = String(summary.dropLast()) + #", "source":"source", "html":"<html></html>", "libraries":["react","react-dom"]}"#
    let revision = try JSONDecoder().decode(ArtifactRevision.self, from: Data(revisionJSON.utf8))
    #expect(revision.libraries == [.react, .reactDOM])
    #expect(revision.source == "source")
    #expect(try JSONDecoder().decode(ArtifactRevision.self, from: JSONEncoder().encode(revision)) == revision)
}

@Test func artifactSandboxOnlyAllowsCanonicalLibraryURLs() {
    for library in ArtifactLibrary.allCases {
        #expect(ArtifactSandboxPolicy.library(for: URL(string: "pilot-artifact://library/\(library.rawValue)")!) == library)
    }
    for url in ["http://localhost/api/sessions", "https://example.com/react", "file:///tmp/react", "data:text/javascript,alert(1)",
                "pilot-artifact://library/fs", "pilot-artifact://library/react?path=/api/sessions", "pilot-artifact://library/react#x",
                "pilot-artifact://library/react/", "pilot-artifact://library/%72eact", "pilot-artifact://library/../react",
                "pilot-artifact://other/react", "pilot-artifact://library:80/react", "pilot-artifact://user@library/react"] {
        #expect(ArtifactSandboxPolicy.library(for: URL(string: url)!) == nil, "Must deny \(url)")
    }
}

@Test func artifactSandboxPolicyPrecedesUntrustedMarkup() throws {
    let html = "<script>fetch('http://localhost/api/sessions')</script>"
    let document = ArtifactSandboxPolicy.document(html)
    #expect(document.hasPrefix("<!doctype html><meta http-equiv=\"Content-Security-Policy\""))
    #expect(document.contains("connect-src 'none'"))
    #expect(document.contains("form-action 'none'"))
    #expect(document.contains("worker-src 'none'"))
    #expect(document.contains("<meta http-equiv=\"x-dns-prefetch-control\" content=\"off\">"))
    #expect(document.hasSuffix(html))
    #expect(!document.contains("'unsafe-eval'"))
    let rules = try JSONValue.decode(Data(ArtifactSandboxPolicy.contentRules.utf8)).array
    #expect(rules?.count == ArtifactLibrary.allCases.count + 3)
    #expect(rules?.first?["action"]?["type"]?.string == "block")
    #expect(rules?.first?["trigger"]?["url-filter"]?.string == ".*")
    #expect(rules?[1]["trigger"]?["resource-type"]?.array == [.string("script")])
    #expect(rules?.last?["trigger"]?["resource-type"]?.array == [.string("image"), .string("media")])
}

@Test func artifactPublicationRendersLiveAndSnapshotAndDeduplicatesToolCards() throws {
    let publication = "{\"id\":3,\"kind\":\"pilot.artifact\",\"data\":{\"artifact\":\(artifactJSON)},\"model\":[]}"
    let toolEntries = """
    {"id":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"artifact","arguments":{"action":"create"}}]}]},
    {"id":2,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"c","details":{"artifact":\(artifactJSON)}}]}
    """
    var live = Transcript()
    live.apply(try JSONValue.decode(Data("{\"type\":\"snapshot\",\"entries\":[\(toolEntries)]}".utf8)))
    guard case let .tools(_, oldItems) = live.rows.first?.unfolded.first else { Issue.record("Missing fallback"); return }
    #expect(oldItems.first?.artifact?.revision == 2)
    live.apply(try JSONValue.decode(Data("{\"type\":\"entry_appended\",\"entry\":\(publication)}".utf8)))
    #expect(live.rows.count == 2)
    guard case let .tools(_, items) = live.rows.first?.unfolded.first else { Issue.record("Missing tools"); return }
    #expect(items.first?.artifact == nil)
    #expect(live.rows.last == .artifact(id: "3-artifact", reference: ArtifactReference(id: "a", sessionId: "s", title: "Chart", revision: 2)))
    var snapshot = Transcript()
    snapshot.apply(try JSONValue.decode(Data("{\"type\":\"snapshot\",\"entries\":[\(toolEntries),\(publication)]}".utf8)))
    #expect(snapshot.rows == live.rows)
    var codemode = Transcript()
    codemode.apply(try JSONValue.decode(Data("{\"type\":\"entry_appended\",\"entry\":\(publication)}".utf8)))
    #expect(codemode.rows == [live.rows.last!])
    codemode.apply(try JSONValue.decode(Data("{\"type\":\"entry_appended\",\"entry\":\(publication)}".utf8)))
    #expect(codemode.rows.count == 1)
}

@Test func artifactGetMetadataDoesNotPublishAnotherInlineCard() throws {
    for (name, arguments) in [
        ("artifact", #"{"action":"get"}"#),
        ("artifact", #"{"action":"list"}"#),
        ("artifact", #"{"action":"preview"}"#),
        ("artifact", "{}"),
        ("artifact_get", "{}"),
        ("read", "{}"),
        ("artifact_preview", "{}"),
    ] {
        var transcript = Transcript()
        transcript.apply(try JSONValue.decode(Data("""
        {"type":"snapshot","entries":[
          {"id":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"\(name)","arguments":\(arguments)}]}]},
          {"id":2,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"c","details":{"artifact":\(artifactJSON)}}]}
        ]}
        """.utf8)))
        guard case let .tools(_, items) = transcript.rows.first?.unfolded.first else { Issue.record("Missing tools"); continue }
        #expect(items.first?.artifact == nil)
    }
}

@Test func legacyArtifactPublicationToolsStillRenderPinnedCards() throws {
    for name in ["artifact_create", "artifact_update"] {
        var transcript = Transcript()
        transcript.apply(try JSONValue.decode(Data("""
        {"type":"snapshot","entries":[
          {"id":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"\(name)","arguments":{}}]}]},
          {"id":2,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"c","details":{"artifact":\(artifactJSON)}}]}
        ]}
        """.utf8)))
        guard case let .tools(_, items) = transcript.rows.first?.unfolded.first else { Issue.record("Missing tools"); continue }
        #expect(items.first?.artifact?.revision == 2)
    }
}

@Test func artifactNetworkGuardLocksAPIsBeforeUntrustedScripts() {
    for name in ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection", "WebTransport"] {
        #expect(ArtifactSandboxPolicy.networkGuard.contains("'\(name)'"))
    }
    #expect(ArtifactSandboxPolicy.networkGuard.contains("value: undefined, configurable: false, writable: false"))
}

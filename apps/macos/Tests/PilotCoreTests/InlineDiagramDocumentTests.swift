import Foundation
import Testing
@testable import PilotCore

private func bootstrapNonce(_ document: String) -> String? {
    guard let start = document.range(of: "<script nonce=\""),
          let end = document[start.upperBound...].firstIndex(of: "\"") else { return nil }
    return String(document[start.upperBound..<end])
}

@Test func diagramSourceIsBase64EncodedNeverInterpolatedAsMarkupOrJavaScript() {
    let source = "</script><script>window.injected = true</script><svg onload=\"alert('🎨')\">\u{2028}\u{2029}&</svg>"
    for kind in [MarkdownDiagramKind.svg, .mermaid] {
        let document = InlineDiagramDocument.document(kind: kind, source: source)
        #expect(!document.contains(source))
        #expect(!document.contains("window.injected"))
        #expect(document.contains("const sourceBase64 = '\(Data(source.utf8).base64EncodedString())';"))
        #expect(document.contains("new TextDecoder('utf-8', { fatal: true })"))
        #expect(document.components(separatedBy: "<script ").count == 2)
        #expect(document.components(separatedBy: "</script>").count == 2)
    }
}

@Test func diagramCSPOnlyAllowsNoncedBootstrapAndExactRequiredLibrary() throws {
    for kind in [MarkdownDiagramKind.svg, .mermaid] {
        let document = InlineDiagramDocument.document(kind: kind, source: "source")
        #expect(document.hasPrefix("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';"))
        let nonce = try #require(bootstrapNonce(document))
        #expect(nonce.count == 32)
        #expect(document.contains("script-src 'nonce-\(nonce)'\(kind == .mermaid ? " pilot-artifact://library/mermaid" : "");"))
        for directive in ["connect-src", "frame-src", "child-src", "font-src", "object-src", "base-uri", "form-action", "worker-src", "media-src"] {
            #expect(document.contains("\(directive) 'none'"))
        }
        #expect(document.contains("img-src data:;"))
        #expect(document.contains("style-src 'unsafe-inline';"))
        #expect(document.contains("<meta http-equiv=\"x-dns-prefetch-control\" content=\"off\">"))
        #expect(!document.contains("script-src 'unsafe-inline'"))
        #expect(!document.contains("'unsafe-eval'"))
        #expect(!document.contains("blob:"))
        if kind == .svg { #expect(!document.contains("pilot-artifact:")) }
    }
    #expect(bootstrapNonce(InlineDiagramDocument.document(kind: .svg, source: "")) !=
            bootstrapNonce(InlineDiagramDocument.document(kind: .svg, source: "")))
}

@Test func svgValidationIsDetachedAndDisplaysOnlyImageData() {
    let document = InlineDiagramDocument.document(kind: .svg, source: "<svg/>")
    #expect(document.contains("/<!doctype\\b/i.test(svg)"))
    #expect(document.contains("new DOMParser().parseFromString(svg, 'image/svg+xml')"))
    #expect(document.contains("parsed.doctype"))
    #expect(document.contains("getElementsByTagNameNS('*', 'parsererror')"))
    #expect(document.contains("root.localName !== 'svg'"))
    #expect(document.contains("(root.namespaceURI !== null && root.namespaceURI !== 'http://www.w3.org/2000/svg')"))
    #expect(document.contains("if (root.namespaceURI === null) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')"))
    #expect(document.contains("new XMLSerializer().serializeToString(parsed)"))
    #expect(document.contains("return 'data:image/svg+xml;base64,' + btoa(binary)"))
    #expect(!document.contains("innerHTML"))
    #expect(!document.contains("appendChild(root)"))
    #expect(!document.contains("<svg"))
    #expect(document.contains("root.setAttribute('width', '640')"))
    #expect(document.contains("root.setAttribute('height', '360')"))
    #expect(document.contains("root.setAttribute('viewBox', '0 0 640 360')"))
    #expect(document.contains("const relative = value => !value || value.endsWith('%')"))
    #expect(document.contains("if (relative(width) || relative(height))"))
    #expect(document.contains("root.setAttribute('width', String(box[2]))"))
    #expect(document.contains("root.setAttribute('height', String(box[3]))"))
}

@Test func mermaidUsesStrictSecurityAndProtectsNestedHTMLLabelConfig() {
    let document = InlineDiagramDocument.document(kind: .mermaid, source: "graph TD; A-->B")
    #expect(document.contains("script.src = 'pilot-artifact://library/mermaid'"))
    #expect(document.contains("mermaid.initialize({"))
    #expect(document.contains("startOnLoad: false"))
    #expect(document.contains("securityLevel: 'strict'"))
    #expect(document.contains("htmlLabels: false"))
    #expect(document.contains("flowchart: { htmlLabels: false }"))
    #expect(document.contains("secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart']"))
    #expect(document.contains("await mermaid.render('pilot-inline-diagram', source)"))
    #expect(document.contains("svg = result.svg;"))
    #expect(document.contains("xmlns:xlink=\"http://www.w3.org/1999/xlink\""))
    #expect(document.contains("wrapped.documentElement.children.length !== 1"))
    #expect(document.contains("svg = new XMLSerializer().serializeToString(output);"))
    #expect(document.contains("const url = svgImageURL(svg);"))
    #expect(!document.contains("bindFunctions"))
}

@Test func diagramReadinessResolvesAfterImageLoadAndReportsErrorsAndHeight() {
    let document = InlineDiagramDocument.document(kind: .svg, source: "")
    #expect(document.contains("window.pilotDiagramReady = (async () =>"))
    #expect(document.contains("image.onload = resolve;"))
    #expect(document.contains("image.onerror = () => reject(new Error("))
    #expect(document.contains("return { error: null, height: window.pilotDiagramHeight() }"))
    #expect(document.contains("})().catch(error => ({"))
    #expect(document.contains("error: error instanceof Error ? error.message : String(error)"))
    #expect(document.contains("window.pilotDiagramHeight = () => image.getBoundingClientRect().height + 24"))
    #expect(document.contains("body { margin: 0; padding: 12px; background: white; }"))
    #expect(document.contains("img { display: block; max-width: 100%; height: auto; margin: auto; }"))
    #expect(document.contains("color-scheme: light"))
}

@Test func diagramSizeLimitCountsUTF8BytesAndFailsThroughPromiseWithoutEmbeddingSource() {
    for source in [String(repeating: "a", count: 512 * 1024 + 1), String(repeating: "é", count: 256 * 1024 + 1)] {
        let document = InlineDiagramDocument.document(kind: .svg, source: source)
        #expect(document.contains("const oversized = true;"))
        #expect(document.contains("const sourceBase64 = '';"))
        #expect(document.contains("if (oversized) throw new Error('Diagram source exceeds the 512 KB limit.')"))
        #expect(document.utf8.count < 10000)
    }
    let allowed = InlineDiagramDocument.document(kind: .svg, source: String(repeating: "a", count: 512 * 1024))
    #expect(allowed.contains("const oversized = false;"))
}

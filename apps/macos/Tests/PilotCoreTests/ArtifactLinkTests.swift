import Foundation
import Testing
@testable import PilotCore

private let artifactID = "abee494b-d1a8-484c-a57b-669148815d37"

@Test func artifactLinksValidateAndNormalizeOnlyUnpinnedIDs() throws {
    for value in ["artifact://\(artifactID)", "ARTIFACT://\(artifactID.uppercased())"] {
        let url = try #require(URL(string: value))
        let link = try #require(ArtifactLink(url: url))
        #expect(link.id == artifactID)
        #expect(ServiceLink(url: url)?.service == .artifact)
        #expect(ServiceLink(url: url, label: value)?.title == "Artifact · abee494b")
        #expect(ServiceLink(url: url, label: "Layout preview")?.title == "Layout preview")
    }
    for value in ["artifact://missing", "artifact:///\(artifactID)", "artifact://user@\(artifactID)",
                  "artifact://\(artifactID):80", "artifact://\(artifactID)/", "artifact://\(artifactID)/path",
                  "artifact://\(artifactID)?revision=1", "artifact://\(artifactID)#x", "artifact://\(artifactID).evil",
                  "https://\(artifactID)", "pilot-artifact://\(artifactID)"] {
        let url = try #require(URL(string: value))
        #expect(ArtifactLink(url: url) == nil, "\(value)")
        #expect(ServiceLink(url: url) == nil, "\(value)")
    }
}

@Test func artifactDetectionHandlesProseMarkdownAndCodeWithoutChangingWebIndex() throws {
    let url = "artifact://\(artifactID)"
    let source = "🛫 (\(url)), \(url). `\(url)` [Preview](\(url)) [\(url)](https://example.com)"
    let parsed = try AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
    let detected = ServiceLinks.detecting(in: parsed)
    #expect(String(detected.characters) == String(parsed.characters))
    #expect(detected.runs.compactMap(\.link).map(\.absoluteString) == [url, url, url, "https://example.com"])
    #expect(detected.runs.first { ($0.inlinePresentationIntent ?? []).contains(.code) }?.link == nil)
    #expect(ServiceLinks.detecting(in: detected) == detected)
    #expect(ChatLinks.mentions(in: url).isEmpty)
    let literal = ServiceLinks.detecting(in: AttributedString("\(url), https://example.com."))
    #expect(literal.runs.compactMap(\.link).map(\.absoluteString) == [url, "https://example.com"])
    for invalid in ["x\(url)", "artifact://invalid", "\(url)/bad", "\(url)?bad"] {
        #expect(ServiceLinks.detecting(in: AttributedString(invalid)).runs.compactMap(\.link).isEmpty)
    }
}

import Foundation
import Testing
@testable import PilotCore

@Test func serviceLinkLabelsUseNamesAndKeepRepositoryContext() throws {
    func link(_ value: String, _ label: String? = nil) throws -> ServiceLink {
        let url = try #require(URL(string: value))
        return try #require(ServiceLink(url: url, label: label))
    }
    #expect(try link("https://github.com/acme/api/pull/42?tab=files#diff").title == "acme/api#42")
    #expect(try link("https://GitHub.com/acme/api/issues/9").service == .github)
    #expect(try link("https://github.com/acme/api").title == "acme/api")
    #expect(try link("https://github.com/acme/api/blob/main/README.md").title == "acme/api · README.md")
    #expect(try link("https://github.com/acme/api/commit/abcdef123456").title == "acme/api@abcdef1")
    #expect(try link("https://linear.app/acme/issue/eng-42/fix-chat-links").title == "ENG-42 · Fix chat links")
    #expect(try link("https://linear.app/acme/issue/ENG-42").title == "ENG-42")
    #expect(try link("https://linear.app/acme/project/chat-links-0123abcd").title == "Chat links")
    #expect(try link("https://acme.slack.com/archives/C123/p1234567890123456").title == "Slack thread")
    #expect(try link("https://app.slack.com/client/T123/C123").title == "Slack channel")
    #expect(try link("https://github.com/acme/api/pull/42", "#42").title == "#42")
    #expect(try link("https://acme.slack.com/archives/C123/p1234567890123456", "Deploy discussion").title == "Deploy discussion")
    #expect(try link("https://github.com/acme/api/pull/42", "https://github.com/acme/api/pull/42").title == "acme/api#42")
}

@Test func serviceLinkLabelsAreBoundedAndDoNotTrustLookalikeHosts() throws {
    for value in ["https://github.com.evil.test/acme/api/pull/42", "https://notlinear.app/acme/issue/A-1",
                  "https://slack.com.evil.test/archives/C123", "file://github.com/acme/api/pull/42",
                  "https://user@github.com/acme/api/pull/42", "https://github.com:8080/acme/api/pull/42",
                  "https://example.com", "#42"] {
        let url = try #require(URL(string: value))
        #expect(ServiceLink(url: url) == nil)
    }
    let url = try #require(URL(string: "https://github.com/acme/api/pull/42"))
    let link = try #require(ServiceLink(url: url, label: "  Long\n" + String(repeating: "title ", count: 100)))
    #expect(link.title.count == 80)
    #expect(link.title.hasPrefix("Long title"))
    #expect(link.title.hasSuffix("…"))
    #expect(!link.title.contains("\n"))
}

@Test func serviceDetectionKeepsBareTaskNumbersCodeAndExplicitDestinations() throws {
    let source = """
    🛫 Task #42, PR https://github.com/acme/api/pull/42, and https://linear.app/acme/issue/ENG-1/fix-it.
    `https://github.com/acme/api/issues/9` [**Fix it**](https://github.com/acme/api/issues/2)
    [https://github.com/acme/api/pull/5](https://example.com) https://example.com
    """
    let parsed = try AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
    let detected = ServiceLinks.detecting(in: parsed)
    #expect(String(detected.characters) == String(parsed.characters))
    let links = detected.runs.compactMap(\.link).map(\.absoluteString)
    // Foundation also auto-links the bare generic URL. Preserve both generic destinations.
    #expect(links == ["https://github.com/acme/api/pull/42", "https://linear.app/acme/issue/ENG-1/fix-it",
                      "https://github.com/acme/api/issues/2", "https://example.com", "https://example.com"])
    let code = try #require(detected.runs.first { ($0.inlinePresentationIntent ?? []).contains(.code) })
    #expect(code.link == nil)
    #expect(ServiceLinks.detecting(in: detected) == detected)
}

@Test func repeatedServiceURLsRemainSeparateWithPunctuationAndUnicode() {
    let url = "https://github.com/acme/api/pull/42"
    let source = "🧑‍💻 (\(url)), \(url). #42"
    let detected = ServiceLinks.detecting(in: AttributedString(source))
    #expect(String(detected.characters) == source)
    #expect(detected.runs.compactMap(\.link).count == 2)
    #expect(detected.runs.filter { $0.link != nil }.map { String(detected[$0.range].characters) } == [url, url])
}

import Foundation
import Testing
@testable import PilotCore

private let artifactJSON = #"{"id":"a","sessionId":"s","title":"Chart","revision":2}"#

@Test func toolArtifactChangesRemainVisibleWithCachedSummaries() {
    let original = ToolItem(id: "call", name: "artifact_create", arguments: .object([:]), status: .done, output: "")
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
          {"id":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"artifact_update","arguments":{}}]}]},
          {"id":2,"kind":"pi.tool-result","model":[\(json.prettyPrinted)]}
        ]}
        """.utf8)))
        guard case let .tools(_, items) = transcript.rows.first else { Issue.record("Expected tool card"); continue }
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
    {"id":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"artifact_create","arguments":{}}]}]},
    {"id":2,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"c","details":{"artifact":\(artifactJSON)}}]}
    """
    var live = Transcript()
    live.apply(try JSONValue.decode(Data("{\"type\":\"snapshot\",\"entries\":[\(toolEntries)]}".utf8)))
    guard case let .tools(_, oldItems) = live.rows.first else { Issue.record("Missing fallback"); return }
    #expect(oldItems.first?.artifact?.revision == 2)
    live.apply(try JSONValue.decode(Data("{\"type\":\"entry_appended\",\"entry\":\(publication)}".utf8)))
    #expect(live.rows.count == 2)
    guard case let .tools(_, items) = live.rows.first else { Issue.record("Missing tools"); return }
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
    for name in ["artifact_get", "read", "artifact_preview"] {
        var transcript = Transcript()
        transcript.apply(try JSONValue.decode(Data("""
        {"type":"snapshot","entries":[
          {"id":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"\(name)","arguments":{}}]}]},
          {"id":2,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"c","details":{"artifact":\(artifactJSON)}}]}
        ]}
        """.utf8)))
        guard case let .tools(_, items) = transcript.rows.first else { Issue.record("Missing tools"); continue }
        #expect(items.first?.artifact == nil)
    }
}

@Test func artifactNetworkGuardLocksAPIsBeforeUntrustedScripts() {
    for name in ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection", "WebTransport"] {
        #expect(ArtifactSandboxPolicy.networkGuard.contains("'\(name)'"))
    }
    #expect(ArtifactSandboxPolicy.networkGuard.contains("value: undefined, configurable: false, writable: false"))
}

import Foundation
import Testing
@testable import PilotCore

private let visualJSON = #"""
{"id":"v","sessionId":"s","title":"Latency","kind":"visual","revision":3,"createdAt":1792411200000,"updatedAt":2,
 "source":"function visual({ ui, data }) { return () => ui.text(Object.keys(data).join()); }","html":"<p>Open in a newer Pilot</p>",
 "libraries":[],"data":{"zeta":1,"alpha":{"b":[1,"x\"}"],"a":null},"10":true},
 "visual":{"api":1,"engine":"quickjs-ng 0.17.0","check":{"nodes":1,"controls":0,"interactions":0,"logs":[]}}}
"""#

@Test func visualRevisionsDecodeAndKeepTheirDataTextVerbatim() throws {
    let revision = try ArtifactRevision.decoding(Data(visualJSON.utf8))
    #expect(revision.kind == .visual)
    #expect(revision.kind.sourceLanguage == "javascript")
    #expect(revision.visual == ArtifactVisual(api: 1, engine: "quickjs-ng 0.17.0"))
    // The agent's key order survives, which a dictionary would lose.
    #expect(revision.visualDataJSON == Data(#"{"zeta":1,"alpha":{"b":[1,"x\"}"],"a":null},"10":true}"#.utf8))
    #expect(revision.data?["zeta"] == .number(1))
    // Encoding for the inline cache never writes the raw copy.
    let encoded = try JSONEncoder().encode(revision)
    #expect(!String(decoding: encoded, as: UTF8.self).contains("dataJSON"))
    // Without the raw text (an encoded copy), data falls back to its decoded value.
    let reencoded = try JSONDecoder().decode(ArtifactRevision.self, from: encoded)
    #expect(reencoded.dataJSON == nil)
    #expect(try JSONDecoder().decode(JSONValue.self, from: reencoded.visualDataJSON) == revision.data)
}

@Test func otherKindsKeepNoDataText() throws {
    let json = #"{"id":"a","sessionId":"s","title":"Page","kind":"html","revision":1,"createdAt":1,"updatedAt":2,"source":"<p>","html":"<p>","libraries":[]}"#
    let revision = try ArtifactRevision.decoding(Data(json.utf8))
    #expect(revision.dataJSON == nil)
    #expect(revision.visual == nil)
}

@Test func rawJSONMembersComeBackUnchanged() {
    func member(_ name: String, _ json: String) -> String? {
        RawJSONMember.value(of: name, in: Data(json.utf8)).map { String(decoding: $0, as: UTF8.self) }
    }
    #expect(member("data", #"{"data":{"b":1,"a":2}}"#) == #"{"b":1,"a":2}"#)
    #expect(member("data", #" { "x" : "data" , "data" : [ 1 , { "y" : "]" } ] } "#) == #"[ 1 , { "y" : "]" } ]"#)
    #expect(member("data", #"{"d\u0061ta":-1.5e3}"#) == "-1.5e3")
    #expect(member("data", #"{"nested":{"data":1},"data":null}"#) == "null")
    #expect(member("data", #"{"data":"a\"b\\"}"#) == #""a\"b\\""#)
    #expect(member("data", #"{"other":1}"#) == nil)
    #expect(member("data", #"{"data":"#) == nil)
    #expect(member("data", #"{"data":[1,2}"#) == nil)
    #expect(member("data", "[]") == nil)
    #expect(member("data", "") == nil)
}

@Test func visualStateMemoryKeepsTheMostRecentWithinItsBounds() {
    var memory = VisualStateMemory(limit: 3, byteLimit: 40)
    let stored = memory.store("[1]", for: "a")
    let repeated = memory.store("[1]", for: "a")
    #expect(stored)
    #expect(!repeated)
    memory.store("[2]", for: "b")
    memory.store("[3]", for: "c")
    memory.store("[4]", for: "a")
    #expect(memory.entries.map(\.key) == ["b", "c", "a"])
    #expect(memory["a"] == "[4]")
    memory.store("[5]", for: "d")
    #expect(memory["b"] == nil)
    // Bytes bound the total too: one large state evicts older ones, and one beyond the budget is dropped.
    memory.store(String(repeating: "x", count: 30), for: "e")
    #expect(memory.bytes <= 40)
    #expect(memory["e"] != nil)
    memory.store(String(repeating: "y", count: 60), for: "f")
    #expect(memory["f"] == nil)
    #expect(VisualStateMemory(limit: 3, byteLimit: 40, entries: memory.entries) == memory)
}

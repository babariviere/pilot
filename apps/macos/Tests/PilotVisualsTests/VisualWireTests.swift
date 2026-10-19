import Foundation
import PilotVisualsKit
import Testing

struct VisualWireTests {
    @Test func roundTripsEveryKindOfValue() throws {
        let long = String(repeating: "long text ", count: 20)
        let value: VisualValue = [
            "type": "column",
            "children": [
                ["type": "text", "text": "héllo 👋", "size": 1.5],
                ["type": "text", "text": .string(long), "size": -3],
                ["type": "text", "text": .string(long), "flag": true, "none": nil, "off": false],
            ],
            "big": .number(9_007_199_254_740_992),
            "tiny": .number(-0.000_001),
            "empty": [:],
            "list": [],
        ]
        let decoded = try VisualWire.decode(VisualWire.encode(value))
        #expect(decoded == value)
        #expect(decoded["children"]?.arrayValue?[0]["text"]?.stringValue == "héllo 👋")
    }

    @Test func internsRepeatedShortStrings() throws {
        let node: VisualValue = ["type": "text", "text": "same"]
        let many = VisualValue.array(Array(repeating: node, count: 100))
        let data = VisualWire.encode(many)
        // Each node costs eight bytes (object tag and count, then per member a key reference, a string tag and a value
        // reference), not its strings: only the first node spells them out.
        #expect(data.count <= 3 + 2 + 100 * 8 + 2 * "text".utf8.count + "same".utf8.count + "type".utf8.count)
        #expect(try VisualWire.decode(data) == many)
    }

    @Test func keepsStringsBeyondTheInternTable() throws {
        let value = VisualValue.array((0..<5000).map { .string("s\($0)") } + [.string("s4999"), .string("s1")])
        #expect(try VisualWire.decode(VisualWire.encode(value)) == value)
    }

    @Test func rejectsMalformedMessages() {
        #expect(throws: VisualWireError.badHeader) { try VisualWire.decode(Data([0x50, 0x56, 0x02, 0x00])) }
        #expect(throws: VisualWireError.truncated) { try VisualWire.decode(Data([0x50, 0x56, 0x01])) }
        // A string reference before any literal.
        #expect(throws: VisualWireError.malformed) { try VisualWire.decode(Data([0x50, 0x56, 0x01, 0x05, 0x00])) }
        // An array claiming more elements than bytes left.
        #expect(throws: VisualWireError.truncated) {
            try VisualWire.decode(Data([0x50, 0x56, 0x01, 0x06, 0xff, 0xff, 0x03]))
        }
        // A string longer than the message.
        #expect(throws: VisualWireError.truncated) { try VisualWire.decode(Data([0x50, 0x56, 0x01, 0x05, 0x41])) }
        // Trailing bytes.
        #expect(throws: VisualWireError.malformed) { try VisualWire.decode(Data([0x50, 0x56, 0x01, 0x00, 0x00])) }
        // An unknown tag.
        #expect(throws: VisualWireError.malformed) { try VisualWire.decode(Data([0x50, 0x56, 0x01, 0x09])) }
    }

    @Test func rejectsNestingBeyondTheLimit() {
        var bytes: [UInt8] = [0x50, 0x56, 0x01]
        for _ in 0...VisualWire.maxDepth + 1 { bytes += [0x06, 0x01] }
        bytes.append(0x00)
        #expect(throws: VisualWireError.tooDeep) { try VisualWire.decode(Data(bytes)) }
    }

    @Test func writesJSONThatParsesBack() throws {
        let value: VisualValue = ["a": 1, "b": 2.5, "c": "quote \" and \\ and \n and \u{01}", "d": [true, nil]]
        let text = String(decoding: value.jsonData, as: UTF8.self)
        #expect(text == #"{"a":1,"b":2.5,"c":"quote \" and \\ and \n and \u0001","d":[true,null]}"#)
        #expect(try VisualValue(json: value.jsonData) == value)
        #expect(String(decoding: VisualValue.number(.infinity).jsonData, as: UTF8.self) == "null")
    }

    @Test func decodesReplyEnvelopes() {
        let ok = VisualReply.decode(VisualWire.encode(["ok": true, "tree": ["type": "text"], "state": #"{"n":1}"#]))
        #expect(ok == .success(VisualFrame(tree: ["type": "text"], state: Data(#"{"n":1}"#.utf8))))
        let error = VisualReply.decode(VisualWire.encode([
            "ok": false, "error": ["kind": "timeout", "message": "slow", "line": 3],
        ]))
        #expect(error == .failure(.script(VisualScriptError(kind: .timeout, message: "slow", line: 3))))
        #expect(VisualReply.decode(Data("nope".utf8)) == .failure(.invalidReply))
        #expect(VisualReply.decode(VisualReply.error(.unloaded, "gone")).scriptErrorKind == .unloaded)
    }
}

private extension Result where Success == VisualFrame, Failure == VisualFailure {
    var scriptErrorKind: VisualScriptError.Kind? {
        if case .failure(.script(let error)) = self { return error.kind }
        return nil
    }
}

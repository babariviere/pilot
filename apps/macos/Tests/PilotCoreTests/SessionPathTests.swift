import Foundation
import Testing
@testable import PilotCore

@Test func sessionPathDecodingIsBackwardsCompatible() throws {
    let json = #"{"id":"s","title":"Chat","cwd":"/repo","createdAt":1,"updatedAt":2,"state":"idle""#
    let oldInitializer = SessionSummary(id: "s", title: "Chat", cwd: "/repo", createdAt: 1, updatedAt: 2, state: "idle")
    #expect(oldInitializer.sessionPath == nil)
    for suffix in ["}", #", "sessionPath":null}"#] {
        let session = try JSONDecoder().decode(SessionSummary.self, from: Data((json + suffix).utf8))
        #expect(session == oldInitializer)
        let encoded = try JSONEncoder().encode(session)
        let object = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        #expect(object["sessionPath"] == nil)
        #expect(try JSONDecoder().decode(SessionSummary.self, from: encoded) == session)
    }
}

@Test func sessionPathSurvivesRoundTripAndTypedUpdates() throws {
    let session = SessionSummary(id: "s", title: "Chat", cwd: "/repo", createdAt: 1, updatedAt: 2,
                                 state: "parked", sessionPath: "/pilot/sessions/s")
    let encoded = try JSONEncoder().encode(session)
    let object = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
    #expect(object["sessionPath"] as? String == "/pilot/sessions/s")
    #expect(try JSONDecoder().decode(SessionSummary.self, from: encoded) == session)
    let json = String(decoding: encoded, as: UTF8.self)
    let delta = try ServerUpdate.decode(Data("{\"type\":\"session\",\"session\":\(json)}".utf8))
    guard case let .session(decoded) = delta else {
        Issue.record("Expected a typed session update")
        return
    }
    #expect(decoded == session)
    #expect(decoded.sessionPath != decoded.cwd)
    let snapshot = try ServerUpdate.decode(Data("{\"type\":\"sessions\",\"sessions\":[\(json)]}".utf8))
    guard case let .sessions(sessions) = snapshot else {
        Issue.record("Expected a typed sessions snapshot")
        return
    }
    #expect(sessions == [session])
}

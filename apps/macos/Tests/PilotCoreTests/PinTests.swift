import Foundation
import Testing
@testable import PilotCore

private func pinSession(_ id: String = "s", pinned: Bool? = nil, state: String = "idle",
                        archivedAt: Double? = nil) -> SessionSummary {
    SessionSummary(id: id, title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 2,
                   state: state, archivedAt: archivedAt, pinned: pinned)
}

@Test func pinDecodingIsOptionalAndRoundTrips() throws {
    let json = #"{"id":"s","title":"Chat","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"idle""#
    for suffix in ["}", #", "pinned":null}"#] {
        let session = try JSONDecoder().decode(SessionSummary.self, from: Data((json + suffix).utf8))
        #expect(session.pinned == nil)
        #expect(!session.isPinned)
    }
    #expect(!pinSession().isPinned)
    for pinned in [false, true] {
        let session = try JSONDecoder().decode(SessionSummary.self,
                                              from: Data((json + ",\"pinned\":\(pinned)}").utf8))
        #expect(session.pinned == pinned)
        #expect(session.isPinned == pinned)
        #expect(session == pinSession(pinned: pinned))
        #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)
    }
}

@Test func pinDoesNotPreventManualArchiveOrChangeWorkingState() {
    #expect(pinSession(pinned: true).canArchive)
    #expect(pinSession(pinned: true, archivedAt: 3).isArchived)
    for state in ["working", "starting"] {
        let session = pinSession(pinned: true, state: state)
        #expect(session.isPinned)
        #expect(session.isWorking)
        #expect(!session.canArchive)
    }
}

@Test func pinnedSessionSurvivesTypedSnapshotAndDelta() throws {
    let session = pinSession(pinned: true, state: "working")
    let json = String(decoding: try JSONEncoder().encode(session), as: UTF8.self)
    let delta = try ServerUpdate.decode(Data("{\"type\":\"session\",\"session\":\(json)}".utf8))
    guard case let .session(decoded) = delta else { Issue.record("Expected session delta"); return }
    #expect(decoded == session)
    let snapshot = try ServerUpdate.decode(Data("{\"type\":\"sessions\",\"sessions\":[\(json)]}".utf8))
    guard case let .sessions(list) = snapshot else { Issue.record("Expected session snapshot"); return }
    #expect(list == [session])
}

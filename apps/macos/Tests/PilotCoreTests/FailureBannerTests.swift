import Foundation
import Testing
@testable import PilotCore

@Test func persistedFailureUsesExistingBannerWithoutDuplicatingTranscript() {
    let reason = "Model request (example/model): Retryable network error. fetch failed → code=ECONNRESET"
    let session = SessionSummary(id: "failed", title: "Failure", cwd: "/tmp", createdAt: 0,
        updatedAt: 0, state: "parked", outcome: .failed, outcomeAt: 1, outcomeReason: reason)
    var presentation = TranscriptPresentation()
    #expect(presentation.failureBannerText(for: session) == reason)
    presentation.rows = [.error(id: "last", text: reason)]
    #expect(presentation.failureBannerText(for: session) == nil)
    presentation.rows = []
    presentation.error = "live error"
    #expect(presentation.failureBannerText(for: session) == nil)
}

@Test func workingAndSuccessfulChatsDoNotShowOldFailureReasons() {
    let working = SessionSummary(id: "working", title: "Working", cwd: "/tmp", createdAt: 0,
        updatedAt: 0, state: "working", error: "old error", outcome: .failed, outcomeReason: "old reason")
    let done = SessionSummary(id: "done", title: "Done", cwd: "/tmp", createdAt: 0,
        updatedAt: 0, state: "idle", outcome: .done, outcomeReason: "done reason")
    let failed = SessionSummary(id: "failed", title: "Failed", cwd: "/tmp", createdAt: 0,
        updatedAt: 0, state: "failed", error: "startup failed")
    let presentation = TranscriptPresentation()
    #expect(presentation.failureBannerText(for: working) == nil)
    #expect(presentation.failureBannerText(for: done) == nil)
    #expect(presentation.failureBannerText(for: failed) == "startup failed")
}


@Test func startupRetryDecodesForEmptyFailedChatsAndDefaultsOffForOlderDaemons() throws {
    let data = Data("""
    {"id":"failed","title":"Startup failed","cwd":"/tmp","createdAt":0,"updatedAt":1,
     "state":"failed","error":"Session startup: extension dependency missing","canRetryStartup":true}
    """.utf8)
    let session = try JSONDecoder().decode(SessionSummary.self, from: data)
    #expect(session.canRetryStartup == true)
    #expect(TranscriptPresentation().failureBannerText(for: session) == session.error)
    let roundTrip = try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session))
    #expect(roundTrip == session)

    let legacy = Data("""
    {"id":"legacy","title":"Chat","cwd":"/tmp","createdAt":0,"updatedAt":1,"state":"failed"}
    """.utf8)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: legacy).canRetryStartup == nil)
}

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

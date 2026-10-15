import Foundation
import Testing
@testable import PilotCore

private typealias Mark = ReviewRequest.Mark
private enum ReviewFailure: Error { case offline }

@Test(arguments: [SessionOutcome.done, .failed, .stopped])
@MainActor func visibleReviewsForwardOnlyAdvancingOutcomeVersions(outcome: SessionOutcome) async throws {
    let suite = "ReviewForwarderTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let attention = SessionAttention(defaults: defaults)
    var requests: [ReviewRequest] = []
    let forwarder = SessionReviewForwarder { requests.append($0) }
    attention.onReview = { forwarder.review($0) }
    func session(_ id: String, at: Double = 100, state: String = "idle") -> SessionSummary {
        SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: 200,
                       state: state, outcome: outcome, outcomeAt: at)
    }
    #expect(!attention.review(session("inactive"), chatVisible: true, appActive: false))
    #expect(!attention.review(session("hidden"), chatVisible: false, appActive: true))
    #expect(!attention.review(session("working", state: "working"), chatVisible: true, appActive: true))
    #expect(attention.review(session("visible"), chatVisible: true, appActive: true))
    #expect(attention.review(session("other"), chatVisible: true, appActive: true))
    // Leaving the chat regroups it locally; pilotd already stopped counting it when it was read.
    #expect(attention.leave(keeping: nil))
    #expect(!attention.review(session("visible"), chatVisible: true, appActive: true))
    await forwarder.task?.value
    #expect(requests.count == 1)
    #expect(requests[0].marks.sorted { $0.sessionId < $1.sessionId } == [
        Mark(sessionId: "other", outcomeAt: 100), Mark(sessionId: "visible", outcomeAt: 100),
    ])
    #expect(attention.review(session("visible", at: 101), chatVisible: true, appActive: true))
    await forwarder.task?.value
    #expect(requests.last?.marks == [Mark(sessionId: "visible", outcomeAt: 101)])
    #expect(!SessionAttention(defaults: defaults).isUnread(session("visible", at: 101)))
}

@Test @MainActor func launchBackfillUsesOneRequestForTheNewestThousandPersistedMarks() async throws {
    let suite = "ReviewBackfillTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    // Representative large local history. Backfill must not produce a request per old chat.
    defaults.set(Dictionary(uniqueKeysWithValues: (1...10_000).map { ("s\($0)", Double($0)) }),
                 forKey: "pilot.reviewedOutcomeAt")
    let attention = SessionAttention(defaults: defaults)
    let marks = await attention.reviewMarks()
    #expect(marks.count == ReviewRequest.maxMarks)
    #expect(marks.first == Mark(sessionId: "s10000", outcomeAt: 10_000))
    #expect(marks.last == Mark(sessionId: "s9001", outcomeAt: 9001))
    var requests: [ReviewRequest] = []
    let forwarder = SessionReviewForwarder { requests.append($0) }
    await forwarder.connected { marks }
    await forwarder.task?.value
    #expect(requests.count == 1 && requests[0].marks.count == 1000)
    #expect(Set(requests[0].marks.map(\.sessionId)) == Set(marks.map(\.sessionId)))
    func unexpectedBackfill() -> [Mark] {
        Issue.record("Reconnect must not recollect the launch backfill")
        return []
    }
    await forwarder.connected { unexpectedBackfill() }
    await forwarder.task?.value
    #expect(requests.count == 1)
}

@Test @MainActor func failedMarksRetryOnReconnectAndCoalesceToTheirHighWaterMark() async {
    var offline = true
    var requests: [ReviewRequest] = []
    let forwarder = SessionReviewForwarder {
        requests.append($0)
        if offline { throw ReviewFailure.offline }
    }
    await forwarder.connected { [Mark(sessionId: "s", outcomeAt: 100)] }
    await forwarder.task?.value
    #expect(requests.count == 1)
    forwarder.review(Mark(sessionId: "s", outcomeAt: 101))
    forwarder.review(Mark(sessionId: "s", outcomeAt: 99))
    await forwarder.task?.value
    #expect(requests.count == 2)
    offline = false
    await forwarder.connected { [] }
    await forwarder.task?.value
    #expect(requests.count == 3)
    #expect(requests.last?.marks == [Mark(sessionId: "s", outcomeAt: 101)])
    await forwarder.connected { [] }
    #expect(forwarder.task == nil)
}

@Test @MainActor func newerInFlightReviewsSurviveAcknowledgementAndBurstRequestsAreBounded() async throws {
    var release: CheckedContinuation<Void, Never>?
    var requests: [ReviewRequest] = []
    var active = 0
    var maxActive = 0
    let forwarder = SessionReviewForwarder {
        active += 1
        maxActive = max(maxActive, active)
        requests.append($0)
        if requests.count == 1 { await withCheckedContinuation { release = $0 } }
        active -= 1
    }
    forwarder.review(Mark(sessionId: "s", outcomeAt: 100))
    for _ in 0..<100 {
        if release != nil { break }
        await Task.yield()
    }
    let continuation = try #require(release)
    forwarder.review(Mark(sessionId: "s", outcomeAt: 101))
    for index in 1...2000 { forwarder.review(Mark(sessionId: "s\(index)", outcomeAt: Double(index))) }
    continuation.resume()
    await forwarder.task?.value
    #expect(maxActive == 1)
    #expect(requests.count == 4)
    #expect(requests.allSatisfy { $0.marks.count <= ReviewRequest.maxMarks })
    let delivered = requests.dropFirst().flatMap(\.marks)
    #expect(delivered.count == 2001)
    #expect(delivered.contains(Mark(sessionId: "s", outcomeAt: 101)))
}

@Test @MainActor func emptyAndInvalidMarksDoNotStartRequests() async {
    let forwarder = SessionReviewForwarder { _ in Issue.record("No valid marks to send") }
    await forwarder.connected { [] }
    forwarder.review(Mark(sessionId: "s", outcomeAt: .nan))
    forwarder.review(Mark(sessionId: "s", outcomeAt: .infinity))
    #expect(forwarder.task == nil)
}

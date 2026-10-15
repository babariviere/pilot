import Foundation
import Testing
@testable import PilotCore

private let reasonNow = Date(timeIntervalSince1970: 1_000)

@Test func needsYouVocabularyAndBounds() {
    #expect(NeedsYouReason(kind: .failed, detail: "\n boom\ntrace").label(at: 0) == "Failed: boom")
    #expect(NeedsYouReason(kind: .asks, detail: "Ship now?\nOptions").label(at: 0) == "Asks: Ship now?")
    #expect(NeedsYouReason(kind: .mission, detail: "Blocked: Release").label(at: 0) == "Mission: Blocked: Release")
    #expect(NeedsYouReason(kind: .couldntStart, detail: "Project missing").label(at: 0) == "Couldn't start: Project missing")
    #expect(NeedsYouReason(kind: .failed).label(at: 0) == "Failed: The chat failed")
    #expect(NeedsYouReason.firstLine(" \n\t") == nil)
    #expect(NeedsYouReason.firstLine(String(repeating: "x", count: 201)) == String(repeating: "x", count: 199) + "…")
    #expect(NeedsYouReason(kind: .notReviewed).label(at: 995_000, now: reasonNow) == "Not reviewed: finished just now")
    #expect(NeedsYouReason(kind: .notReviewed).label(at: 280_000, now: reasonNow) == "Not reviewed: finished 12m ago")
    #expect(NeedsYouReason(kind: .notReviewed).label(at: .nan, now: reasonNow) == "Not reviewed: finished just now")
}

@Test func reasonFlowsThroughDashboardAndFlatInboxPayloads() throws {
    let data = Data(#"{"projectId":"p","kind":"question","id":"session:s","title":"Chat","sessionId":"s","at":1,"attentionReason":{"kind":"asks","detail":"Deploy?"}}"#.utf8)
    let row = try JSONDecoder().decode(InboxNeedsYouItem.self, from: data)
    #expect(row.item.attentionReason == NeedsYouReason(kind: .asks, detail: "Deploy?"))
    #expect(row.item.needsYouLabel() == "Asks: Deploy?")
    #expect(try JSONDecoder().decode(InboxNeedsYouItem.self, from: JSONEncoder().encode(row)) == row)
    let legacy = DashboardNeedsYouItem(kind: .question, id: "q", title: "Chat", sessionId: "s", reason: "Deploy?", at: 1)
    #expect(legacy.needsYouLabel() == row.item.needsYouLabel())
    let legacyMission = DashboardNeedsYouItem(kind: .question, id: "m", title: "Release", missionId: "m", at: 1)
    #expect(legacyMission.needsYouLabel().hasPrefix("Mission: "))
}

@Test func sidebarReasonsMatchDashboardAndRespectWorkingAndReview() {
    func chat(_ outcome: SessionOutcome, state: String = "idle", detail: String? = nil) -> SessionSummary {
        SessionSummary(id: "s", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: state,
                       outcome: outcome, outcomeAt: 280_000, outcomeReason: detail)
    }
    #expect(chat(.failed, detail: "boom\ntrace").needsYouReason(unread: true)?.label(at: 1) == "Failed: boom")
    #expect(chat(.question, detail: "Where?").needsYouReason(unread: false)?.label(at: 1) == "Asks: Where?")
    #expect(chat(.done).needsYouReason(unread: true)?.label(at: 280_000, now: reasonNow) == "Not reviewed: finished 12m ago")
    #expect(chat(.done).needsYouReason(unread: false) == nil)
    #expect(chat(.failed, state: "working").needsYouReason(unread: true) == nil)
    #expect(chat(.stopped, detail: "Stopped by user").needsYouReason(unread: true)?.kind == .notReviewed)
}

@Test func inboxBadgeSummarizesAllReasonsAndHandlesLegacyCounts() throws {
    let counts = try JSONDecoder().decode(ProjectDashboardCounts.self, from: Data(#"{"projects":{"p":{"working":0,"needsYou":4,"needsYouReasons":{"asks":2,"failed":1,"not_reviewed":1}},"q":{"working":1,"needsYou":2,"needsYouReasons":{"mission":1,"couldnt_start":1}}}}"#.utf8))
    #expect(InboxText.needsYouSummary(Array(counts.projects.values)) == "6 need you: 2 questions, 1 failed, 1 not reviewed, 1 couldn't start, 1 mission")
    #expect(try JSONDecoder().decode(ProjectDashboardCounts.self, from: JSONEncoder().encode(counts)) == counts)
    #expect(InboxText.needsYouSummary([ProjectDashboardCount(needsYou: 1)]) == "1 needs you")
    #expect(InboxText.needsYouSummary([]) == "0 need you")
}

@Test func subscriptionLimitsReadAsLimitReachedWithWhenTheyResume() throws {
    let now = Date(timeIntervalSince1970: 1_781_524_800) // Monday 15 June 2026, 12:00 UTC
    let reset = "2026-06-15T18:00:00Z"
    let resumes = try #require(UsageFormatting.resetDate(reset)).timeIntervalSince1970 * 1000
    #expect(NeedsYouReason(kind: .limit).label(at: 0) == "Limit reached")
    let label = NeedsYouReason(kind: .limit, resumesAt: resumes).label(at: 0, now: now)
    #expect(label == "Limit reached · resumes \(UsageFormatting.clock(Date(timeIntervalSince1970: resumes / 1000), now: now))")
    #expect(label.hasPrefix("Limit reached · resumes at "))
    let decoded = try JSONDecoder().decode(NeedsYouReason.self, from: Data(#"{"kind":"limit","resumesAt":\#(resumes)}"#.utf8))
    #expect(decoded == NeedsYouReason(kind: .limit, resumesAt: resumes))

    func chat(error: String, windows: [SubscriptionWindow] = []) -> SessionSummary {
        SessionSummary(id: "s", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "idle", error: error,
                       usage: SessionUsage(subscription: SubscriptionUsage(fetchedAt: 1, provider: .anthropic, windows: windows)),
                       outcome: .failed)
    }
    let exhausted = chat(error: "Request failed", windows: [SubscriptionWindow(label: "5h", usedPercent: 100, resetsAt: reset)])
    #expect(exhausted.needsYouReason(unread: true, now: now) == NeedsYouReason(kind: .limit, resumesAt: resumes))
    #expect(chat(error: "429 Claude AI usage limit reached").needsYouReason(unread: true, now: now)
        == NeedsYouReason(kind: .limit))
    #expect(chat(error: "Tests failed", windows: [SubscriptionWindow(label: "5h", usedPercent: 99)])
        .needsYouReason(unread: true, now: now)?.kind == .failed)
    #expect(InboxText.needsYouSummary([ProjectDashboardCount(needsYou: 2, needsYouReasons: ["limit": 1, "failed": 1])])
        == "2 need you: 1 failed, 1 limit reached")
}

@Test func missionNeedsYouRowsReuseTheReasonVocabulary() throws {
    let task = MissionTask(id: "t", number: 3, title: "Approve rollout", status: .blocked)
    #expect(MissionNeedsYouItem.blockedTask(task).needsYouLabel() == "Mission: Blocked: #3 Approve rollout")
    let comment = try JSONDecoder().decode(MissionComment.self, from: Data(#"{"id":"c","text":"Ship now?\nDetails","createdAt":1}"#.utf8))
    #expect(MissionNeedsYouItem.comment(comment).needsYouLabel() == "Mission: Ship now?")
    let proposal = try JSONDecoder().decode(MissionDecisionProposal.self, from: Data(#"{"id":"proposal","decisionId":"d1","kind":"edit","reason":"Clarify rollout\nDetails","authorSessionId":"lead","status":"pending","createdAt":1}"#.utf8))
    #expect(MissionNeedsYouItem.decisionProposal(proposal, number: 2).needsYouLabel() == "Mission: Decision D2: Clarify rollout")
    let mission = try JSONDecoder().decode(Mission.self, from: Data(#"{"id":"m","projectId":"p","title":"Release","goal":"Ship","status":"active","briefRevision":0,"needsYouCount":1,"needsYouReason":"Blocked: Approve rollout","createdAt":1,"updatedAt":2}"#.utf8))
    #expect(mission.needsYouReason == "Blocked: Approve rollout")
    #expect(try JSONDecoder().decode(Mission.self, from: JSONEncoder().encode(mission)) == mission)
}

@Test func longJobsNeedTheUserWhileRemainingWorkingAndCannotBeReviewedAway() throws {
    let data = Data(#"{"id":"s","title":"Chat","cwd":"/tmp","createdAt":1,"updatedAt":1,"state":"idle","working":true,"missionId":"m","attentionAt":3601000,"attentionReason":{"kind":"long_job","detail":"Tests has run for 1h"}}"#.utf8)
    let chat = try JSONDecoder().decode(SessionSummary.self, from: data)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(chat)) == chat)
    #expect(chat.isWorking)
    #expect(chat.status == .working)
    #expect(chat.signal(unread: false) == .needsYou)
    #expect(chat.needsYouReason(unread: false)?.label(at: 0) == "Long job: Tests has run for 1h")
    #expect(chat.outcome == nil)
    #expect(chat.visibleOutcomeAt == nil)
    let groups = SidebarUrgency.groups([chat], unread: { _ in false })
    #expect(groups.needsYou == [chat])
    #expect(groups.working.isEmpty)
    let mission = try JSONDecoder().decode(Mission.self, from: Data(#"{"id":"m","projectId":"p","title":"Release","goal":"Ship","status":"active","briefRevision":0,"needsYouCount":0,"createdAt":1,"updatedAt":2}"#.utf8))
    #expect(MissionNeedsYou.count(mission: mission, members: [chat], isUnread: { _ in false }) == 1)
    #expect(MissionNeedsYou.items(mission: mission, detail: nil, members: [chat], isUnread: { _ in false }) == [.chat(chat)])
    #expect(MissionNeedsYouItem.chat(chat).needsYouLabel() == "Long job: Tests has run for 1h")
    #expect(MissionSidebarSummary.signal(mission: mission, members: [chat], isUnread: { _ in false }) == .needsYou)
    #expect(MissionCoordinatorStatus.detail(chat, unread: false) == "Long job: Tests has run for 1h")
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let attention = SessionAttention(defaults: defaults)
    #expect(!attention.review(chat, chatVisible: true, appActive: true))
    #expect(attention.observe([chat], snapshot: true).isEmpty)
    #expect(attention.observe([chat], snapshot: false).isEmpty)
    #expect(chat.signal(unread: false) == .needsYou)

    let row = DashboardNeedsYouItem(kind: .longJob, id: "session:s", title: "Chat", sessionId: "s", at: 3_601_000, attentionReason: chat.attentionReason)
    #expect(row.needsYouLabel() == "Long job: Tests has run for 1h")
    #expect(row.signal == .needsYou)
    #expect(try JSONDecoder().decode(DashboardNeedsYouItem.self, from: JSONEncoder().encode(row)) == row)
    #expect(InboxText.needsYouSummary([ProjectDashboardCount(needsYou: 1, needsYouReasons: ["long_job": 1])]) == "1 needs you: 1 long job")
    let cleared = SessionSummary(id: "s", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle", working: true)
    #expect(cleared.signal(unread: false) == .working)
    #expect(cleared.needsYouReason(unread: false) == nil)
    #expect(MissionNeedsYou.items(mission: mission, detail: nil, members: [cleared], isUnread: { _ in false }).isEmpty)
}

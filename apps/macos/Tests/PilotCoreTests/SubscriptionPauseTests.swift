import Foundation
import Testing
@testable import PilotCore

private let utc = TimeZone(secondsFromGMT: 0)!
private let british = Locale(identifier: "en_GB")
private let pauseNow = Date(timeIntervalSince1970: 1_781_517_600) // 2026-06-15T10:00:00Z

private func decodeSession(_ extra: String = "", state: String = "idle") throws -> SessionSummary {
    try JSONDecoder().decode(SessionSummary.self, from: Data("""
    {"id":"s1","title":"Pause","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"\(state)"\(extra)}
    """.utf8))
}

@Test func subscriptionPauseAndContinuationDecodeAndStayOptional() throws {
    let old = try decodeSession()
    #expect(old.subscriptionPause == nil)
    #expect(old.continuationOf == nil && old.continuedTo == nil)
    #expect(!old.isSubscriptionPaused && !old.isContinued && !old.isReadOnlyHistory)

    let chat = try decodeSession(#"""
    , "subscriptionPause":{"windows":[
      {"provider":"anthropic","label":"5h","usedPercent":97,"resetsAt":"2026-06-15T18:00:00Z"},
      {"provider":"future","label":"Week","usedPercent":96}
    ]},
    "continuationOf":"a", "continuedTo":"b"
    """#)
    let pause = try #require(chat.subscriptionPause)
    #expect(pause.windows.count == 2)
    #expect(pause.windows[0].provider == .anthropic)
    // An unknown provider never breaks the session list.
    #expect(pause.windows[1].provider == nil)
    #expect(!pause.isForced)
    #expect(chat.isSubscriptionPaused)
    #expect(chat.continuationOf == "a")
    #expect(chat.continuedTo == "b")
    #expect(chat.isContinued && chat.isReadOnlyHistory)

    let roundTrip = try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(chat))
    #expect(roundTrip == chat)
}

@Test func heldRunReadsAsPausedButAFinishedChatKeepsItsResult() throws {
    let pause = #", "subscriptionPause":{"windows":[{"provider":"openai","label":"5h","usedPercent":96}]}"#
    // pilotd reports working false while the durable run is still open.
    let held = try decodeSession(pause + #", "working":false, "outcome":"done", "outcomeAt":5"#, state: "working")
    #expect(held.isHeldAtUsageLimit)
    #expect(!held.isWorking)
    #expect(held.status == .usagePaused)
    #expect(held.visibleOutcomeAt == nil)

    // A quota warning on a finished chat does not erase its result or unread state.
    let finished = try decodeSession(pause + #", "outcome":"done", "outcomeAt":5"#, state: "parked")
    #expect(!finished.isHeldAtUsageLimit)
    #expect(finished.status == .done)
    #expect(finished.visibleOutcomeAt == 5)

    // Children on another provider keep the chat working.
    let children = try decodeSession(pause + #", "working":true"#, state: "working")
    #expect(children.isWorking)
    #expect(children.status == .working)

    // Forced work is not paused.
    let forced = try decodeSession(#", "subscriptionPause":{"windows":[{"provider":"openai","label":"5h","usedPercent":98}],"forced":true}, "working":true"#,
                                   state: "working")
    #expect(!forced.isSubscriptionPaused)
    #expect(forced.isWorkingPastUsageLimit)
    #expect(forced.status == .working)
}

@Test func pauseNoticeNamesTheLimitAndWhenWorkResumes() {
    func text(_ pause: SubscriptionPause) -> String {
        pause.notice(now: pauseNow, locale: british, timeZone: utc).text
    }
    let paused = SubscriptionPause(windows: [
        SubscriptionPauseWindow(provider: .anthropic, label: "5h", usedPercent: 97, resetsAt: "2026-06-15T18:00:00Z"),
        SubscriptionPauseWindow(provider: .anthropic, label: "Week", usedPercent: 95, resetsAt: "2026-06-16T09:00:00Z"),
    ])
    // The latest reset decides when work resumes.
    #expect(text(paused) == "Paused at Claude weekly limit · resumes tomorrow at 09:00")
    #expect(paused.notice(now: pauseNow).limited)
    #expect(text(SubscriptionPause(windows: [SubscriptionPauseWindow(provider: .openai, label: "5h", usedPercent: 99)]))
        == "Paused at Codex 5-hour limit · resumes when usage resets")
    #expect(text(SubscriptionPause(windows: [])) == "Paused at usage limit · resumes when usage resets")

    let forced = SubscriptionPause(windows: [SubscriptionPauseWindow(provider: .openai, label: "5h", usedPercent: 97.4)],
                                   forced: true)
    #expect(text(forced) == "Working past usage limit · Codex 5-hour at 97%")
    #expect(!forced.notice(now: pauseNow).limited)
    #expect(paused.helpText.contains("95%"))
    #expect(paused.helpText.contains("Claude 5h: 97% used"))
}

@Test func continuationKindFollowsTheProvider() {
    let models = ModelList(models: [
        ModelOption(id: "anthropic/opus", provider: "anthropic", name: "Opus"),
        ModelOption(id: "anthropic/sonnet", provider: "anthropic", name: "Sonnet"),
        ModelOption(id: "openai-codex/gpt", provider: "openai-codex", name: "GPT"),
    ])
    #expect(ModelContinuation.kind(current: "anthropic/opus", target: "anthropic/sonnet", models: models) == .sameChat)
    #expect(ModelContinuation.kind(current: "anthropic/opus", target: "openai-codex/gpt", models: models) == .newChat)
    // A model missing from the catalog falls back to its ID prefix.
    #expect(ModelContinuation.kind(current: "anthropic/haiku", target: "anthropic/sonnet", models: models) == .sameChat)
    // Never promise the same chat for an unknown current provider.
    #expect(ModelContinuation.kind(current: nil, target: "anthropic/sonnet", models: models) == .newChat)
    #expect(ModelContinuation.kind(current: "bare", target: "anthropic/sonnet", models: models) == .newChat)
    // Same chat needs the configured and the physical provider to match, as in pilotd. A router-configured chat
    // starts fresh even when its last physical usage matches the target.
    #expect(ModelContinuation.kind(current: "router/opus", usageProvider: .openai, target: "openai-codex/gpt",
                                   models: models) == .newChat)
    #expect(ModelContinuation.kind(current: "anthropic/opus", usageProvider: .anthropic, target: "anthropic/sonnet",
                                   models: models) == .sameChat)
    #expect(ModelContinuation.kind(current: "anthropic/opus", usageProvider: .openai, target: "anthropic/sonnet",
                                   models: models) == .newChat)
    #expect(ModelContinuation.kind(current: "bare", usageProvider: .anthropic, target: "anthropic/sonnet",
                                   models: models) == .newChat)
    #expect(ModelContinuation.kind(current: "anthropic/opus", usageProvider: .anthropic, target: "router/x",
                                   models: models) == .newChat)

    #expect(ModelContinuation.sameChat.confirmTitle == "Switch model")
    #expect(ModelContinuation.newChat.confirmTitle == "Start new chat")
    let handoff = ModelContinuation.newChat.explanation(modelName: "GPT")
    #expect(handoff.hasPrefix("Different provider."))
    for phrase in ["new chat", "plain-text", "branch", "pull requests", "tasks", "compaction are not reused", "read-only",
                   ModelContinuation.quotaNote] {
        #expect(handoff.contains(phrase))
    }
    // Same provider shares the quota: switching never promises to get past the limit.
    let same = ModelContinuation.sameChat.explanation(modelName: "Sonnet")
    #expect(same.contains("same subscription limit"))
    #expect(same.contains("waits for the limit to reset unless you force work"))
    #expect(!same.contains("resumes"))
}

@Test func continuationLinksReadAsSentences() {
    #expect(SessionSummary.continuedInLabel("Fix login") == "Continued in Fix login")
    #expect(SessionSummary.continuedInLabel(nil) == "Continued in another chat")
    #expect(SessionSummary.continuedFromLabel("") == "Continued from another chat")
}

@Test func requestBodiesMatchTheDaemonContract() throws {
    let force = try JSONSerialization.jsonObject(with: JSONEncoder().encode(SubscriptionForceRequest(force: true))) as? [String: Bool]
    #expect(force == ["force": true])
    let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ContinueModelRequest(model: "openai-codex/gpt")))
        as? [String: String]
    #expect(body == ["model": "openai-codex/gpt"])
}

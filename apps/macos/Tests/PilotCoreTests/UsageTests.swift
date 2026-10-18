import Foundation
import Testing
@testable import PilotCore

private func decodeUsageSession(_ usage: String = "") throws -> SessionSummary {
    try JSONDecoder().decode(SessionSummary.self, from: Data("""
    {"id":"s1","title":"Usage","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"idle"\(usage)}
    """.utf8))
}

@Test func usageDecodingIsBackwardsCompatible() throws {
    #expect(try decodeUsageSession().usage == nil)
    #expect(try decodeUsageSession(#", "usage":null"#).usage == nil)
    #expect(try decodeUsageSession(#", "usage":{}"#).usage == SessionUsage())
    let session = SessionSummary(id: "s", title: "Old initializer", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "idle")
    #expect(session.usage == nil)
}

@Test func decodesAndRoundTripsBothUsageKinds() throws {
    let session = try decodeUsageSession(#"""
    , "usage": {
      "context":{"tokens":42600,"contextWindow":200000,"percent":21.3},
      "subscription":{"fetchedAt":1710000000123,"provider":"openai","windows":[
        {"label":"5h","usedPercent":34,"resetsAt":"2024-03-09T18:00:00.000Z"},
        {"label":"Week","usedPercent":68}
      ]}
    }
    """#)
    #expect(session.usage?.context == ContextUsage(tokens: 42_600, contextWindow: 200_000, percent: 21.3))
    let subscription = try #require(session.usage?.subscription)
    #expect(subscription.provider == .openai)
    #expect(subscription.windows.count == 2)
    #expect(subscription.windows[0].resetsAt == "2024-03-09T18:00:00.000Z")
    #expect(subscription.windows[1].resetsAt == nil)
    #expect(subscription.fetchedDate?.timeIntervalSince1970 == 1_710_000_000.123)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)
}

@Test func decodesPartialContextAndSubscriptionErrors() throws {
    let session = try decodeUsageSession(#"""
    , "usage": {
      "context":{"contextWindow":200000},
      "subscription":{"fetchedAt":1710000000000,"windows":[],"error":"Sign in required"}
    }
    """#)
    #expect(session.usage?.context?.tokens == nil)
    #expect(session.usage?.context?.percent == nil)
    #expect(session.usage?.subscription?.provider == nil)
    #expect(session.usage?.subscription?.error == "Sign in required")
    let claude = try decodeUsageSession(#", "usage":{"subscription":{"fetchedAt":1,"provider":"anthropic","windows":[]}}"#)
    #expect(claude.usage?.subscription?.providerLabel == "Claude")
}

@Test func AIAccountingKeepsTokensEstimatesAndBilledSpendDistinct() throws {
    let session = try decodeUsageSession(#"""
    , "usage": {"ai": {
      "observedAt":1000,
      "direct":{
        "tokens":{"input":100,"output":20,"cacheRead":80,"cacheWrite":10,"reasoning":5,"reasoningStatus":"reported"},
        "cost":{"estimateStatus":"catalog_estimate","estimatedUsdMicros":12340,"pricingRevision":"pi-ai@1.3.0","billedStatus":"unavailable","subscriptionCoverage":"unknown"},
        "activity":{"kind":"model_requests","count":2,"success":1,"failure":1,"cancelled":0,"usageReports":1,"providerAttemptsObserved":3,"elapsedMsObserved":500,"activeMsObserved":400,"outcomeCoverage":"partial","timingCoverage":"partial"}
      },
      "child":{
        "tokens":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"reasoningStatus":"unavailable"},
        "cost":{"estimateStatus":"unavailable","billedStatus":"unavailable","subscriptionCoverage":"unknown"},
        "activity":{"kind":"child_operations","count":1,"success":1,"failure":0,"cancelled":0,"usageReports":1,"providerAttemptsObserved":1,"elapsedMsObserved":100,"activeMsObserved":80,"outcomeCoverage":"partial","timingCoverage":"partial"}
      },
      "time":{"elapsedMs":3000,"activeMs":1500,"pausedMs":500,"idleMs":1000,"coverage":"daemon_observed_partial"}
    }}
    """#)
    let accounting = try #require(session.usage?.ai)
    #expect(accounting.totalTokenLabel == "225 tokens")
    #expect(accounting.helpText.contains("Reasoning: 5 (included in output, partial reporting)"))
    #expect(accounting.helpText.contains("Estimated cost: At least $0.01234 (partial catalog estimate · pi-ai@1.3.0)"))
    #expect(accounting.helpText.contains("Billed spend: Unavailable"))
    #expect(accounting.helpText.contains("Subscription coverage: Unknown"))
    #expect(accounting.helpText.contains("Provider attempts observed: 4 (partial)"))
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)
}

@Test func formatsContextEstimateWithoutInventingMeasurements() {
    let unknown = ContextUsage(contextWindow: 200_000)
    #expect(unknown.displayedPercent == nil)
    #expect(unknown.gaugeFraction == nil)
    #expect(unknown.percentLabel == "Unknown")
    #expect(unknown.tokenLabel == "Unknown/200k")
    let derived = ContextUsage(tokens: 42_600, contextWindow: 200_000)
    #expect(derived.displayedPercent == 21.3)
    #expect(derived.percentLabel == "21%")
    #expect(derived.tokenLabel == "42.6k/200k")
    #expect(derived.helpText.contains("42600 / 200000"))
    let percentageOnly = ContextUsage(contextWindow: 200_000, percent: 50)
    #expect(percentageOnly.gaugeFraction == 0.5)
    #expect(percentageOnly.tokenLabel == "Unknown/200k")
}

@Test func distinguishesRealZeroAndClampsOnlyTheGauge() {
    let zero = ContextUsage(tokens: 0, contextWindow: 200_000)
    #expect(zero.percentLabel == "0%")
    #expect(zero.tokenLabel == "0/200k")
    #expect(zero.gaugeFraction == 0)
    let over = ContextUsage(tokens: 240_000, contextWindow: 200_000, percent: 123)
    #expect(over.percentLabel == "123%")
    #expect(over.gaugeFraction == 1)
    #expect(ContextUsage(tokens: 10, contextWindow: 0).displayedPercent == nil)
    #expect(ContextUsage(tokens: -1, contextWindow: 100).displayedPercent == nil)
    #expect(ContextUsage(tokens: .infinity, contextWindow: 100, percent: .nan).displayedPercent == nil)
    #expect(UsageFormatting.percent(-1) == "Unknown")
    #expect(UsageFormatting.tokens(.infinity) == "Unknown")
    #expect(UsageFormatting.tokens(1_250_000) == "1.2M")
}

@Test func subscriptionAvailabilityAndProviderLabelsAreHonest() {
    let missing = SubscriptionUsage(fetchedAt: 0, windows: [])
    #expect(missing.providerLabel == "Subscription")
    let failed = SubscriptionUsage(fetchedAt: 0, provider: .anthropic, windows: [], error: "Unauthorized")
    #expect(failed.helpText.contains("Update error: Unauthorized"))
    #expect(failed.helpText.contains("No usage windows reported."))
    let retained = SubscriptionUsage(fetchedAt: 0, provider: .openai,
                                     windows: [SubscriptionWindow(label: "5h", usedPercent: 0)], error: "Timed out")
    #expect(retained.providerLabel == "Codex")
    #expect(retained.windows[0].percentLabel == "0%")
    #expect(retained.helpText.contains("5h: 0% used"))
}

@Test func parsesResetTimesAndDisplaysSnapshotFreshness() throws {
    let whole = try #require(UsageFormatting.resetDate("2024-03-09T18:00:00Z"))
    let fractional = try #require(UsageFormatting.resetDate("2024-03-09T18:00:00.123Z"))
    #expect(abs(fractional.timeIntervalSince(whole) - 0.123) < 0.001)
    #expect(UsageFormatting.resetDate("2024-03-09T19:00:00+01:00") == whole)
    #expect(UsageFormatting.resetDate("not a date") == nil)
    let timestamp = UsageFormatting.timestamp(whole, locale: Locale(identifier: "en_US_POSIX"), timeZone: TimeZone(secondsFromGMT: 0)!)
    #expect(timestamp.replacingOccurrences(of: "\u{202F}", with: " ") == "Mar 9, 2024 at 6:00 PM")
    let usage = SubscriptionUsage(fetchedAt: whole.timeIntervalSince1970 * 1_000, windows: [
        SubscriptionWindow(label: "5h", usedPercent: 12, resetsAt: "2024-03-09T19:00:00Z"),
        SubscriptionWindow(label: "Week", usedPercent: 25),
    ])
    #expect(usage.fetchedDate == whole)
    #expect(usage.helpText.contains("Fetched: \(UsageFormatting.timestamp(whole))"))
    #expect(usage.windows[0].helpText.contains("Resets: \(UsageFormatting.timestamp(whole.addingTimeInterval(3_600)))"))
    #expect(usage.windows[1].helpText == "Week: 25% used. Resets: Unknown")
    #expect(SubscriptionWindow(label: "Week", usedPercent: 1, resetsAt: "invalid").helpText.contains("Unknown (invalid)"))
    #expect(SubscriptionUsage(fetchedAt: .nan, windows: []).helpText.contains("Fetched: Unknown"))
}

@Test func oldSnapshotsStayVisibleButAreMarkedNotRecent() {
    let fetched = Date(timeIntervalSince1970: 1_000)
    let usage = SubscriptionUsage(fetchedAt: fetched.timeIntervalSince1970 * 1_000, provider: .anthropic,
                                  windows: [SubscriptionWindow(label: "5h", usedPercent: 12)])
    let recent = fetched.addingTimeInterval(SubscriptionUsage.staleAfter)
    #expect(!usage.isStale(now: recent))
    #expect(usage.displayHelpText(now: recent) == usage.helpText)
    let old = recent.addingTimeInterval(1)
    #expect(usage.isStale(now: old))
    #expect(usage.displayHelpText(now: old).contains("Not updated recently"))
    #expect(!SubscriptionUsage(fetchedAt: .nan, windows: []).isStale(now: old))
}

@Test func providerNames() {
    #expect(SubscriptionProvider.openai.displayName == "Codex")
    #expect(SubscriptionProvider.anthropic.displayName == "Claude")
}

@Test func subscriptionGaugesClampOnlyTheirDrawing() {
    let zero = SubscriptionWindow(label: "5h", usedPercent: 0)
    #expect(zero.gaugeFraction == 0)
    #expect(zero.percentLabel == "0%")
    #expect(SubscriptionWindow(label: "Week", usedPercent: 45).gaugeFraction == 0.45)
    let overflow = SubscriptionWindow(label: "Week", usedPercent: 123)
    #expect(overflow.gaugeFraction == 1)
    #expect(overflow.percentLabel == "123%")
    #expect(UsageFormatting.gaugeFraction(.nan) == nil)
    #expect(UsageFormatting.gaugeFraction(-1) == nil)
}

private let utc = TimeZone(secondsFromGMT: 0)!
private let british = Locale(identifier: "en_GB")
/// Monday 15 June 2026, 12:00 UTC.
private let usageNow = Date(timeIntervalSince1970: 1_781_524_800)

@Test func clockPhrasesReadAsPartOfASentence() {
    func clock(_ offset: TimeInterval) -> String {
        UsageFormatting.clock(usageNow.addingTimeInterval(offset), now: usageNow, locale: british, timeZone: utc)
    }
    #expect(clock(6 * 3_600) == "at 18:00")
    #expect(clock(21 * 3_600) == "tomorrow at 09:00")
    #expect(clock(3 * 86_400) == "on Thu at 12:00")
    #expect(clock(10 * 86_400) == "on 25 Jun at 12:00")
}

@Test func chatsMentionSubscriptionUsageOnlyPast80PercentOrWhenLimited() {
    func notice(_ windows: [SubscriptionWindow], provider: SubscriptionProvider = .anthropic) -> String? {
        SubscriptionUsage(fetchedAt: usageNow.timeIntervalSince1970 * 1_000, provider: provider, windows: windows)
            .notice(now: usageNow, locale: british, timeZone: utc)?.text
    }
    #expect(notice([SubscriptionWindow(label: "5h", usedPercent: 79.4), SubscriptionWindow(label: "Week", usedPercent: 12)]) == nil)
    #expect(notice([SubscriptionWindow(label: "5h", usedPercent: 86, resetsAt: "2026-06-15T18:00:00Z")])
        == "Claude 5-hour limit at 86% · resets at 18:00")
    // The most used window wins; a used-up one reads as reached.
    #expect(notice([SubscriptionWindow(label: "5h", usedPercent: 82),
                    SubscriptionWindow(label: "Week", usedPercent: 100, resetsAt: "2026-06-16T09:00:00Z")], provider: .openai)
        == "Codex weekly limit reached · resets tomorrow at 09:00")
    // Extra-usage spend and windows that already reset are not limits.
    #expect(notice([SubscriptionWindow(label: "Extra [on] 190.00/200.00", usedPercent: 95)]) == nil)
    #expect(notice([SubscriptionWindow(label: "5h", usedPercent: 100, resetsAt: "2026-06-15T11:00:00Z")]) == nil)
    let limited = SubscriptionUsage(fetchedAt: 1, provider: .anthropic, windows: [SubscriptionWindow(label: "5h", usedPercent: 100)])
        .notice(now: usageNow)
    #expect(limited?.limited == true && limited?.text == "Claude 5-hour limit reached")
    #expect(limited?.help.contains("Not updated recently") == true)
}

@Test func windowLabelsForSentencesAndBars() {
    #expect(SubscriptionWindow(label: "5h", usedPercent: 1).limitName == "5-hour")
    #expect(SubscriptionWindow(label: "5h", usedPercent: 1).columnLabel == "5-hour")
    #expect(SubscriptionWindow(label: "Week", usedPercent: 1).limitName == "weekly")
    #expect(SubscriptionWindow(label: "Week", usedPercent: 1).columnLabel == "Weekly")
    #expect(SubscriptionWindow(label: "Session", usedPercent: 1).limitName == "session")
    let usage = SubscriptionUsage(fetchedAt: 1, windows: [SubscriptionWindow(label: "5h", usedPercent: 1),
                                                          SubscriptionWindow(label: "Extra [on] 1.00/200.00", usedPercent: 1)])
    #expect(usage.limitWindows.map(\.label) == ["5h"])
    #expect(usage.homeWindows.map(\.columnLabel) == ["5-hour", "Extra"])
}

@Test func extraUsageShowsSpendAgainstItsCap() throws {
    let capped = SubscriptionWindow(label: "Extra [on] 46.17/200.00", usedPercent: 23.085)
    let extra = try #require(capped.extraUsage)
    #expect(extra == SubscriptionWindow.ExtraUsage(spent: "46.17", cap: "200.00", active: false))
    #expect(capped.valueLabel == "46.17/200")
    #expect(capped.helpText == "Extra usage: 46.17 of 200.00 spent (23%)")
    let active = SubscriptionWindow(label: "Extra [active] 12.00", usedPercent: 0)
    #expect(active.extraUsage == SubscriptionWindow.ExtraUsage(spent: "12.00", cap: nil, active: true))
    #expect(active.valueLabel == "12")
    #expect(active.helpText.hasSuffix("In use now."))
    #expect(SubscriptionWindow(label: "5h", usedPercent: 5).extraUsage == nil)
    #expect(SubscriptionWindow(label: "5h", usedPercent: 5).valueLabel == "5%")
}

@Test func homeUsageColumnsLineUpWindowKindsAcrossProviders() {
    let codex = SubscriptionUsage(fetchedAt: 1, provider: .openai, windows: [SubscriptionWindow(label: "Week", usedPercent: 29),
                                                                             SubscriptionWindow(label: "Session", usedPercent: 3)])
    let claude = SubscriptionUsage(fetchedAt: 1, provider: .anthropic, windows: [
        SubscriptionWindow(label: "Week", usedPercent: 17), SubscriptionWindow(label: "5h", usedPercent: 62),
        SubscriptionWindow(label: "Extra [on] 1.00/200.00", usedPercent: 1),
    ])
    #expect(SubscriptionUsage.columns([codex, claude]) == ["5-hour", "Weekly", "Session", "Extra"])
    #expect(codex.window(inColumn: "5-hour") == nil)
    #expect(codex.window(inColumn: "Extra") == nil)
    #expect(claude.window(inColumn: "Extra")?.valueLabel == "1/200")
    #expect(codex.window(inColumn: "Weekly")?.usedPercent == 29)
    #expect(claude.window(inColumn: "5-hour")?.usedPercent == 62)
    #expect(SubscriptionUsage.columns([]).isEmpty)
}

@Test func chatModelNamesUseTheCatalogAndFallbackToTheId() throws {
    let list = ModelList(models: [ModelOption(id: "anthropic/claude-sonnet-5", provider: "anthropic", name: "Claude Sonnet 5")])
    #expect(list.displayName(for: "anthropic/claude-sonnet-5") == "Claude Sonnet 5")
    #expect(list.displayName(for: "openai-codex/gpt-6.1-sol") == "gpt-6.1-sol")
    #expect(list.displayName(for: nil) == "Model")
    let request = ChangeModelRequest(model: "anthropic/claude-sonnet-5")
    let decoded = try JSONDecoder().decode(ChangeModelRequest.self, from: JSONEncoder().encode(request))
    #expect(decoded.model == request.model)
}

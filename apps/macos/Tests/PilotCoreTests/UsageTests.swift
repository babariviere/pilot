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
    #expect(missing.availabilityLabel == "No limits reported")
    let failed = SubscriptionUsage(fetchedAt: 0, provider: .anthropic, windows: [], error: "Unauthorized")
    #expect(failed.availabilityLabel == "Unavailable")
    #expect(failed.helpText.contains("Update error: Unauthorized"))
    #expect(failed.helpText.contains("No usage windows reported."))
    let retained = SubscriptionUsage(fetchedAt: 0, provider: .openai,
                                     windows: [SubscriptionWindow(label: "5h", usedPercent: 0)], error: "Timed out")
    #expect(retained.providerLabel == "Codex")
    #expect(retained.availabilityLabel == "Update failed")
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

@Test func providerlessEmptySnapshotClearsSubscriptionWithoutTakingSpace() {
    let cleared = SubscriptionUsage(fetchedAt: 1_710_000_000_000, windows: [])
    #expect(!cleared.hasDisplayData)
    #expect(!SessionUsage(subscription: cleared).hasDisplayData)
    #expect(!SessionUsage().hasDisplayData)
    #expect(SessionUsage(context: ContextUsage(contextWindow: 200_000), subscription: cleared).hasDisplayData)
    #expect(SubscriptionUsage(fetchedAt: 0, provider: .openai, windows: []).hasDisplayData)
    #expect(SubscriptionUsage(fetchedAt: 0, windows: [], error: "Unavailable").hasDisplayData)
    #expect(SubscriptionUsage(fetchedAt: 0, windows: [SubscriptionWindow(label: "5h", usedPercent: 12)]).hasDisplayData)
}

@Test func missingSubscriptionShowsAnHonestProviderFallback() {
    let missing = SessionUsage()
    #expect(missing.fallbackSubscriptionProvider(model: "openai-codex/gpt-6.1-sol") == .openai)
    #expect(missing.fallbackSubscriptionProvider(model: "anthropic/claude-sonnet-5") == .anthropic)
    #expect(SubscriptionProvider.openai.displayName == "Codex")
    #expect(SubscriptionProvider.anthropic.displayName == "Claude")
    #expect(SubscriptionProvider.openai.unavailableHelpText.contains("No usage snapshot is available."))
    #expect(!SubscriptionProvider.openai.unavailableHelpText.contains("0%"))
    let contextOnly = SessionUsage(context: ContextUsage(tokens: 0, contextWindow: 200_000))
    #expect(contextOnly.fallbackSubscriptionProvider(model: "openai-codex/gpt-6.1-sol") == .openai)
    for model in [nil, "", "openai/gpt-6", "router/auto", "custom/claude", "claude-sonnet-5"] {
        #expect(missing.fallbackSubscriptionProvider(model: model) == nil)
    }
}

@Test func realOrClearedSnapshotsNeverUseAModelFallback() {
    for subscription in [
        SubscriptionUsage(fetchedAt: 1, windows: []),
        SubscriptionUsage(fetchedAt: 1, provider: .anthropic, windows: []),
        SubscriptionUsage(fetchedAt: 1, windows: [], error: "Sign in required"),
        SubscriptionUsage(fetchedAt: 1, provider: .openai, windows: [SubscriptionWindow(label: "5h", usedPercent: 0)]),
    ] {
        #expect(SessionUsage(subscription: subscription).fallbackSubscriptionProvider(model: "openai-codex/gpt-6.1-sol") == nil)
    }
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

@Test func chatModelNamesUseTheCatalogAndFallbackToTheId() throws {
    let list = ModelList(models: [ModelOption(id: "anthropic/claude-sonnet-5", provider: "anthropic", name: "Claude Sonnet 5")])
    #expect(list.displayName(for: "anthropic/claude-sonnet-5") == "Claude Sonnet 5")
    #expect(list.displayName(for: "openai-codex/gpt-6.1-sol") == "gpt-6.1-sol")
    #expect(list.displayName(for: nil) == "Model")
    let request = ChangeModelRequest(model: "anthropic/claude-sonnet-5")
    let decoded = try JSONDecoder().decode(ChangeModelRequest.self, from: JSONEncoder().encode(request))
    #expect(decoded.model == request.model)
}

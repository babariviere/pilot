import Foundation
import PilotCore
import Testing

@Test func telemetrySettingsDecodeIndependentHostScopedControls() throws {
    let data = Data(#"""
    {"schemaVersion":1,"hostKind":"devbox","hostId":"abcdefghijklmnopqrstuv",
     "localDiagnostics":true,"remoteOperational":false,"productAnalytics":true,
     "endpoint":"https://collector.example/v1/traces",
     "aiUsageBudget":{"basis":"catalog_estimate","limitUsdMicros":2500000,"window":"retained_chat"},
     "updatedAt":"2026-10-17T10:00:00.000Z"}
    """#.utf8)
    let settings = try JSONDecoder().decode(TelemetrySettings.self, from: data)
    #expect(settings.hostKind == .devbox)
    #expect(settings.localDiagnostics)
    #expect(!settings.remoteOperational)
    #expect(settings.productAnalytics)
    #expect(settings.analyticsId == nil)
    #expect(settings.aiUsageBudget == AIUsageBudget(basis: .catalogEstimate, limitUsdMicros: 2_500_000))
}

@Test func telemetryPatchEncodesOnlyReviewedFields() throws {
    let patch = TelemetrySettingsPatch(localDiagnostics: false, remoteOperational: false,
                                       productAnalytics: false, endpoint: nil)
    let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
    #expect(Set(object.keys) == ["localDiagnostics", "remoteOperational", "productAnalytics", "aiUsageBudget"])
    #expect(object["aiUsageBudget"] is NSNull)

    let configured = TelemetrySettingsPatch(
        localDiagnostics: true, remoteOperational: false, productAnalytics: false,
        aiUsageBudget: AIUsageBudget(basis: .billed, limitUsdMicros: 1)
    )
    let configuredObject = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder().encode(configured)) as? [String: Any]
    )
    #expect((configuredObject["aiUsageBudget"] as? [String: Any])?["basis"] as? String == "billed")
}

@Test func informationalBudgetComparisonKeepsCoverageAndSubscriptionSemantics() throws {
    let comparison = try JSONDecoder().decode(AIUsageBudgetComparison.self, from: Data(#"""
    {"basis":"catalog_estimate","limitUsdMicros":1000000,"window":"retained_chat",
     "comparison":"indeterminate","observedUsdMicros":500000,"coverage":"partial_retained_usage",
     "subscriptionCoverage":"unknown","informational":true}
    """#.utf8))
    #expect(comparison.basis == .catalogEstimate)
    #expect(comparison.comparison == "indeterminate")
    #expect(comparison.coverage == "partial_retained_usage")
    #expect(comparison.subscriptionCoverage == "unknown")
    #expect(comparison.informational)
}

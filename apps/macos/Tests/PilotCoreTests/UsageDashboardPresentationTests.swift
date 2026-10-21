import Foundation
import Testing
@testable import PilotCore

@Test func usageDashboardNumbersPreserveUnknownPartialOverflowAndExplicitZero() {
    let unknown = UsageMetric(value: nil, known: 0, unknown: 2, partial: 0, overflow: false)
    let zero = UsageMetric(value: 0, known: 1, unknown: 0, partial: 0, overflow: false)
    let partial = UsageMetric(value: 1234, known: 1, unknown: 1, partial: 1, overflow: false)
    let overflow = UsageMetric(value: nil, known: 2, unknown: 0, partial: 0, overflow: true)
    #expect(UsageDashboardPresentation.number(nil) == "Unknown")
    #expect(UsageDashboardPresentation.number(unknown) == "Unknown")
    #expect(UsageDashboardPresentation.number(zero) == "0")
    #expect(UsageDashboardPresentation.number(zero, currency: true) == "≈ $0.0000")
    #expect(UsageDashboardPresentation.number(partial, currency: true) == "≈ $0.001234 · partial")
    #expect(UsageDashboardPresentation.estimate(1) == "≈ $0.000001")
    #expect(UsageDashboardPresentation.number(overflow) == "Overflow")
    #expect(UsageDashboardPresentation.coverage(partial) == "1 known · 1 unknown · 1 incomplete")
}

@Test func usageDashboardCacheDenominatorExcludesWritesAndReasoningIsNotAdded() {
    func aggregate(_ input: Double?, unknown: Int = 0) -> UsageAggregate {
        UsageAggregate(records: 1, committed: 1, partial: 0, legacy: 0, unpriced: 0, partialPriced: 0,
                       pricingVersions: 1, pricingRevision: "fixture", metrics: [
                        "input": .init(value: input, known: input == nil ? 0 : 1, unknown: unknown, partial: 0, overflow: false),
                        "output": .init(value: 20, known: 1, unknown: 0, partial: 0, overflow: false),
                        "cacheRead": .init(value: 400, known: 1, unknown: 0, partial: 0, overflow: false),
                        "cacheWrite": .init(value: 9000, known: 1, unknown: 0, partial: 0, overflow: false),
                        "reasoning": .init(value: 10, known: 1, unknown: 0, partial: 0, overflow: false),
                       ])
    }
    #expect(UsageDashboardPresentation.cacheEfficiency(aggregate(100)) == "80%")
    #expect(UsageDashboardPresentation.inputOutput(aggregate(100)) == 120)
    #expect(UsageDashboardPresentation.cacheEfficiency(aggregate(100, unknown: 1)) == "Unknown")
    #expect(UsageDashboardPresentation.inputOutput(aggregate(nil)) == nil)
    #expect(UsageDashboardPresentation.inputOutput(aggregate(UsageDashboardPresentation.maximum)) == nil)
    #expect(UsageDashboardPresentation.inputOutputLabel(aggregate(UsageDashboardPresentation.maximum)) == "Overflow")
}

@Test func usageDashboardRangesAreBoundedHalfOpenUTCDaysIncludingCustomReverseAndDST() throws {
    let now = try #require(ISO8601DateFormatter().date(from: "2026-03-09T03:00:00Z"))
    let week = UsageDashboardWindow.preset(days: 7, now: now)
    let start = try #require(ISO8601DateFormatter().date(from: "2026-03-03T00:00:00Z"))
    #expect(week.from == start.timeIntervalSince1970 * 1000)
    #expect(week.to == now.timeIntervalSince1970 * 1000 + 1)
    let all = UsageDashboardWindow.preset(days: nil, now: now)
    #expect(all.to - all.from <= 366 * UsageDashboardPresentation.day)
    let reverse = try #require(UsageDashboardWindow.custom(first: now, last: start, now: now))
    #expect(reverse == week)
    #expect(UsageDashboardWindow.custom(first: now, last: now.addingTimeInterval(86400), now: now) == nil)
    #expect(UsageDashboardWindow.custom(first: now.addingTimeInterval(-366 * 86400), last: now, now: now) == nil)
    let day = try #require(UsageDashboardWindow.custom(first: start, last: start, now: now))
    #expect(day.to - day.from == UsageDashboardPresentation.day)
}

@Test func usageDashboardDrillsExactCanonicalGroupsAndPreservesOtherScope() throws {
    let base = UsageQueryFilters(projectId: "project", missing: ["physicalModel"])
    let mission = try #require(UsageDashboardPresentation.group(#"["home","lineage","mission"]"#,
                                                                dimension: "mission", base: base))
    #expect(mission.filters.mission == .init(homeId: "home", lineageId: "lineage", missionId: "mission"))
    #expect(mission.filters.projectId == "project")
    let physical = try #require(UsageDashboardPresentation.group(#"["Provider","Model"]"#,
                                                                 dimension: "physicalModel", base: base))
    #expect(physical.filters.physicalModel == .init(provider: "Provider", model: "Model"))
    #expect(physical.filters.missing?.isEmpty == true)
    let absent = try #require(UsageDashboardPresentation.group("null", dimension: "project", base: base))
    #expect(absent.filters.projectId == nil)
    #expect(absent.filters.missing == ["physicalModel", "project"])
    #expect(UsageDashboardPresentation.group("malformed", dimension: "project") == nil)
    #expect(UsageDashboardPresentation.group(#"["only-one"]"#, dimension: "mission") == nil)
}

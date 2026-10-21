import AppKit
import Foundation
import NativeTestSupport
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private func usageDashboardFixture<T: Decodable>(_ name: String, as: T.Type = T.self) throws -> T {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    return try JSONDecoder().decode(T.self, from: Data(contentsOf: root.appendingPathComponent("packages/protocol/fixtures/\(name).json")))
}

private func usageDashboardReplacing<T: Codable>(_ value: T, _ change: (inout [String: Any]) -> Void) throws -> T {
    var object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    change(&object)
    return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
}

@MainActor private func usageDashboardWait(_ predicate: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(8)
    while !predicate(), Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
    try #require(predicate(), "Usage dashboard did not settle")
}

@MainActor private final class UsageDashboardFixture {
    var host = HostRef(hostId: "local", daemonId: "local-fixture", lineageId: "local-lineage")
    var connection: HostConnectionToken
    var analytics: UsageAnalyticsResult
    var records: UsageHistoryPage
    var queries: [UsageAnalyticsQuery] = []
    var pages: [(UsageHistoryQuery, HostRef)] = []
    var projectionState = "fresh"
    var readFailure = false
    var replaceGeneration = false
    var bucketCount = 0
    var secondaryState: String?

    init() throws {
        connection = HostConnectionToken(host: host)
        analytics = try usageDashboardFixture("usage-analytics")
        records = try usageDashboardFixture("usage-history")
    }

    func projection() -> UsageConnectedProjection {
        .init(hosts: [.init(host: host, state: projectionState, result: projectionState == "fresh" ? analytics : nil)],
              omittedHosts: 0, queriedAt: analytics.queriedAt)
    }

    func makeModel() -> UsageDashboardModel {
        .init(read: { [self] query in
            queries.append(query)
            if readFailure { throw URLError(.cannotConnectToHost) }
            // Match the real daemon's per-response bound, not the 400-bucket window bound.
            if let limit = query.limit, limit > 100 {
                return .init(hosts: [.init(host: host, state: "unavailable")], omittedHosts: 0, queriedAt: 0)
            }
            if query.view != "summary", let secondaryState {
                return .init(hosts: [.init(host: host, state: secondaryState)], omittedHosts: 0, queriedAt: 0)
            }
            if query.view == "buckets", bucketCount > 0 {
                let start = Int(query.after ?? "0") ?? 0
                let end = min(start + (query.limit ?? 100), bucketCount)
                let aggregate = try JSONSerialization.jsonObject(with: JSONEncoder().encode(analytics.total))
                let result = try usageDashboardReplacing(analytics) {
                    $0["groups"] = (start..<end).map { ["key": String(format: "%016lld", Int64($0) * 86_400_000), "aggregate": aggregate] }
                    $0["truncated"] = end < bucketCount
                    $0["next"] = end < bucketCount ? String(end) : nil
                    // Ordinary corrections between live pages need not match overview totals.
                    var total = $0["total"] as? [String: Any] ?? [:]
                    total["records"] = end; $0["total"] = total
                    var status = $0["status"] as? [String: Any] ?? [:]
                    status["retainedRows"] = end; $0["status"] = status
                }
                return .init(hosts: [.init(host: host, state: "fresh", result: result)], omittedHosts: 0, queriedAt: 0)
            }
            return projection()
        }, page: { [self] query, host in
            pages.append((query, host))
            // A fixture page and summary may use different epochs. Normalize only the test envelope.
            let data = try JSONEncoder().encode(records)
            var object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            var status = try #require(object["status"] as? [String: Any])
            status["generation"] = replaceGeneration ? "erased" : analytics.status.generation
            object["status"] = status
            return try JSONDecoder().decode(UsageHistoryPage.self, from: JSONSerialization.data(withJSONObject: object))
        }, token: { [self] requested in requested == host ? connection : nil })
    }

    var scope: UsageDashboardModel.Scope { .init(window: .init(from: 0, to: 86_400_000)) }
}

@Suite(.serialized) @MainActor struct UsageDashboardModelTests {
    @Test(.timeLimit(.minutes(1))) func usageDashboardRefreshPaginatesTrendsAndDoesNotRejectOrdinaryHistoryUpdates() async throws {
        let fixture = try UsageDashboardFixture(), model = fixture.makeModel()
        defer { model.stop() }
        fixture.bucketCount = 366
        let scope = UsageDashboardModel.Scope(window: .init(from: 0, to: 366 * 86_400_000))
        model.refresh(scope)
        try await usageDashboardWait { model.state != .loading && !model.trendLoading }
        #expect(model.state == .ready && !model.trendFailed)
        #expect(model.trend.count == 366 && Set(model.trend.map(\.id)).count == 366)
        #expect(fixture.queries.filter { $0.view == "buckets" }.map(\.limit) == [100, 100, 100, 100])
        #expect(fixture.queries.filter { $0.view == "buckets" }.map(\.after) == [nil, "100", "200", "300"])
        #expect(model.summary?.total.records == 2, "Repeated or corrected per-page totals never add to the overview")
        model.show(.records("request", after: "old-cursor"))
        try await usageDashboardWait { !model.detailLoading }
        fixture.connection = HostConnectionToken(host: fixture.host)
        model.connectionChanged()
        #expect(model.summary == nil && model.page == nil)
        if case .unavailable = model.state {} else { Issue.record("Reconnect must reject the old snapshot") }
        let before = fixture.queries.count
        model.refresh(scope, force: true)
        try await usageDashboardWait { model.state != .loading && !model.trendLoading }
        #expect(model.state == .ready && !model.trendFailed && model.trend.count == 366)
        #expect(model.detail == .overview && model.page == nil)
        #expect(fixture.queries[before].view == "summary" && fixture.queries[before].after == nil)
        #expect(fixture.queries[before + 1].after == nil, "Refresh must discard the old trend cursor")
        model.connectionChanged(); await Task.yield()
        #expect(model.state == .ready, "Stable connection events must not bring back the warning")
        model.show(.records("request"))
        try await usageDashboardWait { !model.detailLoading }
        #expect(fixture.pages.last?.0.after == nil && model.summary?.total.records == 2)
    }

    @Test(.timeLimit(.minutes(1))) func usageDashboardUnavailableSecondaryReadsStayUnknownUntilExplicitRefresh() async throws {
        for state in ["limited", "unsupported", "unavailable", "disconnected"] {
            let fixture = try UsageDashboardFixture(), model = fixture.makeModel()
            defer { model.stop() }
            fixture.secondaryState = state
            model.refresh(fixture.scope)
            try await usageDashboardWait { model.state != .loading && !model.trendLoading }
            #expect(model.state == .ready && model.summary != nil)
            #expect(model.trendFailed && model.trend.isEmpty, "Missing trend is unavailable, not zero or a changed identity")
            model.show(.breakdown("project"))
            try await usageDashboardWait { !model.detailLoading }
            #expect(model.detailFailed && model.groups == nil && model.summary != nil)
            #expect(fixture.queries.count == 3, "No automatic retry loop")
            fixture.secondaryState = nil
            model.refresh(fixture.scope, force: true)
            try await usageDashboardWait { model.state == .ready && !model.trendLoading }
            #expect(!model.trendFailed && !model.detailFailed)
        }
    }

    @Test(.timeLimit(.minutes(1))) func usageDashboardLateTrendCannotOverwriteRefreshOrMixErasureGenerations() async throws {
        let fixture = try UsageDashboardFixture()
        var delayed: CheckedContinuation<UsageConnectedProjection, Never>?
        var bucketReads = 0
        var wrongHost: HostRef?
        let model = UsageDashboardModel(read: { query in
            if query.view == "buckets" {
                bucketReads += 1
                if bucketReads == 1 { return await withCheckedContinuation { delayed = $0 } }
            }
            if let wrongHost {
                return .init(hosts: [.init(host: wrongHost, state: "fresh", result: fixture.analytics)], omittedHosts: 0, queriedAt: 0)
            }
            return fixture.projection()
        }, page: { _, _ in fixture.records }, token: { _ in fixture.connection })
        defer { delayed?.resume(returning: fixture.projection()); model.stop() }
        model.refresh(fixture.scope)
        try await usageDashboardWait { delayed != nil }
        let stale = fixture.projection()
        fixture.analytics = try usageDashboardReplacing(fixture.analytics) {
            var status = $0["status"] as? [String: Any] ?? [:]
            status["generation"] = "22222222-2222-4222-8222-222222222222"; $0["status"] = status
        }
        model.refresh(fixture.scope, force: true)
        try await usageDashboardWait { model.state == .ready && !model.trendLoading }
        let release = try #require(delayed); delayed = nil; release.resume(returning: stale)
        await Task.yield()
        #expect(model.state == .ready && model.summary?.status.generation == fixture.analytics.status.generation)
        // A current request from the wrong erasure epoch must still invalidate, unlike an unavailable read.
        fixture.analytics = try usageDashboardFixture("usage-analytics")
        model.show(.breakdown("project"))
        try await usageDashboardWait { !model.detailLoading }
        #expect(model.summary == nil && model.groups == nil)
        if case .unavailable = model.state {} else { Issue.record("Never mix erasure epochs") }
        let previousHost = fixture.host
        fixture.host = HostRef(hostId: "local", daemonId: "replacement", lineageId: "replacement-lineage")
        fixture.connection = HostConnectionToken(host: fixture.host)
        model.refresh(fixture.scope, force: true)
        try await usageDashboardWait { model.state == .ready && !model.trendLoading }
        #expect(model.localHost == fixture.host)
        wrongHost = previousHost
        model.show(.breakdown("project"))
        try await usageDashboardWait { !model.detailLoading }
        #expect(model.summary == nil && model.groups == nil, "A response from the previous daemon/lineage cannot enter the new view")
    }

    @Test(.timeLimit(.minutes(1))) func usageDashboardLocalOnlyCacheAndPagesNeverAddCheckpointOrRepeatedTotals() async throws {
        let fixture = try UsageDashboardFixture(), model = fixture.makeModel()
        defer { model.stop() }
        model.refresh(fixture.scope); model.refresh(fixture.scope)
        try await usageDashboardWait { model.state == .ready && !model.trendLoading }
        #expect(fixture.queries.map(\.view) == ["summary", "buckets"])
        #expect(model.summary?.total.records == 2)
        #expect(model.summary?.reconciliation.records == 1)
        #expect(model.summary?.total.metrics["input"]?.unknown == 1)
        model.show(.breakdown("project"))
        try await usageDashboardWait { !model.detailLoading }
        model.show(.overview); model.show(.breakdown("project"))
        #expect(fixture.queries.count == 3, "Reopening the active scope's first breakdown is cached")
        #expect(fixture.queries.last?.limit == 10)
        model.show(.records("checkpoint"))
        try await usageDashboardWait { !model.detailLoading }
        #expect(fixture.pages.last?.0.kind == "checkpoint")
        #expect(fixture.pages.last?.1 == fixture.host)
        #expect(fixture.pages.last?.0.limit == 25)
        let count = model.page?.rows.count
        model.show(.records("request", after: "opaque-next"))
        try await usageDashboardWait { !model.detailLoading }
        #expect(model.page?.rows.count == count, "Page replacement never accumulates rows or repeated totals")
        #expect(model.summary?.total.records == 2, "Checkpoints and pages never change additive totals")
        #expect(fixture.pages.last?.0.after == "opaque-next")
        fixture.replaceGeneration = true
        model.show(.records("request"))
        try await usageDashboardWait { !model.detailLoading }
        #expect(model.summary == nil && model.page == nil)
        if case .unavailable = model.state {} else { Issue.record("An erased generation must invalidate the view") }
    }

    @Test(.timeLimit(.minutes(1))) func usageDashboardUnsupportedCapacityErrorsAndAmbiguousLocalAreNotZero() async throws {
        for state in ["unsupported", "limited", "disconnected", "unavailable"] {
            let fixture = try UsageDashboardFixture(), model = fixture.makeModel()
            fixture.projectionState = state
            model.refresh(fixture.scope)
            try await usageDashboardWait { model.state != .loading }
            if case .unavailable = model.state {} else { Issue.record("Expected unavailable \(state)") }
            #expect(model.summary == nil && fixture.queries.count == 1 && fixture.pages.isEmpty)
            model.stop()
        }
        let fixture = try UsageDashboardFixture(), model = fixture.makeModel()
        fixture.readFailure = true; model.refresh(fixture.scope)
        #expect(model.state == .loading && model.summary == nil)
        try await usageDashboardWait { model.state == .failed }
        #expect(model.summary == nil)
        fixture.readFailure = false
        var empty = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(fixture.analytics)) as? [String: Any])
        var total = try #require(empty["total"] as? [String: Any])
        total["records"] = 0
        total["metrics"] = ["input": ["known": 0, "unknown": 0, "partial": 0, "overflow": false]]
        empty["total"] = total; empty["groups"] = []
        fixture.analytics = try JSONDecoder().decode(UsageAnalyticsResult.self, from: JSONSerialization.data(withJSONObject: empty))
        model.refresh(fixture.scope, force: true)
        try await usageDashboardWait { model.state == .ready && !model.trendLoading }
        #expect(model.summary?.total.records == 0)
        #expect(model.summary?.total.metrics["input"]?.value == nil)
        #expect(model.summary?.reconciliation.records == 1, "Empty chart dates do not erase retained checkpoint coverage")
        model.stop()
        let remote = HostRef(hostId: "devbox", daemonId: "remote", lineageId: "remote")
        let malformed = UsageDashboardModel(read: { _ in
            .init(hosts: [.init(host: remote, state: "fresh", result: fixture.analytics)], omittedHosts: 0, queriedAt: 0)
        }, page: { _, _ in throw HostRoutingError.invalidReference }, token: { _ in fixture.connection })
        malformed.refresh(fixture.scope)
        try await usageDashboardWait { malformed.state != .loading }
        #expect(malformed.summary == nil)
        malformed.stop()
    }

    @Test(.timeLimit(.minutes(1))) func usageDashboardStaleScopeAndConnectionResponsesCannotRepaintOrReuseCache() async throws {
        let fixture = try UsageDashboardFixture()
        var delayed: CheckedContinuation<UsageConnectedProjection, Never>?
        var reads = 0
        let model = UsageDashboardModel(read: { _ in
            reads += 1
            if reads == 1 { return await withCheckedContinuation { delayed = $0 } }
            return fixture.projection()
        }, page: { _, _ in fixture.records }, token: { _ in fixture.connection })
        defer { delayed?.resume(returning: fixture.projection()); model.stop() }
        model.refresh(fixture.scope)
        try await usageDashboardWait { delayed != nil }
        let next = UsageDashboardModel.Scope(window: .init(from: 1000, to: 2000), filters: .init(purpose: "title"))
        model.refresh(next)
        try await usageDashboardWait { model.state == .ready && !model.trendLoading }
        let release = try #require(delayed); delayed = nil; release.resume(returning: fixture.projection())
        await Task.yield()
        #expect(model.scope == next && model.summary?.total.records == 2)
        fixture.connection = HostConnectionToken(host: fixture.host)
        model.connectionChanged()
        #expect(model.summary == nil)
        model.show(.breakdown("project"))
        #expect(model.groups == nil)

        var delayedPage: CheckedContinuation<UsageHistoryPage, Never>?
        let paging = UsageDashboardModel(read: { _ in fixture.projection() }, page: { _, _ in
            await withCheckedContinuation { delayedPage = $0 }
        }, token: { _ in fixture.connection })
        defer { delayedPage?.resume(returning: fixture.records); paging.stop() }
        paging.refresh(fixture.scope)
        try await usageDashboardWait { paging.state == .ready && !paging.trendLoading }
        paging.show(.records("request"))
        try await usageDashboardWait { delayedPage != nil }
        paging.refresh(next)
        try await usageDashboardWait { paging.state == .ready && !paging.trendLoading }
        let releasePage = try #require(delayedPage); delayedPage = nil; releasePage.resume(returning: fixture.records)
        await Task.yield()
        #expect(paging.page == nil && paging.scope == next, "A late record page cannot repaint a newer scope")

        let snapshotting = UsageDashboardModel(read: { _ in fixture.projection() }, page: { _, _ in fixture.records },
            token: { _ in fixture.connection }, snapshots: { _ in
                fixture.connection = HostConnectionToken(host: fixture.host)
                return []
            })
        defer { snapshotting.stop() }
        snapshotting.refresh(fixture.scope)
        try await usageDashboardWait { snapshotting.state != .loading && snapshotting.state != .ready }
        #expect(snapshotting.summary == nil, "Connection changes while preparing cached quotas invalidate the overview too")
    }

    @Test func usageDashboardNavigationIsAvailableWithoutConfiguration() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let domain = "usage-navigation-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain); try? FileManager.default.removeItem(at: directory) }
        let hosts = ClientDirectory(operationDirectory: directory.appendingPathComponent("operations"))
        let app = AppModel(projectFolderDefaults: defaults, hosts: hosts)
        // Opening the page needs neither provider setup, a connected Local endpoint nor an environment opt-in.
        app.showingInbox = true; app.showingArchive = true
        app.showUsage()
        #expect(app.showingUsage && !app.showingInbox && !app.showingArchive)
        #expect(app.currentRoute == .usage)
        #expect(app.selectedSessionId == nil && app.selectedProjectId == nil && app.selectedMissionId == nil)
        await hosts.disconnectAll()
    }
}

/// Real production controls and pointer dispatch. Run individually through test.sh, never with broad AppKit loops.
@Test(.timeLimit(.minutes(1))) @MainActor
func usageDashboardMountedControlsReadLocalRangesFoldAndPageInBothAppearances() async throws {
    _ = NSApplication.shared
    for (width, appearance) in [(420.0, NSAppearance.Name.aqua), (900.0, .aqua), (420.0, .darkAqua), (900.0, .darkAqua)] {
        let fixture = try UsageDashboardFixture(), model = fixture.makeModel()
        let domain = "usage-dashboard-fixture-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let hosting = NSHostingView(rootView: UsageDashboardPage(model: model).defaultAppStorage(defaults).quietFocus())
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: width, height: 900),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.appearance = NSAppearance(named: appearance)
        window.contentView = hosting; window.orderFrontRegardless(); hosting.layoutSubtreeIfNeeded()
        defer { model.stop(); window.contentView = nil; window.close() }
        try await usageDashboardWait { model.state == .ready && !model.trendLoading && !model.detailLoading }
        func click(_ id: String, in root: NSView? = nil) async throws {
            let geometry = try #require(NativeInput.views(in: root ?? hosting, of: ControlGeometryView.self)
                .first { $0.identifier?.rawValue == id && !$0.isHiddenOrHasHiddenAncestor && !$0.bounds.isEmpty })
            geometry.scrollToVisible(geometry.bounds)
            hosting.layoutSubtreeIfNeeded()
            #expect(geometry.controlEnabled)
            try await NativeInput.click(geometry)
        }
        try await click("usage-breakdown-physicalModel")
        try await usageDashboardWait { model.groups != nil && !model.detailLoading }
        #expect(fixture.queries.last?.dimension == "physicalModel")
        try await click("usage-breakdown-physicalModel")
        #expect(model.detail == .overview)
        try await click("usage-requests")
        try await usageDashboardWait { model.page != nil && !model.detailLoading }
        #expect(fixture.pages.last?.0.kind == "request" && fixture.pages.last?.1 == fixture.host)
        try await click("usage-checkpoints")
        try await usageDashboardWait { model.page != nil && !model.detailLoading }
        #expect(fixture.pages.last?.0.kind == "checkpoint")
        try await click("usage-range-1")
        try await usageDashboardWait { model.state == .ready && !model.trendLoading }
        let query = try #require(fixture.queries.last)
        #expect(query.to - query.from <= UsageDashboardPresentation.day)
        #expect(query.from.truncatingRemainder(dividingBy: UsageDashboardPresentation.day) == 0)
        try await click("usage-refresh")
        try await usageDashboardWait { model.state == .ready && !model.trendLoading }
        let beforeCustom = fixture.queries.count
        try await click("usage-range-custom")
        try await usageDashboardWait { window.attachedSheet?.contentView != nil }
        let sheet = try #require(window.attachedSheet?.contentView)
        try await click("sheet-cancel", in: sheet)
        try await usageDashboardWait { window.attachedSheet == nil }
        #expect(fixture.queries.count == beforeCustom, "Canceling custom dates must not query")
        hosting.layoutSubtreeIfNeeded()
        let scroll = try #require(NativeInput.views(in: hosting, of: NSScrollView.self).first)
        let document = try #require(scroll.documentView)
        // fittingSize is the reading column's ideal width (760), not the mounted viewport.
        // Assert the actual document/clip geometry, so a real horizontal spill still fails.
        #expect(hosting.bounds.width <= width + 1)
        #expect(!scroll.hasHorizontalScroller)
        #expect(document.frame.width <= scroll.contentView.bounds.width + 1,
                "The mounted document must fit its actual viewport without horizontal scrolling")
        #expect(fixture.pages.allSatisfy { $0.1 == fixture.host })
    }
}

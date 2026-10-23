import Foundation
import Combine
import PilotCore
import SwiftUI

extension AppModel {
    func showUsage() {
        beginNavigation()
        defer { endNavigation() }
        hosts.selection = nil
        showingArchive = false; showingInbox = false
        selectedSessionId = nil; selectedMissionId = nil; selectedProjectId = nil
        clearProjectSubpage()
        showingUsage = true
    }
}

struct UsageTrendPoint: Identifiable, Sendable {
    let milliseconds: Double
    let tokens: Double?
    var id: Double { milliseconds }
    var date: Date { Date(timeIntervalSince1970: milliseconds / 1000) }
}

@MainActor final class UsageDashboardModel: ObservableObject {
    enum State: Equatable { case idle, loading, ready, unavailable(String), failed }
    enum Detail: Equatable {
        case overview
        case breakdown(String, after: String? = nil)
        case records(String, after: String? = nil)
    }
    struct Scope: Equatable {
        let window: UsageDashboardWindow
        var filters: UsageQueryFilters?
    }
    enum Sort: String, CaseIterable {
        case cost = "estimatedUsdMicros", input, output, cacheRead, requests, duration = "durationMs"
        var title: String {
            switch self {
            case .cost: "Estimated cost"
            case .input: "Input tokens"
            case .output: "Output tokens"
            case .cacheRead: "Cache read"
            case .requests: "Requests"
            case .duration: "Duration"
            }
        }
    }
    typealias LocalRead = @MainActor (UsageAnalyticsQuery) async throws -> UsageConnectedProjection
    typealias PageRead = @MainActor (UsageHistoryQuery, HostRef) async throws -> UsageHistoryPage
    typealias TokenRead = @MainActor (HostRef) -> HostConnectionToken?
    typealias LabelsRead = @MainActor (HostRef, String, [String]) async -> [String: String]

    @Published private(set) var state: State = .idle
    @Published private(set) var summary: UsageAnalyticsResult?
    @Published private(set) var trend: [UsageTrendPoint] = []
    @Published private(set) var trendFailed = false
    @Published private(set) var trendLoading = false
    @Published private(set) var detail: Detail = .overview
    @Published private(set) var groups: UsageAnalyticsResult?
    @Published private(set) var groupNames: [String: String] = [:]
    @Published private(set) var recordNames: [String: [String: String]] = [:]
    @Published private(set) var sort = Sort.cost
    @Published private(set) var ascending = false
    @Published private(set) var page: UsageHistoryPage?
    @Published private(set) var detailLoading = false
    @Published private(set) var detailFailed = false
    @Published private(set) var scope: Scope?
    @Published private(set) var subscriptions: [SubscriptionUsage] = []
    private(set) var localHost: HostRef?
    private let read: LocalRead
    private let readPage: PageRead
    private let token: TokenRead
    private let snapshots: @MainActor (HostRef) async -> [SubscriptionUsage]
    private let labels: LabelsRead
    private var anchor: HostConnectionToken?
    private var revision = UUID()
    private var detailRevision = UUID()
    private var overviewTask: Task<Void, Never>?
    private var detailTask: Task<Void, Never>?
    private var hostObservation: AnyCancellable?
    private var connectionCheckScheduled = false
    // Only the active scope, at most five first pages of ten groups. No disk/stale fallback cache.
    private var breakdowns: [String: UsageAnalyticsResult] = [:]
    private var breakdownNames: [String: [String: String]] = [:]

    init(read: @escaping LocalRead, page: @escaping PageRead, token: @escaping TokenRead,
         snapshots: @escaping @MainActor (HostRef) async -> [SubscriptionUsage] = { _ in [] },
         labels: @escaping LabelsRead = { _, _, _ in [:] }) {
        self.read = read; readPage = page; self.token = token
        self.snapshots = snapshots; self.labels = labels
    }

    convenience init(hosts: ClientDirectory) {
        self.init(read: { try await hosts.localUsage($0) },
                  page: { try await hosts.usagePage($0, on: $1) },
                  token: { try? hosts.localUsageToken(for: $0) }, snapshots: { host in
                      let sessions = (try? hosts.endpoint(host).sessions) ?? []
                      return await Task.detached(priority: .utility) { HomeStatus.subscriptions(sessions) }.value
                  }, labels: { host, dimension, keys in
                      guard let client = try? hosts.endpoint(host) else { return [:] }
                      let projects = client.projects, chats = client.sessions, missions = client.missions
                      return await Task.detached(priority: .utility) {
                          UsageDashboardPresentation.displayNames(keys, dimension: dimension, host: host,
                                                                  projects: projects, chats: chats, missions: missions)
                      }.value
                  })
        // Invalidate on endpoint events, without rereading history or polling. objectWillChange precedes
        // mutation, so defer the small identity check to the next main-actor turn.
        hostObservation = hosts.objectWillChange.sink { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleConnectionCheck() }
        }
    }

    func refresh(_ scope: Scope, force: Bool = false) {
        if !force, self.scope == scope, state == .loading { return } // Coalesce identical in-flight controls.
        if !force, self.scope == scope, state == .ready, current { return }
        stop()
        self.scope = scope
        summary = nil; trend = []; trendFailed = false; trendLoading = false; groups = nil; page = nil
        detailFailed = false
        breakdowns = [:]; breakdownNames = [:]; groupNames = [:]; recordNames = [:]
        anchor = nil; localHost = nil; detail = .overview; subscriptions = []
        state = .loading
        let request = revision
        overviewTask = Task { [weak self] in
            guard let self else { return }
            do {
                // Scope changes coalesce before any expensive storage query, never on repaint/timer.
                try await Task.sleep(for: .milliseconds(180))
                let projection = try await read(query(scope))
                try Task.checkCancellation()
                guard revision == request else { return }
                guard projection.omittedHosts == 0, projection.hosts.count == 1,
                      let host = projection.hosts.first, host.host.hostId == "local" else {
                    state = .unavailable("Pinned Local identity unavailable or ambiguous."); return
                }
                guard host.state == "fresh", let result = host.result else {
                    state = .unavailable(Self.unavailable(host.state)); return
                }
                guard let connection = token(host.host) else { state = .unavailable(Self.unavailable("disconnected")); return }
                localHost = host.host; anchor = connection; summary = result
                trendLoading = true
                state = .ready
                do {
                    // The window permits 400 buckets, but each response permits only 100 groups.
                    // Keep pages private until complete; never publish a truncated trend as coverage.
                    var buckets: [UsageAnalyticsGroup] = []
                    var after: String?
                    for _ in 0..<4 {
                        let projection = try await read(query(scope, view: "buckets", bucket: 86_400_000, limit: 100, after: after))
                        try Task.checkCancellation()
                        guard revision == request else { return }
                        guard let values = accept(projection) else { throw ClientError("Usage trend unavailable") }
                        guard values.groups.count <= 100,
                              values.truncated == (values.next != nil),
                              values.next == nil || values.next != after else { throw ClientError("Usage trend unavailable") }
                        buckets.append(contentsOf: values.groups)
                        after = values.next
                        if after == nil { break }
                    }
                    guard after == nil, Set(buckets.map(\.key)).count == buckets.count else { throw ClientError("Usage trend unavailable") }
                    let completedBuckets = buckets
                    let points = await Task.detached(priority: .utility) {
                        completedBuckets.compactMap { group -> UsageTrendPoint? in
                            guard let date = Double(group.key) else { return nil }
                            return UsageTrendPoint(milliseconds: date, tokens: UsageDashboardPresentation.inputOutput(group.aggregate))
                        }
                    }.value
                    guard revision == request else { return }
                    guard current else { invalidate(); return }
                    trend = points
                } catch {
                    guard revision == request, !Task.isCancelled else { return }
                    trendFailed = true
                }
                trendLoading = false
                let cached = await snapshots(host.host)
                guard revision == request else { return }
                guard current else { invalidate(); return }
                subscriptions = cached
            } catch {
                guard revision == request, !Task.isCancelled else { return }
                if error is HostRoutingError { state = .unavailable("Pinned Local is unavailable. No other host was queried.") }
                else { state = .failed }
            }
        }
    }

    func show(_ selection: Detail, force: Bool = false) {
        detailTask?.cancel(); detailRevision = UUID()
        detail = selection; groups = nil; groupNames = [:]; recordNames = [:]; page = nil; detailFailed = false; detailLoading = false
        guard selection != .overview, let scope, let host = localHost, current else {
            if selection != .overview { invalidate() }
            return
        }
        if case let .breakdown(dimension, after) = selection, after == nil, !force, let cached = breakdowns[dimension] {
            groups = cached; groupNames = breakdownNames[dimension] ?? [:]; return
        }
        let request = revision, subrequest = detailRevision
        detailLoading = true
        detailTask = Task { [weak self] in
            guard let self else { return }
            defer { if detailRevision == subrequest { detailLoading = false } }
            do {
                try await Task.sleep(for: .milliseconds(180))
                guard current else { invalidate(); return }
                switch selection {
                case .overview: break
                case let .breakdown(dimension, after):
                    guard Self.dimensions.contains(dimension) else { detailFailed = true; return }
                    let projection = try await read(query(scope, view: "breakdown", dimension: dimension, limit: 10, after: after))
                    try Task.checkCancellation()
                    guard revision == request, detailRevision == subrequest else { return }
                    guard let result = accept(projection) else {
                        if revision == request { detailFailed = true }
                        return
                    }
                    let names = await labels(host, dimension, result.groups.map(\.key))
                    guard revision == request, detailRevision == subrequest else { return }
                    guard current else { invalidate(); return }
                    groups = result; groupNames = names
                    if after == nil { breakdowns[dimension] = result; breakdownNames[dimension] = names }
                case let .records(kind, after):
                    guard kind == "request" || kind == "checkpoint" else { detailFailed = true; return }
                    let result = try await readPage(.init(kind: kind, from: scope.window.from, to: scope.window.to,
                                                         limit: 25, after: after, filters: scope.filters), host)
                    try Task.checkCancellation()
                    guard revision == request, detailRevision == subrequest else { return }
                    guard current, result.status.generation == summary?.status.generation else { invalidate(); return }
                    var names: [String: [String: String]] = [:]
                    for dimension in ["project", "chat", "mission"] {
                        let keys = Array(Set(result.rows.compactMap { UsageDashboardPresentation.attributionKey($0, dimension: dimension) }))
                        names[dimension] = await labels(host, dimension, keys)
                        guard revision == request, detailRevision == subrequest else { return }
                    }
                    guard current else { invalidate(); return }
                    recordNames = names
                    page = result // Replace, never sum repeated totals or retain an unbounded list of pages.
                }
            } catch {
                guard revision == request, detailRevision == subrequest, !Task.isCancelled else { return }
                if !current { invalidate() } else { detailFailed = true }
            }
        }
    }

    static let dimensions = ["project", "mission", "chat", "physicalModel", "purpose"]

    func setSort(_ sort: Sort, ascending: Bool) {
        guard self.sort != sort || self.ascending != ascending else { return }
        self.sort = sort; self.ascending = ascending
        breakdowns = [:]; breakdownNames = [:]
        if case let .breakdown(dimension, _) = detail { show(.breakdown(dimension)) }
    }

    func connectionChanged() {
        if summary != nil, !current { invalidate() }
    }

    private func scheduleConnectionCheck() {
        guard !connectionCheckScheduled else { return }
        connectionCheckScheduled = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            connectionCheckScheduled = false
            connectionChanged()
        }
    }

    func stop() {
        overviewTask?.cancel(); detailTask?.cancel()
        revision = UUID(); detailRevision = UUID(); detailLoading = false
    }

    private var current: Bool {
        guard let host = localHost, let anchor else { return false }
        return host.hostId == "local" && token(host) == anchor
    }

    private func invalidate() {
        stop(); summary = nil; groups = nil; groupNames = [:]; recordNames = [:]; page = nil; trend = []; breakdowns = [:]; breakdownNames = [:]
        trendLoading = false; subscriptions = []
        state = .unavailable("Local connection or history changed. Refresh to read the current retained view.")
    }

    private func accept(_ projection: UsageConnectedProjection) -> UsageAnalyticsResult? {
        guard current, projection.omittedHosts == 0, projection.hosts.count == 1,
              let value = projection.hosts.first, value.host == localHost else {
            invalidate(); return nil
        }
        // A bounded query may fail while the accepted Local overview remains valid. Missing
        // evidence is unavailable, not proof that the connection or erasure epoch changed.
        guard value.state == "fresh", let result = value.result else { return nil }
        guard result.status.generation == summary?.status.generation else { invalidate(); return nil }
        return result
    }

    private func query(_ scope: Scope, view: String = "summary", dimension: String? = nil,
                       bucket: Int? = nil, limit: Int? = nil, after: String? = nil) -> UsageAnalyticsQuery {
        .init(from: scope.window.from, to: scope.window.to, filters: scope.filters,
              view: view, dimension: dimension, bucketMs: bucket, limit: limit, after: after,
              sort: view == "breakdown" ? sort.rawValue : nil,
              direction: view == "breakdown" ? (ascending ? "asc" : "desc") : nil)
    }

    private static func unavailable(_ state: String) -> String {
        switch state {
        case "unsupported": "Local does not support usage queries version 1. Usage is unknown, not zero."
        case "limited": "Local query capacity reached. Try Refresh later."
        case "disconnected": "Local is disconnected. No other host was queried."
        default: "Local accounting is unavailable. Missing evidence is not zero."
        }
    }

    deinit { overviewTask?.cancel(); detailTask?.cancel() }
}

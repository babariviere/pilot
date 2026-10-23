import Charts
import PilotCore
import SwiftUI

/// The revision-2 design's reading column, compact summaries, one trend and progressive disclosures.
/// Local observations only; no other execution mode is offered.
struct UsageDashboardPage: View {
    @StateObject private var dashboard: UsageDashboardModel
    @State private var window = UsageDashboardWindow.preset(days: 7, now: Date())
    @State private var period = "7 days"
    @State private var filters: UsageQueryFilters?
    @State private var scopeLabels: [String: String] = [:]
    @State private var customRange = false
    @State private var pendingRequests = false
    @AppStorage("usageDashboardBreakdown") private var expanded = "project"

    init(model: UsageDashboardModel) { _dashboard = StateObject(wrappedValue: model) }
    init(hosts: ClientDirectory) { _dashboard = StateObject(wrappedValue: UsageDashboardModel(hosts: hosts)) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PageHeader("Usage", subtitle: "Local · observed / partial") {
                    Button("Refresh") { refresh(force: true) }
                        .background(ControlGeometry(id: "usage-refresh"))
                        .help("Read Local retained usage again. Does not contact providers or other hosts.")
                }
                rangeControls
                if !scopeLabels.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(UsageDashboardModel.dimensions.compactMap { scopeLabels[$0] }.joined(separator: " · ")).textSelection(.enabled)
                        Button("All Local work") {
                            filters = nil; scopeLabels = [:]; pendingRequests = false; refresh()
                        }
                        .background(ControlGeometry(id: "usage-clear-scope"))
                    }.font(.pilot(.caption))
                }
                content
            }
            .padding(24)
            .frame(maxWidth: Theme.column, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .font(.pilot(.body))
        .foregroundStyle(Theme.foreground)
        .background(Theme.background)
        .navigationTitle("Usage · Local")
        .task { refresh(force: true) }
        .onDisappear { dashboard.stop() }
        .onChange(of: dashboard.state) { _, state in
            guard state == .ready else { return }
            if pendingRequests {
                pendingRequests = false; dashboard.show(.records("request"))
            } else if UsageDashboardModel.dimensions.contains(expanded) {
                dashboard.show(.breakdown(expanded))
            }
        }
        .sheet(isPresented: $customRange) {
            UsageCustomRange(window: window) { chosen in
                window = chosen; period = "Custom"; refresh()
            }
        }
    }

    private var rangeControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack { presets }
                VStack(alignment: .leading, spacing: 8) {
                    HStack { preset("Today", days: 1); preset("7 days", days: 7); preset("30 days", days: 30) }
                    HStack { preset("All retained", days: nil); customButton }
                }
            }
            Text("\(UsageDashboardPresentation.utc(window.from)) to \(UsageDashboardPresentation.utc(window.to - 1))")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            Text("UTC days · All means retained Local history, not lifetime usage. Missing history is unknown, not zero.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
        }
    }

    @ViewBuilder private var presets: some View {
        preset("Today", days: 1); preset("7 days", days: 7); preset("30 days", days: 30)
        preset("All retained", days: nil); customButton
    }

    private func preset(_ title: String, days: Int?) -> some View {
        Button(title) {
            period = title; window = .preset(days: days, now: Date()); refresh()
        }
        .buttonStyle(.borderless)
        .padding(6)
        .background(period == title ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
        .accessibilityAddTraits(period == title ? [.isSelected] : [])
        .background(ControlGeometry(id: "usage-range-\(days ?? 366)"))
    }

    private var customButton: some View {
        Button("Custom…") { customRange = true }
            .buttonStyle(.borderless).padding(6)
            .background(period == "Custom" ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
            .background(ControlGeometry(id: "usage-range-custom"))
    }

    @ViewBuilder private var content: some View {
        switch dashboard.state {
        case .idle, .loading:
            ProgressView("Loading Local usage…").frame(maxWidth: .infinity).padding(.vertical, 30)
        case let .unavailable(message):
            EmptyStateView(icon: .disconnected, title: "Local usage unavailable", message: message) {
                Button("Retry") { refresh(force: true) }
            }
        case .failed:
            EmptyStateView(icon: .warning, title: "Couldn’t load Local usage",
                           message: "No stale totals were substituted. Missing evidence is not zero.") {
                Button("Retry") { refresh(force: true) }
            }
        case .ready:
            if let summary = dashboard.summary {
                overview(summary)
                detailControls
                if case .records = dashboard.detail { records }
                else { breakdowns }
                coverage(summary)
                subscriptionSnapshots
            }
        }
    }

    private func overview(_ result: UsageAnalyticsResult) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Partial history · collected since \(UsageDashboardPresentation.utc(result.status.coverageStartedAt))")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            Text("Local observation: \(UsageDashboardPresentation.utc(result.queriedAt)) · refresh explicitly for newer evidence")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            if result.total.records == 0 {
                EmptyStateView(icon: .activity, title: "No observed requests in these dates",
                               message: "This is not proof of zero usage. Reconciliation coverage below is independent of dates.")
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 155), alignment: .topLeading)], alignment: .leading, spacing: 18) {
                    summaryCell("Catalog estimate · USD", value: value("estimatedUsdMicros", result.total, currency: true), details: [
                        "Known-price portion", UsageDashboardPresentation.coverage(result.total.metrics["estimatedUsdMicros"]),
                    ])
                    summaryCell("Input + output", value: UsageDashboardPresentation.inputOutputLabel(result.total), details: [
                        "\(value("input", result.total)) input · \(value("output", result.total)) output",
                        "\(value("reasoning", result.total)) reasoning, inside output",
                        "Known subtotal · class coverage below",
                    ])
                    summaryCell("Cache read", value: value("cacheRead", result.total), details: [
                        "\(UsageDashboardPresentation.cacheEfficiency(result.total)) cache efficiency",
                        "\(value("cacheWrite", result.total)) cache write",
                    ])
                    summaryCell("Requests", value: value("requests", result.total), details: [
                        "\(value("providerAttempts", result.total)) observed attempts",
                        "\(value("retries", result.total)) observed retries",
                    ])
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                Text("\(result.total.unpriced) unpriced · \(result.total.partialPriced) partially priced requests. Unknown prices are excluded, never free.")
                Text(result.total.pricingVersions > 1 ? "Mixed pricing revisions · historical catalog estimates, not repriced."
                     : "Pricing revision: \(result.total.pricingRevision ?? "Unknown")")
                Text("Billed spend unavailable. Catalog estimates are not invoices or marginal subscription charges.")
                Text("Cache efficiency: \(UsageDashboardPresentation.cacheEfficiency(result.total)) = read / (input + read). Cache write excluded.")
            }.font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).textSelection(.enabled)
            HairlineDivider()
            PageSectionHeader(title: "Input + output over time")
            Text("Daily · UTC · known subtotals · reasoning is not added again")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            if dashboard.trendLoading {
                ProgressView("Loading trend…")
            } else if dashboard.trendFailed {
                InlineProblem("Trend unavailable. Refresh to read Local again.", retry: { refresh(force: true) })
            } else if !dashboard.trend.isEmpty {
                UsageTrendChart(points: dashboard.trend, window: window)
            }
            Text("Gaps and missing classes are unknown, not zero. Shown days may be partial; cache is shown separately above.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
        }
    }

    private func value(_ key: String, _ aggregate: UsageAggregate, currency: Bool = false) -> String {
        UsageDashboardPresentation.number(aggregate.metrics[key], currency: currency)
    }

    private func summaryCell(_ title: String, value: String, details: [String]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            Text(value)
                .font(.pilot(.title, weight: .semibold)).monospacedDigit().fixedSize(horizontal: false, vertical: true)
            ForEach(details, id: \.self) { Text($0).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground) }
        }
        .accessibilityElement(children: .combine)
    }

    private var detailControls: some View {
        HStack(spacing: 12) {
            Button("Overview") { dashboard.show(expanded.isEmpty ? .overview : .breakdown(expanded)) }
                .background(ControlGeometry(id: "usage-overview"))
            Button("Requests") { dashboard.show(.records("request")) }
                .background(ControlGeometry(id: "usage-requests"))
            Button("Reconciliation") { dashboard.show(.records("checkpoint")) }
                .background(ControlGeometry(id: "usage-checkpoints"))
        }.controlSize(.small)
    }

    private var breakdowns: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Picker("Sort by", selection: Binding(get: { dashboard.sort }, set: {
                    dashboard.setSort($0, ascending: dashboard.ascending)
                })) {
                    ForEach(UsageDashboardModel.Sort.allCases, id: \.self) { Text($0.title).tag($0) }
                }.fixedSize()
                Button(dashboard.ascending ? "Lowest first" : "Highest first",
                       systemImage: dashboard.ascending ? "arrow.up" : "arrow.down") {
                    dashboard.setSort(dashboard.sort, ascending: !dashboard.ascending)
                }.background(ControlGeometry(id: "usage-sort-direction"))
            }.controlSize(.small).padding(.vertical, 10)
            Text("Sorted across all matching groups · known subtotals · unknown and overflow values last")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).padding(.bottom, 8)
            ForEach(UsageDashboardModel.dimensions, id: \.self) { dimension in
                let open = isExpanded(dimension)
                HairlineDivider()
                UsageBreakdownHeader(title: title(dimension), dimension: dimension, expanded: open) {
                    expanded = open ? "" : dimension
                    dashboard.show(open ? .overview : .breakdown(dimension))
                }
                if open {
                    if dashboard.detailLoading { ProgressView("Loading breakdown…").padding(.vertical, 12) }
                    else if dashboard.detailFailed { detailProblem }
                    else if let result = dashboard.groups {
                        ForEach(result.groups, id: \.key) { group in
                            UsageBreakdownRow(group: group, dimension: dimension, filters: filters,
                                              displayName: dashboard.groupNames[group.key]) { label, filter in
                                filters = filter; scopeLabels[dimension] = label
                                if dashboard.scope == .init(window: window, filters: filter), dashboard.state == .ready {
                                    dashboard.show(.records("request"))
                                } else { pendingRequests = true; refresh() }
                            }
                        }
                        if result.groups.isEmpty { Text("No observed groups.").padding(.vertical, 10) }
                        if let next = result.next {
                            Button("Next groups") { dashboard.show(.breakdown(dimension, after: next)) }
                                .background(ControlGeometry(id: "usage-next-groups")).padding(.vertical, 10)
                        }
                        if result.truncated { Text("More groups retained. Each page replaces the list; totals are not added.").font(.pilot(.caption)) }
                    }
                }
            }
            Text("Purposes include background inference. Each breakdown groups the same work, not additional usage.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).padding(.top, 12)
        }
    }

    @ViewBuilder private var records: some View {
        let kind = recordKind
        VStack(alignment: .leading, spacing: 12) {
            PageSectionHeader(title: kind == "checkpoint" ? "Reconciliation coverage" : "Observed requests")
            Text(kind == "checkpoint"
                 ? "Non-additive checkpoints · all retained dates. Parent/child totals may overlap. Never add these amounts to requests or to one another."
                 : "Content-free · 25 records per page · live retained view. Refresh after corrections; pages are not an immutable snapshot.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            if dashboard.detailLoading { ProgressView("Loading records…") }
            else if dashboard.detailFailed { detailProblem }
            else if let page = dashboard.page {
                if page.rows.isEmpty { Text("No observed records match this scope.").foregroundStyle(Theme.mutedForeground) }
                ForEach(page.rows, id: \.self) { row in UsageRequestRow(row: row, names: dashboard.recordNames) }
                if let next = page.next {
                    Button("Next records") { dashboard.show(.records(kind, after: next)) }
                        .background(ControlGeometry(id: "usage-next-records"))
                }
                Button("First page") { dashboard.show(.records(kind)) }
                    .background(ControlGeometry(id: "usage-first-records"))
            }
        }
    }

    private var recordKind: String { if case let .records(kind, _) = dashboard.detail { kind } else { "request" } }
    private var detailProblem: some View {
        InlineProblem("Local detail unavailable. No stale page was substituted.") { dashboard.show(dashboard.detail, force: true) }
    }

    private func coverage(_ result: UsageAnalyticsResult) -> some View {
        DisclosureGroup("Coverage & definitions") {
            VStack(alignment: .leading, spacing: 6) {
                Text("Local observed / partial. \(result.total.records) dated request records; \(result.total.committed) committed, \(result.total.partial) partial, \(result.total.legacy) legacy.")
                Text("\(result.reconciliation.records) retained checkpoints, independent of selected dates. Coverage only, not additional tokens or cost.")
                Text("Capture floor: \(UsageDashboardPresentation.utc(result.status.captureFloor)). Retention floor: \(UsageDashboardPresentation.utc(result.status.retentionFloor)).")
                Text("\(UsageFormatting.tokens(result.status.retainedRows)) retained rows · \(UsageFormatting.tokens(result.status.expired)) expired · \(UsageFormatting.tokens(result.status.rejected)) rejected · \(UsageFormatting.tokens(result.status.conflicts)) conflicts · \(UsageFormatting.tokens(result.status.queueOverflows)) process-local queue overflows.")
                Text("\(UsageDashboardPresentation.utc(result.queriedAt)) · explicit refresh only. Retention, capture gaps and missing metrics prevent complete-account claims.")
                Text("All numeric totals are known subtotals with per-class unknown/incomplete counts. Overflow omits an unsafe sum. Reasoning is a subset of output. Checkpoints may overlap detailed work and are never allocated to chart dates.")
                ForEach(["input", "output", "cacheRead", "cacheWrite", "reasoning", "requests", "providerAttempts", "retries"], id: \.self) { key in
                    Text("\(key): \(UsageDashboardPresentation.coverage(result.total.metrics[key]))")
                }
            }.font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).textSelection(.enabled).padding(.top, 8)
        }
        .font(.pilot(.body))
    }

    private var subscriptionSnapshots: some View {
        VStack(alignment: .leading, spacing: 10) {
            HairlineDivider()
            PageSectionHeader(title: "Subscription windows")
            Text("Separate from selected dates and catalog estimates. Cached provider-wide reports may include other apps; never converted to dollars or allocated to this scope.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            if dashboard.subscriptions.isEmpty {
                Text("No cached Local subscription snapshot available.").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
            ForEach(dashboard.subscriptions, id: \.provider) { snapshot in
                VStack(alignment: .leading, spacing: 6) {
                    // Reuse the existing quota interpretation; no provider refresh or polling.
                    ScrollView(.horizontal) { SubscriptionUsageBars(subscriptions: [snapshot], now: Date()) }
                    Text("Local · cached provider report · \(UsageDashboardPresentation.utc(snapshot.fetchedAt))")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    Text(snapshot.displayHelpText(now: Date())).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
            }
        }
    }

    private func refresh(force: Bool = false) {
        // Freeze the observation end until a user action, not on every view init or repaint.
        if force, period != "Custom" {
            window = .preset(days: period == "Today" ? 1 : period == "7 days" ? 7 : period == "30 days" ? 30 : nil, now: Date())
        }
        dashboard.refresh(.init(window: window, filters: filters), force: force)
    }

    private func isExpanded(_ dimension: String) -> Bool {
        if case let .breakdown(active, _) = dashboard.detail { active == dimension } else { false }
    }
    private func title(_ dimension: String) -> String {
        switch dimension {
        case "project": "Projects"
        case "mission": "Missions"
        case "chat": "Chats"
        case "physicalModel": "Physical serving models"
        default: "Purposes · includes background work"
        }
    }
}

/// The actual mounted disclosure control, shared with focused native interaction tests.
struct UsageBreakdownHeader: View {
    let title: String
    let dimension: String
    let expanded: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                DisclosureChevron(expanded: expanded)
                Text(title).font(.pilot(.body, weight: .semibold))
                Spacer()
            }.padding(.vertical, 12).contentShape(Rectangle())
        }
        .rowButtonStyle()
        .accessibilityLabel("\(title), \(expanded ? "expanded" : "collapsed")")
        .accessibilityHint("Show or hide ten groups. No request contents are read.")
        .background(ControlGeometry(id: "usage-breakdown-\(dimension)"))
    }
}

private struct UsageBreakdownRow: View {
    let group: UsageAnalyticsGroup
    let dimension: String
    let filters: UsageQueryFilters?
    let displayName: String?
    let inspect: (String, UsageQueryFilters) -> Void
    var body: some View {
        if let decoded = UsageDashboardPresentation.group(group.key, dimension: dimension, base: filters ?? .init()) {
            Button { inspect(displayName ?? decoded.label, decoded.filters) } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text(displayName ?? decoded.label).font(.pilot(.body)).lineLimit(2)
                    Text("\(UsageDashboardPresentation.number(group.aggregate.metrics["requests"])) requests · \(UsageDashboardPresentation.number(group.aggregate.metrics["estimatedUsdMicros"], currency: true)) · \(group.aggregate.unpriced) unpriced")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    Text("Input \(UsageDashboardPresentation.number(group.aggregate.metrics["input"])) · output \(UsageDashboardPresentation.number(group.aggregate.metrics["output"])) · cache read \(UsageDashboardPresentation.number(group.aggregate.metrics["cacheRead"]))")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 9).padding(.leading, 16)
                    .contentShape(Rectangle())
            }
            .rowButtonStyle().help(decoded.label + " · Inspect observed requests")
            .accessibilityHint("Inspect content-free requests for this exact group")
            HairlineDivider()
        }
    }
}

private struct UsageRequestRow: View {
    let row: UsageObservation
    let names: [String: [String: String]]
    private func name(_ dimension: String) -> String? {
        UsageDashboardPresentation.attributionKey(row, dimension: dimension).flatMap { names[dimension]?[$0] }
    }
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                Text("Input \(UsageFormatting.tokens(row.tokens?.input)) · output \(UsageFormatting.tokens(row.tokens?.output)) · cache read \(UsageFormatting.tokens(row.tokens?.cacheRead)) · cache write \(UsageFormatting.tokens(row.tokens?.cacheWrite))")
                Text("Reasoning \(UsageFormatting.tokens(row.tokens?.reasoning)) · subset of output · \(row.tokens?.reasoningStatus ?? "unknown")")
                Text("Catalog estimate: \(UsageDashboardPresentation.estimate(row.cost?.estimatedUsdMicros)) · \(row.cost?.estimateStatus ?? "unknown") · \(row.cost?.pricingRevision ?? "Unknown pricing revision")")
                Text("Requests \(UsageFormatting.tokens(row.requests)) · observed attempts \(UsageFormatting.tokens(row.providerAttempts)) · observed retries \(UsageFormatting.tokens(row.retries)) · outcome \(row.outcome ?? "unknown")")
                Text("Activity \(row.activity ?? "Unknown") · observed duration \(UsageFormatting.tokens(row.durationMs)) ms")
                Text("Source \(row.sourceId) · operation \(row.operationId) · revision \(UsageFormatting.tokens(row.revision))")
                Text("Project \(name("project") ?? row.attribution?.projectId ?? "Unattributed") · chat \(name("chat") ?? row.attribution?.chatId ?? "Unattributed")")
                if let mission = row.attribution?.mission {
                    if let title = name("mission") { Text("Mission \(title)") }
                    Text("Mission \(mission.homeId) / \(mission.lineageId) / \(mission.missionId)")
                }
                if let chatId = row.attribution?.chatId { Text("Chat ID \(chatId)") }
                if let projectId = row.attribution?.projectId { Text("Project ID \(projectId)") }
                if let virtual = row.virtualModel {
                    Text("Observed virtual selection \(virtual.provider)/\(virtual.model) · revision \(row.virtualRevision ?? "Unknown")")
                }
            }.font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).textSelection(.enabled).padding(.vertical, 8)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                if let chat = name("chat") { Text(chat).lineLimit(2) }
                let context = [name("project"), name("mission")].compactMap { $0 }.joined(separator: " · ")
                if !context.isEmpty { Text(context).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(2) }
                Text(row.completedAt.map(UsageDashboardPresentation.utc) ?? "Undated checkpoint · non-additive")
                Text("\(UsageDashboardPresentation.purpose(row.purpose)) · \(row.physicalModel.map { $0.provider + "/" + $0.model } ?? "Unknown physical model") · \(row.scope) · \(row.coverage)")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }
        HairlineDivider()
    }
}

struct UsageTrendChart: View {
    let points: [UsageTrendPoint]
    let window: UsageDashboardWindow
    var body: some View {
        Chart(points) { point in
            if let tokens = point.tokens {
                // Explicit UTC extents avoid calendar midpoint alignment and partial-day overflow.
                RectangleMark(xStart: .value("UTC day start", point.date.addingTimeInterval(0.12 * 86_400)),
                        xEnd: .value("UTC day end", point.date.addingTimeInterval(0.88 * 86_400)),
                        yStart: .value("Baseline", 0), yEnd: .value("Observed tokens", tokens))
                    .foregroundStyle(Theme.chart1)
                    .accessibilityLabel(UsageDashboardPresentation.utc(point.milliseconds))
                    .accessibilityValue("\(UsageFormatting.tokens(tokens)) observed input and output tokens, partial")
            }
        }
        .chartXScale(domain: UsageDashboardPresentation.chartWindow(window))
        .chartYScale(domain: .automatic(includesZero: true))
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine()
                AxisValueLabel { if let tokens = value.as(Double.self) { Text(UsageFormatting.tokens(tokens)) } }
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: max(1, Int(ceil((window.to - window.from) / UsageDashboardPresentation.day / 4))))) {
                AxisValueLabel(format: .dateTime.day().month(.abbreviated))
            }
        }
        .chartPlotStyle { $0.clipped().background(ControlGeometry(id: "usage-chart-plot")) }
        .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
        .frame(height: 180)
        .background(ControlGeometry(id: "usage-chart"))
    }
}

private struct UsageCustomRange: View {
    @Environment(\.dismiss) private var dismiss
    @State private var first: Date
    @State private var last: Date
    @State private var error: String?
    let apply: (UsageDashboardWindow) -> Void
    init(window: UsageDashboardWindow, apply: @escaping (UsageDashboardWindow) -> Void) {
        _first = State(initialValue: Date(timeIntervalSince1970: window.from / 1000))
        _last = State(initialValue: Date(timeIntervalSince1970: (window.to - 1) / 1000))
        self.apply = apply
    }
    var body: some View {
        SheetScaffold("Custom usage dates", subtitle: "UTC days · up to 366 days · both dates included", error: error,
                      primary: SheetPrimaryAction(title: "Apply", action: {
                          guard let window = UsageDashboardWindow.custom(first: first, last: last, now: Date()) else {
                              error = "Choose up to 366 days, no later than today."; return
                          }
                          apply(window); dismiss()
                      })) {
            DatePicker("First day", selection: $first, in: ...Date(), displayedComponents: .date)
            DatePicker("Last day", selection: $last, in: ...Date(), displayedComponents: .date)
        }
        .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
    }
}

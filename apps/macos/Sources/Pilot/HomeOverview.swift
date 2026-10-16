import PilotCore
import SwiftUI

/// One project's line on Home: what its chats are doing, its active missions and when it last moved.
struct HomeProjectStatus: Identifiable, Equatable {
    let project: Project
    let counts: ProjectDashboardCount
    let readyToMerge: Int
    /// Active missions, newest first.
    let missions: [Mission]
    /// Latest chat activity in epoch milliseconds, nil without chats.
    let lastActivity: Double?

    var id: String { project.id }

    /// The most urgent state, in the sidebar's order: failed, needs you, ready to merge, working.
    var signal: SessionSignal? {
        if (counts.needsYouReasons?["failed"] ?? 0) > 0 { return .failed }
        if counts.needsYou > 0 { return .needsYou }
        if readyToMerge > 0 { return .readyToMerge }
        if counts.working > 0 { return .working }
        return nil
    }

    /// Something is working, waiting on the user or ready, or a mission is under way.
    var isActive: Bool { signal != nil || !missions.isEmpty }

    /// "2 working · 1 needs you · 1 ready to merge", or "Quiet" when none.
    var countsLine: String {
        var parts: [String] = []
        if counts.working > 0 { parts.append("\(counts.working) working") }
        if counts.needsYou > 0 { parts.append(SidebarScopeCounts.needsYou(counts.needsYou)) }
        if readyToMerge > 0 { parts.append("\(readyToMerge) ready to merge") }
        return parts.isEmpty ? "Quiet" : parts.joined(separator: " · ")
    }

    /// "Release: 3 of 12 tasks" for one active mission, "2 missions: 7 of 20 tasks" for several. nil without one.
    var missionLine: String? {
        guard let first = missions.first else { return nil }
        let known = missions.filter { $0.tasksTotal != nil }
        let total = known.reduce(0) { $0 + max(0, $1.tasksTotal ?? 0) }
        let done = known.reduce(0) { $0 + min(max(0, $1.tasksDone ?? 0), max(0, $1.tasksTotal ?? 0)) }
        let progress = total > 0 ? "\(done) of \(total) \(total == 1 ? "task" : "tasks")" : nil
        let name = missions.count == 1 ? first.title : "\(missions.count) missions"
        return progress.map { "\(name): \($0)" } ?? name
    }
}

/// Home's figures, from the snapshots pilotd already sends: project counts, chat summaries and missions.
enum HomeStatus {
    static let previewLimit = 5
    static let projectLimit = 8

    /// One row per project, most urgent first, then most recently active, then by name.
    static func projects(_ projects: [Project], counts: [String: ProjectDashboardCount], sessions: [SessionSummary],
                         missions: [Mission]) -> [HomeProjectStatus] {
        var ready: [String: Int] = [:]
        var latest: [String: Double] = [:]
        for session in sessions where !session.isArchived {
            guard let id = session.projectId else { continue }
            if session.isReadyToMerge { ready[id, default: 0] += 1 }
            latest[id] = max(latest[id] ?? 0, session.listActivityAt)
        }
        var active: [String: [Mission]] = [:]
        for mission in missions where mission.status == .active { active[mission.projectId, default: []].append(mission) }
        let rows = projects.map { project in
            HomeProjectStatus(project: project, counts: counts[project.id] ?? ProjectDashboardCount(),
                              readyToMerge: ready[project.id] ?? 0,
                              missions: (active[project.id] ?? []).sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) },
                              lastActivity: latest[project.id])
        }
        return rows.sorted { lhs, rhs in
            let left = rank(lhs), right = rank(rhs)
            if left != right { return left < right }
            if (lhs.lastActivity ?? 0) != (rhs.lastActivity ?? 0) { return (lhs.lastActivity ?? 0) > (rhs.lastActivity ?? 0) }
            return (lhs.project.name.localizedLowercase, lhs.id) < (rhs.project.name.localizedLowercase, rhs.id)
        }
    }

    private static func rank(_ row: HomeProjectStatus) -> Int {
        switch row.signal {
        case .failed: 0
        case .needsYou: 1
        case .readyToMerge: 2
        case .working: 3
        case nil: row.missions.isEmpty ? 5 : 4
        }
    }

    /// Project rows under their folder headings (folder order, ungrouped last), most urgent first within each, cut to
    /// the first `limit` rows in that order. Empty folders are left out.
    static func folderSections(_ rows: [HomeProjectStatus], folders: ProjectFolders,
                               limit: Int? = nil) -> [ProjectFolderSection<HomeProjectStatus>] {
        var remaining = limit ?? .max
        return folders.sections(rows, projectId: \.project.id).compactMap { section -> ProjectFolderSection<HomeProjectStatus>? in
            guard remaining > 0 else { return nil }
            let items = Array(section.items.prefix(remaining))
            remaining -= items.count
            return ProjectFolderSection(folder: section.folder, items: items)
        }
    }

    /// What the Inbox lists: Needs you, Ready to merge, Linear and Slack, across projects.
    static func inboxCount(_ rows: [HomeProjectStatus]) -> Int {
        rows.reduce(0) { $0 + $1.counts.needsYou + $1.readyToMerge + $1.counts.tracked }
    }

    /// "3 projects are active: 3 chats are working and 1 mission is moving. 7 things wait in your Inbox."
    static func summary(_ rows: [HomeProjectStatus]) -> String {
        let active = rows.filter(\.isActive).count
        let working = rows.reduce(0) { $0 + $1.counts.working }
        let missions = rows.reduce(0) { $0 + $1.missions.count }
        let inbox = inboxCount(rows)
        if active == 0 && inbox == 0 { return "All quiet. Nothing is working and your Inbox is empty." }
        var first: String
        if active == 0 {
            first = "Nothing is working."
        } else {
            first = "\(active) \(active == 1 ? "project is" : "projects are") active"
            let details = [
                working > 0 ? "\(working) \(working == 1 ? "chat is" : "chats are") working" : nil,
                missions > 0 ? "\(missions) \(missions == 1 ? "mission is" : "missions are") moving" : nil,
            ].compactMap { $0 }
            first += details.isEmpty ? "." : ": \(details.joined(separator: " and "))."
        }
        let second = inbox > 0 ? "\(inbox) \(inbox == 1 ? "thing waits" : "things wait") in your Inbox."
            : "Your Inbox is empty."
        return "\(first) \(second)"
    }

    /// Working chats, most recently active first.
    static func working(_ sessions: [SessionSummary]) -> [SessionSummary] {
        sessions.filter { !$0.isArchived && $0.isWorking }
            .sorted { ($0.listActivityAt, $0.id) > ($1.listActivityAt, $1.id) }
    }

    /// Account-wide subscription usage, once per provider (Claude, then Codex): the newest snapshot with limits
    /// that any chat carries. pilotd forwards its cached readings with chat updates, so Home adds no polling.
    static func subscriptions(_ sessions: [SessionSummary]) -> [SubscriptionUsage] {
        var newest: [SubscriptionProvider: SubscriptionUsage] = [:]
        for session in sessions {
            guard let usage = session.usage?.subscription, let provider = usage.provider,
                  !usage.homeWindows.isEmpty, usage.fetchedAt > (newest[provider]?.fetchedAt ?? -.infinity)
            else { continue }
            newest[provider] = usage
        }
        return [SubscriptionProvider.anthropic, .openai].compactMap { newest[$0] }
    }

    /// Active missions first, then done and archived, newest first within each.
    static func missions(_ missions: [Mission]) -> [Mission] {
        missions.sorted {
            let lhsRank = rank($0.status)
            let rhsRank = rank($1.status)
            if lhsRank != rhsRank { return lhsRank < rhsRank }
            return ($0.createdAt, $0.id) > ($1.createdAt, $1.id)
        }
    }

    private static func rank(_ status: MissionStatus) -> Int {
        switch status {
        case .active: 0
        case .done: 1
        case .archived: 2
        }
    }

    static func coordinator(_ mission: Mission, sessionIds: Set<String>) -> String? {
        mission.coordinatorSessionId.flatMap { sessionIds.contains($0) ? $0 : nil }
    }
}

/// Home below the composer: one reading column that watches every project. A summary sentence, then Projects (under
/// the user's folder headings, as in the project picker), Activity, Working now and Missions. What needs the user
/// lives in the Inbox, so Home lists no Needs you or Ready to merge rows and no diff counts.
struct HomeOverview: View {
    @Environment(\.hostViewContext) private var hostContext
    @EnvironmentObject private var app: AppModel
    @ObservedObject private var hosts = AppModel.shared.hosts
    @EndpointClient private var client
    @State private var allProjects = false
    @State private var allWorking = false
    @State private var allMissions = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            content(now: context.date)
        }
    }

    private struct RemoteProject: Identifiable {
        let ref: HostResourceRef
        let status: HomeProjectStatus
        var id: HostResourceRef { ref }
    }
    private var remoteProjects: [RemoteProject] {
        Set(hosts.projects.map { $0.ref.host }).filter { $0 != app.localHost }.flatMap { host in
            let client = hosts.presentationClient(host)
            return HomeStatus.projects(client.projects, counts: client.projectCounts.projects,
                sessions: client.sessions, missions: client.missions).map {
                    RemoteProject(ref: HostResourceRef(host: host, kind: .project, localId: $0.project.id), status: $0)
                }
        }.sorted { $0.status.project.name < $1.status.project.name }
    }

    private func content(now: Date) -> some View {
        let rows = HomeStatus.projects(client.projects, counts: client.projectCounts.projects,
                                       sessions: client.sessions, missions: client.missions)
        let remoteRows = remoteProjects
        let remoteWorking = hosts.sessions.filter { $0.ref.host != app.localHost && hosts.available.contains($0.ref.host) && $0.value.isWorking && !$0.value.isArchived }
        let remoteMissions = hosts.missions.filter { $0.ref.host != app.localHost && $0.value.status == .active }
        let working = HomeStatus.working(client.sessions)
        let missions = HomeStatus.missions(client.missions)
        let sessionIds = Set(client.sessions.map(\.id))
        return VStack(alignment: .leading, spacing: 32) {
            VStack(alignment: .leading, spacing: 6) {
                if !client.connected {
                    Text(client.hasProjectSnapshot ? "Waiting to reconnect. Showing the last known figures." : "Connecting to Pilot…")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                if client.hasProjectSnapshot {
                    Text(HomeStatus.summary(rows + remoteRows.map(\.status)))
                        .font(.pilot(.headline)).foregroundStyle(Theme.foreground)
                        .fixedSize(horizontal: false, vertical: true)
                }
                let subscriptions = HomeStatus.subscriptions(client.sessions)
                if !subscriptions.isEmpty {
                    SubscriptionUsageBars(subscriptions: subscriptions, now: now).padding(.top, 4)
                }
            }

            section {
                PageSectionHeader(title: "Projects", count: rows.count + remoteRows.count, linkTitle: "Add project") { app.addProject() }
                if rows.isEmpty {
                    quietLine(client.hasProjectSnapshot ? "Add a project to see how it’s doing." : "Loading projects…")
                }
                let sections = HomeStatus.folderSections(rows, folders: app.projectFolders,
                                                         limit: allProjects ? nil : HomeStatus.projectLimit)
                // Headings only once the user has folders; "Other projects" then names the ungrouped rest.
                let headed = sections.contains { $0.folder != nil }
                ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
                    if headed {
                        folderHeading(section.folder?.name ?? "Other projects", first: index == 0)
                    }
                    ForEach(Array(section.items.enumerated()), id: \.element.id) { index, row in
                        if index > 0 { HairlineDivider(leading: 8) }
                        projectRow(row, now: now)
                    }
                }
                ForEach(allProjects ? remoteRows : Array(remoteRows.prefix(HomeStatus.projectLimit))) { item in
                    HairlineDivider(leading: 8)
                    projectRow(item.status, now: now, context: HostViewContext(host: item.ref.host, hosts: hosts))
                }
                if rows.count + remoteRows.count > HomeStatus.projectLimit { listToggle(count: rows.count + remoteRows.count, expanded: $allProjects) }
            }

            section {
                ActivityStrip(days: client.activityDays(now: now))
            }

            section {
                PageSectionHeader(title: "Working now", count: working.count + remoteWorking.count)
                if working.isEmpty && remoteWorking.isEmpty { quietLine("Nothing is running. Start a task above.") }
                let shown = allWorking ? working : Array(working.prefix(HomeStatus.previewLimit))
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, session in
                    if index > 0 { HairlineDivider(leading: 8) }
                    workingRow(session, now: now)
                }
                ForEach(allWorking ? remoteWorking : Array(remoteWorking.prefix(HomeStatus.previewLimit))) { item in
                    HairlineDivider(leading: 8)
                    workingRow(item.value, now: now, context: HostViewContext(host: item.ref.host, hosts: hosts))
                }
                if working.count + remoteWorking.count > HomeStatus.previewLimit { listToggle(count: working.count + remoteWorking.count, expanded: $allWorking) }
            }

            section {
                PageSectionHeader(title: "Missions", count: missions.count + remoteMissions.count)
                if missions.isEmpty {
                    quietLine(client.hasProjectSnapshot ? "No missions yet." : "Loading missions…")
                }
                let shown = allMissions ? missions : Array(missions.prefix(HomeStatus.previewLimit))
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, mission in
                    if index > 0 { HairlineDivider(leading: 30) }
                    missionRow(mission, sessionIds: sessionIds)
                }
                ForEach(allMissions ? remoteMissions : Array(remoteMissions.prefix(HomeStatus.previewLimit))) { item in
                    HairlineDivider(leading: 30)
                    missionRow(item.value, sessionIds: Set(hosts.sessions.filter { $0.ref.host == item.ref.host }.map { $0.value.id }), context: HostViewContext(host: item.ref.host, hosts: hosts))
                }
                if missions.count + remoteMissions.count > HomeStatus.previewLimit { listToggle(count: missions.count + remoteMissions.count, expanded: $allMissions) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func section<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6, content: content)
    }

    /// A project folder's heading, styled like the project picker's: a small faint label, not collapsible.
    private func folderHeading(_ title: String, first: Bool) -> some View {
        Text(title)
            .font(.pilot(.caption, weight: .semibold))
            .foregroundStyle(Theme.faintForeground)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.top, first ? 2 : 10)
            .accessibilityAddTraits(.isHeader)
    }

    private func projectRow(_ row: HomeProjectStatus, now: Date, context: HostViewContext? = nil) -> some View {
        let owner = context ?? hostContext
        let activity = row.lastActivity.map { SessionTimeFormatting.relative($0, now: now) }
        let label = [row.project.name, row.countsLine, row.missionLine,
                     activity.map { "last active \($0) ago" }].compactMap { $0 }.joined(separator: ", ")
        return Button { app.openProject(row.project.id, context: owner) } label: {
            HoverRow { _ in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.project.name).font(.pilot(.body, weight: .medium)).foregroundStyle(Theme.foreground)
                            .lineLimit(1)
                        RowLine(segments: [RowLineSegment(.text(context.map { $0.name + " · " + ($0.available ? row.countsLine : "Disconnected") } ?? row.countsLine))]
                            + (row.missionLine.map { [RowLineSegment(.mission(id: nil, title: $0))] } ?? []),
                            maxLines: 2, font: .pilot(.caption))
                    }
                    Spacer(minLength: 8)
                    if let activity {
                        Text(activity).font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                            .fixedSize()
                            .help("Last activity")
                    }
                }
            }
            .homeCorner(row.signal)
        }
        .rowButtonStyle()
        .help("Open \(row.project.name) Overview")
        .accessibilityLabel(label + ". Open Overview.")
        .contextMenu {
            Button("Open Overview") { app.openProject(row.project.id, context: owner) }
            Button("New Chat") { app.newSession(in: row.project.id, context: owner) }
        }
    }

    private func workingRow(_ session: SessionSummary, now: Date, context: HostViewContext? = nil) -> some View {
        let owner = context ?? hostContext
        let client = context.map { $0.hosts.presentationClient($0.host) } ?? self.client
        let project = client.project(session.projectId)?.name ?? session.cwd.abbreviatingHome
        let mission = session.missionId.flatMap { id in client.missions.first { $0.id == id }?.title }
        let elapsed = SessionTimeFormatting.relative(session.listActivityAt, now: now)
        return Button { app.navigate(.session, id: session.id, context: owner) } label: {
            HoverRow { _ in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(session.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                        RowLine(segments: RowLineSegments.session(nil, projectName: project, missionTitle: mission),
                                maxLines: 2, font: .pilot(.caption))
                    }
                    Spacer(minLength: 8)
                    HStack(spacing: 10) {
                        PullRequestBadge(session: session)
                        Text(elapsed).font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                            .fixedSize()
                            .help("Last update")
                    }
                }
            }
            .homeCorner(.working)
        }
        .rowButtonStyle()
        .accessibilityLabel([session.title, project, mission, "working"].compactMap { $0 }.joined(separator: ", "))
        .contextMenu {
            Button("Open Chat") { app.navigate(.session, id: session.id, context: owner) }
            SessionProjectAction(session: session).environment(\.hostViewContext, owner)
            Button("Stop Chat") { app.stopSession(owner?.ref(.session, session.id).storageKey ?? session.id) }
        }
    }

    private func missionRow(_ mission: Mission, sessionIds: Set<String>, context: HostViewContext? = nil) -> some View {
        let owner = context ?? hostContext
        let client = context.map { $0.hosts.presentationClient($0.host) } ?? self.client
        let members = client.sessions.filter { $0.missionId == mission.id && !$0.isArchived }
        let progress = mission.status == .active
            ? MissionSidebarSummary.progress(mission: mission, working: members.filter(\.isWorking).count)
            : mission.status.label
        let detail = [client.project(mission.projectId)?.name, progress].compactMap { $0 }.joined(separator: " · ")
        let signal = mission.status == .active
            ? MissionSidebarSummary.signal(mission: mission, members: members, isUnread: app.isUnread) : nil
        return HoverRow { _ in
            HStack(spacing: 10) {
                Button { app.openMission(mission.id, context: owner) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        PilotSymbol(PilotIcon.mission, context: .row).foregroundStyle(Theme.mutedForeground)
                            .frame(width: 14).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(mission.title).font(.pilot(.body, weight: .medium))
                                .foregroundStyle(mission.status == .active ? Theme.foreground : Theme.mutedForeground)
                                .lineLimit(1).help(mission.title)
                            Text(detail).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                    }
                    .contentShape(Rectangle())
                }
                .rowButtonStyle()
                .accessibilityLabel("\(mission.title), \(detail). Open mission.")
                let count = mission.status == .active ? mission.needsYouCount ?? 0 : 0
                let coordinator = HomeStatus.coordinator(mission, sessionIds: sessionIds)
                HStack(spacing: 10) {
                    if count > 0 {
                        CountBadge(count: count, style: .attention).help("\(count) questions or blocked tasks need you")
                            .accessibilityLabel("\(count) questions or blocked tasks need you")
                    }
                    if let coordinator {
                        Button { app.navigate(.session, id: coordinator, context: owner) } label: {
                            Label("Coordinator", icon: PilotIcon.coordinator)
                                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).fixedSize()
                        }
                        .buttonStyle(.plain)
                        .help("Open the coordinator chat for \(mission.title)")
                        .accessibilityLabel("Open coordinator for \(mission.title)")
                    }
                }
            }
        }
        .homeCorner(signal)
    }

    private func quietLine(_ text: String) -> some View {
        Text(text).font(.pilot(.body)).foregroundStyle(Theme.faintForeground)
            .padding(.horizontal, 8).padding(.vertical, 4)
    }

    private func listToggle(count: Int, expanded: Binding<Bool>) -> some View {
        ListToggle(total: count, expanded: expanded)
            .padding(.leading, 8)
    }
}

/// Chats started per day over the last 14 days, as a compact bar strip beside its total.
private struct ActivityStrip: View {
    let days: [(label: String, count: Int)]

    var body: some View {
        let total = days.reduce(0) { $0 + $1.count }
        let peak = max(1, days.map(\.count).max() ?? 1)
        VStack(alignment: .leading, spacing: 8) {
            PageSectionHeader(title: "Activity")
            HStack(alignment: .bottom, spacing: 16) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("\(total)").font(.pilot(.title, weight: .semibold)).monospacedDigit()
                        .foregroundStyle(Theme.foreground)
                    Text("chats · 14 days").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                .fixedSize()
                HStack(alignment: .bottom, spacing: 4) {
                    ForEach(Array(days.enumerated()), id: \.offset) { index, day in
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(index == days.count - 1 ? Theme.info : Theme.info.opacity(0.55))
                            .frame(height: max(2, CGFloat(day.count) / CGFloat(peak) * 32))
                            .frame(maxWidth: .infinity)
                            .help("\(day.count) \(day.count == 1 ? "chat" : "chats")")
                    }
                }
                .frame(height: 32, alignment: .bottom)
                .accessibilityHidden(true)
            }
            .padding(.horizontal, 8)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Activity: \(total) chats started in the last 14 days")
    }
}

/// Subscription usage, shown once on Home under the summary: quiet bars per provider for its 5-hour and weekly
/// limits, then extra-usage spend against its monthly cap when the provider reports it. A window past 80% turns its
/// bar amber; for limits, chats then also show one line above their composer.
struct SubscriptionUsageBars: View {
    let subscriptions: [SubscriptionUsage]
    let now: Date

    var body: some View {
        let columns = SubscriptionUsage.columns(subscriptions)
        VStack(alignment: .leading, spacing: 4) {
            ForEach(subscriptions, id: \.provider) { usage in
                let stale = usage.isStale(now: now)
                HStack(spacing: 12) {
                    widest(subscriptions.map(\.providerLabel), alignment: .leading) {
                        Text(usage.providerLabel).foregroundStyle(stale ? Theme.mutedForeground : Theme.foreground)
                    }
                    HStack(spacing: 20) {
                        ForEach(columns, id: \.self) { column in
                            cell(column, window: usage.window(inColumn: column))
                        }
                    }
                }
                .fixedSize()
                .help(usage.displayHelpText(now: now))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(accessibilityLabel(usage, stale: stale))
            }
        }
        .font(.pilot(.caption))
        .monospacedDigit()
        .foregroundStyle(Theme.mutedForeground)
    }

    /// One window: label, bar, value (percent, or spend for extra usage). A provider without this window keeps the
    /// cell's width, empty, so columns line up across rows. Every row shows the same label in a column, so only the
    /// value needs a shared width.
    private func cell(_ column: String, window: SubscriptionWindow?) -> some View {
        let values = ["100%"] + subscriptions.compactMap { $0.window(inColumn: column)?.valueLabel }
        return HStack(spacing: 6) {
            Text(column)
            bar(window)
            widest(values, alignment: .trailing) { Text(window?.valueLabel ?? "") }
        }
        .opacity(window == nil ? 0 : 1)
    }

    /// Sizes `content` to the widest of `texts` so a column keeps one width in every row.
    private func widest(_ texts: [String], alignment: Alignment, @ViewBuilder content: () -> some View) -> some View {
        ZStack(alignment: alignment) {
            ForEach(Array(Set(texts)).sorted(), id: \.self) { Text($0).hidden() }
            content()
        }
    }

    private func bar(_ window: SubscriptionWindow?) -> some View {
        let fraction = window?.gaugeFraction ?? 0
        let warning = (window?.usedPercent ?? 0) >= SubscriptionUsage.noticePercent
        return ZStack(alignment: .leading) {
            Capsule().fill(Theme.border)
            Capsule()
                .fill(warning ? Theme.warning : Theme.faintForeground)
                .frame(width: 48 * fraction)
        }
        .frame(width: 48, height: 4)
    }

    private func accessibilityLabel(_ usage: SubscriptionUsage, stale: Bool) -> String {
        let windows = usage.homeWindows.map { window in
            guard let extra = window.extraUsage else { return "\(window.limitName) limit \(window.percentLabel) used" }
            return "extra usage " + (extra.cap.map { "\(extra.spent) of \($0)" } ?? extra.spent) + " spent"
        }
        return "\(usage.providerLabel) subscription: " + windows.joined(separator: ", ") + (stale ? ", not recent" : "")
    }
}

private extension View {
    /// The sidebar's dithered status corner on a Home row, with trailing room so text stays off its densest cells.
    func homeCorner(_ signal: SessionSignal?) -> some View {
        padding(.trailing, 24).ditherCorner(signal)
    }
}

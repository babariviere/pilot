import AppKit
import PilotCore
import SwiftUI

/// A project's status page: what needs the user, what is running, open pull requests, active missions
/// and recent results. Built from pilotd's project dashboard, which stays live over the WebSocket while
/// the page is visible (no polling). Same shape as the mission Overview: one reading column, a headline
/// summary and hairline-row sections, with the title and actions in the window toolbar.
struct ProjectPage: View {
    let projectId: String
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @Environment(\.openSettings) private var openSettings
    @State private var showingArtifacts = false
    @State private var showingMemory = false
    /// The tracked items sheet: every source from the … menu, or one source from its page section.
    @State private var trackedSheet: TrackedSheetScope?
    /// Navigation requested from the tracked items sheet, run once it has closed.
    @State private var afterTracked: (() -> Void)?
    /// Start chat / Start mission on the page's Current cycle and Tracked rows.
    @StateObject private var trackedActions = TrackedItemActions()
    @State private var retrying = false
    @State private var fullList: ProjectFullList?
    @State private var fullListDashboard: ProjectDashboard?
    @State private var fullListError: String?

    var body: some View {
        Group {
            if let project = client.project(projectId) {
                content(project)
                    .navigationTitle(project.name)
                    .navigationSubtitle(project.path.abbreviatingHome)
                    .toolbar {
                        ProjectToolbar(project: project, model: model,
                                       openSettings: { openProjectSettings(project) },
                                       showArtifacts: { showingArtifacts = true },
                                       showTracked: { trackedSheet = .all })
                    }
                    .sheet(isPresented: $showingArtifacts) {
                        ProjectArtifactsBrowser(project: project, client: client)
                    }
                    .sheet(isPresented: $showingMemory) {
                        ProjectMemoryBrowser(project: project, client: client)
                    }
                    .sheet(item: $trackedSheet, onDismiss: {
                        let next = afterTracked
                        afterTracked = nil
                        next?()
                    }) { scope in
                        TrackedInboxSheet(project: project, kinds: scope.kinds,
                                          openSettings: { openProjectSettings(project) }) { next in
                            afterTracked = next
                            trackedSheet = nil
                        }
                    }
                    .sheet(item: $fullList) { list in
                        ProjectFullListSheet(project: project, list: list, dashboard: fullListDashboard,
                                             scheduled: scheduled, error: fullListError) {
                            Task { await loadFullList(projectId: project.id) }
                        }
                        .task { await loadFullList(projectId: project.id) }
                    }
            } else if client.hasProjectSnapshot {
                EmptyStateView(icon: "folder", title: "This project no longer exists",
                               message: "It was removed from Pilot. Its folder is unchanged.")
            } else {
                ProgressView("Loading project…")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .dashboardSubscription(projectId, client: client)
    }

    @ViewBuilder
    private func content(_ project: Project) -> some View {
        if let dashboard = client.projectDashboards[projectId] {
            let banner = stale ? ProjectRefreshBanner(receivedAt: client.dashboardReceivedAt[projectId],
                                                      error: client.dashboardErrors[projectId],
                                                      retrying: retrying, retry: retry) : nil
            let scheduled = scheduled
            if dashboard.summary.chats == 0, dashboard.missions.total == 0, dashboard.memory == nil,
               dashboard.needsYou.total == 0, scheduled.isEmpty, dashboard.tracked.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        banner
                        EmptyStateView(icon: "folder", title: "Start the first chat",
                                       message: "Chats, pull requests and missions for \(project.name) appear here.") {
                            Button("New Chat") { model.newSession(in: project.id) }
                                .buttonStyle(.borderedProminent)
                            Button("New Mission…") { model.missionSheet = .create(projectId: project.id) }
                        }
                    }
                    .padding(.horizontal, 32)
                    .padding(.vertical, 24)
                    .frame(maxWidth: Theme.column, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            } else {
                ProjectDashboardBody(project: project, dashboard: dashboard,
                                     needsYou: dashboard.needsYou, scheduled: scheduled,
                                     banner: banner, showFullList: showFullList,
                                     browseMemory: { showingMemory = true },
                                     trackedActions: trackedActions,
                                     showTracked: { trackedSheet = $0 },
                                     openSettings: { openProjectSettings(project) })
            }
        } else if let error = client.dashboardErrors[projectId] {
            EmptyStateView(icon: "exclamationmark.triangle", title: "Couldn't load this project", message: error) {
                Button("Retry", action: retry).disabled(retrying)
            }
        } else {
            ProgressView("Loading project…")
        }
    }

    /// Live updates have stopped: the socket is down, or an explicit refresh failed.
    private var stale: Bool {
        !client.connected || client.dashboardErrors[projectId] != nil
    }

    /// Pending items from the live schedule list, which also carries what editing needs. Failed ones are
    /// listed under Needs you by pilotd's dashboard.
    private var scheduled: [ScheduledItem] {
        ScheduleText.listed(client.schedules, projectId: projectId, includeFailed: false)
    }

    private func retry() {
        guard !retrying else { return }
        retrying = true
        Task {
            await client.refreshDashboard(projectId)
            retrying = false
        }
    }

    private func loadFullList(projectId: String) async {
        guard fullListDashboard == nil else { return }
        fullListError = nil
        do { fullListDashboard = try await client.fullProjectDashboard(projectId) }
        catch { fullListError = error.localizedDescription }
    }

    private func showFullList(_ section: ProjectFullList) {
        fullListDashboard = nil
        fullListError = nil
        fullList = section
    }

    private func openProjectSettings(_ project: Project) {
        model.settingsTab = .project(project.id)
        openSettings()
    }
}

/// New chat (with New mission in its menu) and the project's secondary actions.
private struct ProjectToolbar: ToolbarContent {
    let project: Project
    let model: AppModel
    let openSettings: () -> Void
    let showArtifacts: () -> Void
    let showTracked: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button { model.newSession(in: project.id) } label: { Label("New Chat", systemImage: "plus") }
                Button { model.missionSheet = .create(projectId: project.id) } label: {
                    Label("New Mission…", systemImage: "scope")
                }
            } label: {
                Label("New chat", systemImage: "plus")
                    .labelStyle(.titleAndIcon)
            } primaryAction: {
                model.newSession(in: project.id)
            }
            .help("Start a chat in \(project.name)")
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button(action: showTracked) { Label("Tracked Items…", systemImage: "tray") }
                Button(action: openSettings) { Label("Project Settings…", systemImage: "gearshape") }
                Button { NSWorkspace.shared.open(URL(filePath: project.path)) } label: {
                    Label("Open in Finder", systemImage: "folder")
                }
                Divider()
                Button { model.showArchive(in: project.id) } label: {
                    Label("Browse Archived Chats", systemImage: "archivebox")
                }
                Button(action: showArtifacts) { Label("Artifacts…", systemImage: "cube.transparent") }
                Divider()
                if model.sidebarScope == project.id {
                    Button { model.focus(on: nil) } label: {
                        Label("Show All Projects", systemImage: "square.grid.2x2")
                    }
                } else {
                    Button { model.focus(on: project.id) } label: {
                        Label("Focus on This Project", systemImage: "sidebar.left")
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuIndicator(.hidden)
            .help("Project actions")
            .accessibilityLabel("Project actions")
        }
    }
}

/// The populated page. One minute timeline keeps relative times current without per-row timers.
private struct ProjectDashboardBody: View {
    let project: Project
    let dashboard: ProjectDashboard
    let needsYou: DashboardSection<DashboardNeedsYouItem>
    let scheduled: [ScheduledItem]
    let banner: ProjectRefreshBanner?
    let showFullList: (ProjectFullList) -> Void
    let browseMemory: () -> Void
    @ObservedObject var trackedActions: TrackedItemActions
    let showTracked: (TrackedSheetScope) -> Void
    let openSettings: () -> Void
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                sections(now: context.date)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 24)
                    .frame(maxWidth: Theme.column, alignment: .leading)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private func sections(now: Date) -> some View {
        let client = model.client
        let hiddenNeeds = dashboard.needsYou.total - needsYou.total
        return VStack(alignment: .leading, spacing: 28) {
            if let banner { banner }
            VStack(alignment: .leading, spacing: 8) {
                Text(ProjectPageText.headline(dashboard.summary, needsYou: dashboard.summary.needsYou - hiddenNeeds,
                                              lastFinishedAt: dashboard.recent.items.first?.outcomeAt, now: now))
                    .font(.pilot(.headline))
                    .lineSpacing(3)
                    .foregroundStyle(Theme.foreground)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 5) {
                    let meta = ProjectPageText.meta(project: project, activeMissions: dashboard.summary.activeMissions)
                    ForEach(Array(meta.enumerated()), id: \.offset) { index, part in
                        if index > 0 { Text("·") }
                        Text(part).lineLimit(1)
                    }
                }
                .font(.pilot(.caption))
                .foregroundStyle(Theme.mutedForeground)
            }

            ProjectPageSection(header: PageSectionHeader(title: "Needs you", count: needsYou.total, countStyle: .attention)) {
                if needsYou.items.isEmpty {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle").foregroundStyle(Theme.success).frame(width: 16)
                        Text("Nothing is waiting on you.").foregroundStyle(Theme.mutedForeground)
                    }
                    .font(.pilot(.body))
                    .padding(.horizontal, 8).padding(.vertical, 4)
                }
                ForEach(Array(needsYou.items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { HairlineDivider(leading: 34) }
                    ProjectNeedsYouRow(item: item, now: now)
                }
                ProjectMoreLine(hidden: needsYou.hiddenCount, total: needsYou.total + needsYou.hiddenCount,
                                noun: "need you") { showFullList(.needsYou) }
            }

            if !dashboard.working.items.isEmpty {
                ProjectPageSection(header: PageSectionHeader(title: "Working now", count: dashboard.working.total)) {
                    ForEach(Array(dashboard.working.items.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { HairlineDivider(leading: 34) }
                        ProjectWorkingRow(item: item, status: client.session(item.sessionId)?.status ?? .working, now: now)
                    }
                    ProjectMoreLine(hidden: dashboard.working.hiddenCount, total: dashboard.working.total,
                                    noun: "working") { showFullList(.working) }
                }
            }

            if !dashboard.pullRequests.items.isEmpty {
                ProjectPageSection(header: PageSectionHeader(title: "Pull requests", count: dashboard.pullRequests.total)) {
                    let ready = dashboard.pullRequests.items.filter(\.isReady)
                    let other = dashboard.pullRequests.items.filter { !$0.isReady }
                    if !ready.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            PageSectionHeader(title: "Ready to merge", count: ready.count)
                            ForEach(Array(ready.enumerated()), id: \.element.id) { index, pr in
                                if index > 0 { HairlineDivider(leading: 34) }
                                ProjectPullRequestRow(pr: pr)
                            }
                        }
                    }
                    if !other.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            PageSectionHeader(title: ready.isEmpty ? "Open pull requests" : "Other pull requests",
                                              count: other.count)
                            ForEach(Array(other.enumerated()), id: \.element.id) { index, pr in
                                if index > 0 { HairlineDivider(leading: 34) }
                                ProjectPullRequestRow(pr: pr)
                            }
                        }
                    }
                    ProjectMoreLine(hidden: dashboard.pullRequests.hiddenCount, total: dashboard.pullRequests.total,
                                    noun: "open") { showFullList(.pullRequests) }
                }
            }

            if !dashboard.missions.items.isEmpty {
                ProjectPageSection(header: PageSectionHeader(title: "Missions", count: dashboard.missions.total)) {
                    ForEach(Array(dashboard.missions.items.enumerated()), id: \.element.id) { index, mission in
                        if index > 0 { HairlineDivider(leading: 34) }
                        ProjectMissionRow(mission: mission)
                    }
                    ProjectMoreLine(hidden: dashboard.missions.hiddenCount, total: dashboard.missions.total,
                                    noun: "active") { showFullList(.missions) }
                }
            }

            if !scheduled.isEmpty {
                ProjectPageSection(header: PageSectionHeader(title: "Scheduled", count: scheduled.count)) {
                    ForEach(Array(scheduled.prefix(ProjectFullList.rowLimit).enumerated()), id: \.element.id) { index, item in
                        if index > 0 { HairlineDivider(leading: 34) }
                        ProjectScheduledRow(item: item)
                    }
                    ProjectMoreLine(hidden: max(0, scheduled.count - ProjectFullList.rowLimit), total: scheduled.count,
                                    noun: "scheduled") { showFullList(.scheduled) }
                }
            }

            ProjectCycleSection(project: project, group: dashboard.tracked.first { $0.source == TrackedKind.linear.rawValue },
                                actions: trackedActions, now: now) { showTracked(.linear) }

            ProjectTrackedSection(project: project,
                                  groups: dashboard.tracked.filter { $0.source != TrackedKind.linear.rawValue },
                                  actions: trackedActions, now: now, openSettings: openSettings,
                                  showAll: { showTracked(.only($0)) })

            if let memory = dashboard.memory {
                ProjectPageSection(header: PageSectionHeader(title: "Memory", count: memory.count,
                                                              linkTitle: "Browse memory", link: browseMemory)) {
                    if memory.count == 0 {
                        Text("No project memories yet.")
                            .font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                    } else {
                        ForEach(Array(memory.recent.prefix(3).enumerated()), id: \.element.id) { index, entry in
                            if index > 0 { HairlineDivider(leading: 34) }
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "brain.head.profile").foregroundStyle(Theme.faintForeground).frame(width: 16)
                                Text(entry.text).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                                    .lineLimit(2).textSelection(.enabled)
                                Spacer(minLength: 0)
                                Text(Date(timeIntervalSince1970: entry.at / 1000), style: .relative)
                                    .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground).lineLimit(1)
                            }
                            .padding(.horizontal, 8).padding(.vertical, 4)
                        }
                    }
                    MemoryCompactionLine(compaction: memory.compaction)
                }
            }

            if !dashboard.recent.items.isEmpty {
                ProjectPageSection(header: PageSectionHeader(title: "Recent", linkTitle: "Archived chats") {
                    model.showArchive(in: project.id)
                }) {
                    ForEach(dashboard.recent.items) { item in
                        ProjectRecentRow(item: item, missionTitle: client.mission(item.missionId)?.title, now: now)
                    }
                }
            }
        }
    }
}

private struct ProjectPageSection<Content: View>: View {
    let header: PageSectionHeader
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            content
        }
    }
}

/// A concise full-list entry point under a section's first five rows.
private struct ProjectMoreLine: View {
    let hidden: Int
    let total: Int
    let noun: String
    let action: () -> Void

    var body: some View {
        if hidden > 0 {
            Button("Show all \(total) \(noun)", action: action)
                .buttonStyle(.plain)
                .font(.pilot(.caption))
                .foregroundStyle(Theme.faintForeground)
                .padding(.leading, 34)
        }
    }
}

/// Which sources the tracked items sheet lists: all of them from the … menu, or one from its page section.
enum TrackedSheetScope: Identifiable, Hashable {
    case all
    case only(TrackedKind)

    static let linear = TrackedSheetScope.only(.linear)

    var id: String {
        switch self {
        case .all: "all"
        case let .only(kind): kind.rawValue
        }
    }

    var kinds: [TrackedKind] {
        switch self {
        case .all: [.linear, .slack]
        case let .only(kind): [kind]
        }
    }
}

private enum ProjectFullList: String, Identifiable {
    case needsYou, working, pullRequests, missions, scheduled
    /// Rows a section shows before its "Show all" line, as pilotd bounds its sections.
    static let rowLimit = 5
    var id: String { rawValue }
    var title: String {
        switch self {
        case .needsYou: "Needs you"
        case .working: "Working now"
        case .pullRequests: "Pull requests"
        case .missions: "Missions"
        case .scheduled: "Scheduled"
        }
    }
}

/// A bounded, one-time dashboard read keeps long lists out of the live page and uses no polling.
private struct ProjectFullListSheet: View {
    let project: Project
    let list: ProjectFullList
    let dashboard: ProjectDashboard?
    let scheduled: [ScheduledItem]
    let error: String?
    let retry: () -> Void
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(project.name) · \(list.title)").font(.pilot(.title)).foregroundStyle(Theme.foreground)
            if let dashboard {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        switch list {
                        case .needsYou:
                            let visible = dashboard.needsYou
                            ForEach(Array(visible.items.enumerated()), id: \.element.id) { index, item in
                                if index > 0 { HairlineDivider(leading: 34) }
                                ProjectNeedsYouRow(item: item, now: Date())
                            }
                            capNote(visible.total, visible.items.count)
                        case .working:
                            ForEach(Array(dashboard.working.items.enumerated()), id: \.element.sessionId) { index, item in
                                if index > 0 { HairlineDivider(leading: 34) }
                                ProjectWorkingRow(item: item, status: model.client.session(item.sessionId)?.status ?? .working, now: Date())
                            }
                            capNote(dashboard.working.total, dashboard.working.items.count)
                        case .pullRequests:
                            ForEach(Array(dashboard.pullRequests.items.enumerated()), id: \.element.url) { index, item in
                                if index > 0 { HairlineDivider(leading: 34) }
                                ProjectPullRequestRow(pr: item)
                            }
                            capNote(dashboard.pullRequests.total, dashboard.pullRequests.items.count)
                        case .missions:
                            ForEach(Array(dashboard.missions.items.enumerated()), id: \.element.id) { index, item in
                                if index > 0 { HairlineDivider(leading: 34) }
                                ProjectMissionRow(mission: item)
                            }
                            capNote(dashboard.missions.total, dashboard.missions.items.count)
                        case .scheduled:
                            ForEach(Array(scheduled.enumerated()), id: \.element.id) { index, item in
                                if index > 0 { HairlineDivider(leading: 34) }
                                ProjectScheduledRow(item: item)
                            }
                        }
                    }
                }
            } else if let error {
                ContentUnavailableView("Couldn't load this list", systemImage: "exclamationmark.triangle", description: Text(error))
                Button("Retry", action: retry)
            } else {
                ProgressView("Loading…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(24)
        .frame(minWidth: 560, minHeight: 420)
        .background(Theme.background)
    }

    @ViewBuilder private func capNote(_ total: Int, _ count: Int) -> some View {
        if total > count {
            Text("Showing the first \(count) of \(total). Refine the list to see more.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).padding(.vertical, 8)
        }
    }
}

/// Last data stays visible under this banner when live updates stop.
struct ProjectRefreshBanner: View {
    let receivedAt: Date?
    let error: String?
    let retrying: Bool
    let retry: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warning).frame(width: 16)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Couldn't refresh this project").font(.pilot(.body)).foregroundStyle(Theme.foreground)
                    Text(ProjectPageText.staleDetail(receivedAt: receivedAt, error: error, now: context.date))
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Button("Retry", action: retry).disabled(retrying)
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.muted))
            .accessibilityElement(children: .contain)
        }
    }
}

// MARK: Tracking

/// The attached Linear team's current cycle: only my issues, grouped by status with Done collapsed, at most
/// five open rows and "All N issues" for my full list. With no active cycle, my open issues in the team.
/// One quiet line until a team is attached. Rows reuse the tracked row and its Start chat / Start mission.
private struct ProjectCycleSection: View {
    let project: Project
    /// The dashboard's Linear group, absent until a team is attached and the source is configured.
    let group: DashboardTrackedSource?
    @ObservedObject var actions: TrackedItemActions
    let now: Date
    let showAll: () -> Void
    @State private var showDone = false
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let total = group?.total ?? 0
        ProjectPageSection(header: PageSectionHeader(title: "Current cycle",
                                                      linkTitle: total > 0 ? TrackedItemText.allIssues(total) : nil,
                                                      link: showAll)) {
            if let group {
                let source = projectTrackingSource(group, projectId: project.id, kind: .linear, client: model.client)
                let open = group.items.map { TrackedItem(dashboard: $0, projectId: project.id, kind: .linear) }
                let done = (group.done?.items ?? []).map { TrackedItem(dashboard: $0, projectId: project.id, kind: .linear) }
                let doneCount = group.done?.total ?? 0
                TrackedSourceStatusLine(source: source, actions: actions, now: now)
                if let linear = group.linear { LinearCycleHeader(summary: linear, now: now).padding(.vertical, 4) }
                if open.isEmpty,
                   let empty = TrackedItemText.linearEmpty(group.linear, status: source.status, doneCount: doneCount) {
                    ProjectQuietLine(text: empty)
                }
                LinearIssueGroups(open: open, done: done, doneCount: doneCount, showDone: $showDone, actions: actions,
                                  now: now, showAllDone: showAll)
            } else if let team = project.tracking?.linearTeam, !team.isEmpty {
                ProjectQuietLine(text: "Your cycle appears after the first sync.")
            } else {
                ProjectQuietLine(text: "Attach a Linear team in Tracking settings to follow your current cycle here.")
            }
        }
    }
}

/// Every other tracking source (Slack bug reports today), one group each with its own sync, sign-in or error
/// status, at most five rows and "Show all N". One quiet line until a source is configured.
private struct ProjectTrackedSection: View {
    let project: Project
    /// Dashboard groups other than Linear, which has the Current cycle section.
    let groups: [DashboardTrackedSource]
    @ObservedObject var actions: TrackedItemActions
    let now: Date
    let openSettings: () -> Void
    let showAll: (TrackedKind) -> Void
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let known = groups.filter { TrackedKind(rawValue: $0.source) != nil }
        ProjectPageSection(header: PageSectionHeader(title: "Tracked", linkTitle: "Tracking settings",
                                                      link: openSettings)) {
            if known.isEmpty {
                ProjectQuietLine(text: "Add Slack channels in Tracking settings to follow bug reports here.")
            }
            ForEach(known) { group in
                if let kind = TrackedKind(rawValue: group.source) { sourceGroup(group, kind: kind) }
            }
        }
    }

    private func sourceGroup(_ group: DashboardTrackedSource, kind: TrackedKind) -> some View {
        let source = projectTrackingSource(group, projectId: project.id, kind: kind, client: model.client)
        let items = group.items.map { TrackedItem(dashboard: $0, projectId: project.id, kind: kind) }
        return VStack(alignment: .leading, spacing: 4) {
            SectionLabel(title: TrackedItemText.sourceTitle(kind, teamName: project.tracking?.linearTeamName),
                         count: group.total)
                .padding(.horizontal, 8).padding(.top, 2)
            TrackedSourceStatusLine(source: source, actions: actions, now: now)
            if items.isEmpty, source.status == .ok || source.status == .syncing {
                ProjectQuietLine(text: TrackedItemText.emptySource(source, project: project))
            }
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { HairlineDivider(leading: 34) }
                TrackedItemRow(item: item, actions: actions, now: now)
            }
            ProjectMoreLine(hidden: max(0, group.total - items.count), total: group.total,
                            noun: kind == .slack ? "bug reports" : "items") { showAll(kind) }
        }
    }
}

/// A section's one quiet line: empty guidance or what is missing.
private struct ProjectQuietLine: View {
    let text: String

    var body: some View {
        Text(text).font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8).padding(.vertical, 4)
    }
}

/// The live source from the WebSocket list (sync time, sign-in command), or the dashboard's copy until it arrives.
@MainActor
private func projectTrackingSource(_ group: DashboardTrackedSource, projectId: String, kind: TrackedKind,
                                   client: PilotClient) -> TrackingSource {
    client.source(projectId: projectId, kind: kind)
        ?? TrackingSource(id: "\(projectId):\(kind.rawValue)", projectId: projectId, kind: kind, label: group.label,
                          configured: true, status: group.status, error: group.error)
}

// MARK: Rows

private struct ProjectNeedsYouRow: View {
    let item: DashboardNeedsYouItem
    let now: Date
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let action = ProjectPageText.needsAction(item)
        let subtitle = ProjectPageText.needsSubtitle(item, now: now)
        Button(action: open) {
            HoverRow(verticalPadding: 7) { hovered in
                HStack(spacing: 10) {
                    icon.frame(width: 16)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                        Text(subtitle).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    if let action {
                        Text(action).font(.pilot(.label, weight: .medium))
                            .foregroundStyle(hovered ? Theme.foreground : Theme.mutedForeground)
                            .fixedSize()
                        Image(systemName: "chevron.right").font(.pilot(.micro, weight: .semibold))
                            .foregroundStyle(Theme.faintForeground)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
        .accessibilityLabel("\(item.title). \(subtitle)")
        .accessibilityHint(action ?? "")
        .modifier(ScheduledFailureActions(item: item))
    }

    @ViewBuilder private var icon: some View {
        switch item.kind {
        case .unread: SessionStatusIcon(status: item.outcome == .stopped ? .stopped : .done)
        case .failed: SessionStatusIcon(status: .failed)
        case .question: MissionCoordinatorIndicator()
        case .scheduledFailed: ScheduleStateIcon(state: .failed)
        }
    }

    private func open() {
        switch item.kind {
        case .question:
            if let missionId = item.missionId { model.openMission(missionId) }
        case .unread, .failed, .scheduledFailed:
            if let sessionId = item.sessionId { model.selectedSessionId = sessionId }
        }
    }
}

/// A scheduled item that could not start stays under Needs you until dismissed, which deletes it in pilotd.
private struct ScheduledFailureActions: ViewModifier {
    let item: DashboardNeedsYouItem
    @EnvironmentObject private var model: AppModel

    func body(content: Content) -> some View {
        if item.kind == .scheduledFailed, let id = item.scheduledId {
            content
                .contextMenu {
                    if let sessionId = item.sessionId { Button("Open Chat") { model.selectedSessionId = sessionId } }
                    Button("Dismiss") { dismiss(id) }
                }
                .accessibilityAction(named: "Dismiss") { dismiss(id) }
        } else {
            content
        }
    }

    private func dismiss(_ id: String) {
        Task {
            do { try await model.client.deleteSchedule(id) }
            catch { model.sessionActionError = error.localizedDescription }
        }
    }
}

private struct ProjectScheduledRow: View {
    let item: ScheduledItem
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let chatTitle: String? = if case let .message(sessionId, _) = item.target {
            model.client.session(sessionId)?.title
        } else { nil }
        ScheduledItemRow(item: item, detail: ScheduleText.detail(item, chatTitle: chatTitle)) {
            model.selectedSessionId = $0
        }
    }
}

private struct ProjectWorkingRow: View {
    let item: DashboardWorkingItem
    let status: SessionStatus
    let now: Date
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let meta = ProjectPageText.workingMeta(item)
        let elapsed = item.state == .starting ? "Starting" : SessionTimeFormatting.relative(item.startedAt, now: now)
        Button { model.selectedSessionId = item.sessionId } label: {
            HoverRow { _ in
                HStack(spacing: 10) {
                    SessionStatusIcon(status: status).frame(width: 16)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                        HStack(spacing: 5) {
                            if let mission = item.missionTitle {
                                Image(systemName: "scope").font(.pilot(.micro))
                                Text(mission).lineLimit(1)
                                if !meta.isEmpty { Text("·") }
                            }
                            Text(meta).lineLimit(1).truncationMode(.middle)
                        }
                        .font(.pilot(.caption))
                        .foregroundStyle(Theme.mutedForeground)
                    }
                    Spacer(minLength: 8)
                    if let pr = item.pullRequest { DashboardPullRequestMark(ref: pr) }
                    Text(elapsed).font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                        .fixedSize()
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel([item.title, item.missionTitle, meta, "working for \(elapsed)"]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
        .contextMenu {
            Button("Open Chat") { model.selectedSessionId = item.sessionId }
            Button("Stop Chat") { model.stopSession(item.sessionId) }
            if let pr = item.pullRequest, let url = dashboardBrowserURL(pr.url) {
                Link("Open PR #\(pr.number) in Browser", destination: url)
            }
        }
    }
}

/// PR number with its GitHub state, as in chat rows.
private struct DashboardPullRequestMark: View {
    let ref: DashboardPullRequestRef

    var body: some View {
        HStack(spacing: 3) {
            ref.state.icon
            Text("#\(ref.number)")
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(ref.state.color)
        .fixedSize()
        .help("Pull request #\(ref.number), \(ref.state.label)")
        .accessibilityLabel("Pull request \(ref.number), \(ref.state.label)")
    }
}

/// Merge readiness of an open PR. Pilot shows it and never merges.
/// Readiness is optional: until pilotd reports it, open PRs read as plain "Open".
struct PullRequestReadinessStyle: Equatable {
    enum Kind: Equatable { case ready, pending, blocked, draft, open }

    let kind: Kind
    let label: String

    init(_ pr: DashboardPullRequest) {
        if pr.state == .draft {
            kind = .draft
            label = "Draft"
            return
        }
        switch pr.readiness?.state {
        case .ready:
            kind = .ready
            label = "Ready to merge"
        case .pending:
            kind = .pending
            label = "Checks pending"
        case .blocked:
            kind = .blocked
            let reasons = (pr.readiness?.reasons ?? []).filter { !$0.isEmpty }
            label = reasons.isEmpty ? "Blocked" : reasons.joined(separator: " · ")
        case nil:
            kind = .open
            label = "Open"
        }
    }

    var color: Color {
        switch kind {
        case .ready, .open: PullRequestState.open.color
        case .pending, .draft: Theme.mutedForeground
        case .blocked: Theme.blocked
        }
    }

    @MainActor @ViewBuilder var icon: some View {
        switch kind {
        case .ready: Image(systemName: "checkmark.circle.fill")
        case .pending: Image(systemName: "clock")
        case .blocked: Image(systemName: "xmark.octagon")
        case .draft: PullRequestState.draft.icon
        case .open: PullRequestState.open.icon
        }
    }
}

private struct ProjectPullRequestRow: View {
    let pr: DashboardPullRequest
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let readiness = PullRequestReadinessStyle(pr)
        let url = dashboardBrowserURL(pr.url)
        Button { if let url { BrowserLinkOpener.shared.open(url) } else { openChat() } } label: {
            HoverRow { hovered in
                HStack(spacing: 10) {
                    readiness.icon
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(readiness.color)
                        .frame(width: 16)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text("#\(pr.number)").font(.pilot(.caption)).monospacedDigit()
                                .foregroundStyle(Theme.faintForeground)
                            Text(pr.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                        }
                        (Text(readiness.label).foregroundColor(readiness.color)
                            + Text("  ·  \(pr.sessionTitle)").foregroundColor(Theme.mutedForeground))
                            .font(.pilot(.caption))
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    if url != nil {
                        Image(systemName: "arrow.up.right").font(.pilot(.micro, weight: .semibold))
                            .foregroundStyle(hovered ? Theme.mutedForeground : Theme.faintForeground)
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .help(url == nil ? "Open the chat that owns this pull request" : pr.url)
        .accessibilityLabel("Pull request \(pr.number), \(pr.title). \(readiness.label). Chat: \(pr.sessionTitle)")
        .accessibilityHint(url == nil ? "Opens the chat" : "Opens in the browser")
        .accessibilityAction(named: "Open chat", openChat)
        .contextMenu {
            if let url { Link("Open in Browser", destination: url) }
            Button("Open Chat", action: openChat)
            Button("Copy Link") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(pr.url, forType: .string)
            }
        }
    }

    private func openChat() { model.selectedSessionId = pr.sessionId }
}

private struct ProjectMissionRow: View {
    let mission: DashboardMission
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let done = min(mission.tasksDone, mission.tasksTotal)
        let progress = mission.tasksTotal == 0 ? "No tasks" : "\(done) of \(mission.tasksTotal)"
        Button { model.openMission(mission.id) } label: {
            HoverRow(verticalPadding: 7) { _ in
                HStack(spacing: 10) {
                    Image(systemName: "scope").font(.pilot(.label)).foregroundStyle(Theme.foreground).frame(width: 16)
                    Text(mission.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if mission.working > 0 { CountBadge(count: mission.working).help("\(mission.working) working") }
                    if mission.needsYou > 0 {
                        CountBadge(count: mission.needsYou, style: .attention).help("\(mission.needsYou) need you")
                    }
                    SegmentedProgressBar(segments: [
                        .init(id: "done", value: done, color: Theme.success),
                        .init(id: "open", value: mission.tasksTotal - done, color: Theme.border),
                    ], height: 5)
                    .frame(width: 120)
                    Text(progress).font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.mutedForeground)
                        .frame(width: 56, alignment: .trailing)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel([mission.title,
                             mission.working > 0 ? "\(mission.working) working" : nil,
                             mission.needsYou > 0 ? "\(mission.needsYou) need you" : nil,
                             mission.tasksTotal == 0 ? "no tasks" : "\(done) of \(mission.tasksTotal) tasks done"]
            .compactMap { $0 }.joined(separator: ", "))
        .contextMenu {
            MissionEditAction(missionId: mission.id)
            Divider()
            // Dashboard rows carry counts, not status. Use the live mission summary.
            if let summary = model.client.mission(mission.id) {
                MissionStatusActions(missionId: mission.id, status: summary.status)
            }
            Divider()
            MissionDeleteAction(missionId: mission.id)
        }
    }
}

private struct ProjectRecentRow: View {
    let item: DashboardRecentItem
    let missionTitle: String?
    let now: Date
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let meta = [missionTitle, item.pullRequest.map { "\($0.state.compactLabel) #\($0.number)" }]
            .compactMap { $0 }.joined(separator: " · ")
        let time = SessionTimeFormatting.relative(item.outcomeAt, now: now)
        Button { model.selectedSessionId = item.sessionId } label: {
            HoverRow(verticalPadding: 5) { _ in
                HStack(spacing: 10) {
                    SessionStatusIcon(status: item.outcome.status).frame(width: 16)
                    Text(item.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                        .layoutPriority(1)
                    if !meta.isEmpty {
                        Text(meta).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Text(time).font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                        .fixedSize()
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel([item.title, item.outcome.status.rawValue, meta, time].filter { !$0.isEmpty }
            .joined(separator: ", "))
    }
}

private extension SessionOutcome {
    var status: SessionStatus {
        switch self {
        case .done: .done
        case .failed: .failed
        case .stopped: .stopped
        }
    }
}

/// Opens only http(s) links, as chat PR badges do.
private func dashboardBrowserURL(_ url: String) -> URL? {
    SessionPullRequest(number: 0, url: url, title: "", state: .open, checkedAt: 0).browserURL
}

// MARK: Text

/// Sentences and labels of the project page, kept apart from views so they can be tested.
enum ProjectPageText {
    static func headline(_ summary: ProjectDashboardSummary, needsYou: Int, lastFinishedAt: Double?,
                         now: Date = Date()) -> String {
        let working = summary.working
        let needs = max(0, needsYou)
        let workingText = working == 1 ? "1 chat is working" : "\(working) chats are working"
        let needsText = needs == 1 ? "1 thing needs you" : "\(needs) things need you"
        var first: String
        switch (working > 0, needs > 0) {
        case (true, true): first = "\(workingText) and \(needsText)."
        case (true, false): first = "\(workingText)."
        case (false, true): first = "\(needsText)."
        case (false, false):
            first = "Nothing is running."
            if let lastFinishedAt {
                first += " The last chat finished \(sentenceAgo(lastFinishedAt, now: now))."
            }
        }
        let ready = summary.readyPullRequests
        let open = summary.openPullRequests
        if ready > 0 {
            first += ready == 1 ? " 1 pull request is ready to merge." : " \(ready) pull requests are ready to merge."
        } else if open > 0 {
            first += open == 1 ? " 1 pull request is open." : " \(open) pull requests are open."
        }
        return first
    }

    static func meta(project: Project, activeMissions: Int) -> [String] {
        [
            activeMissions == 0 ? "No active missions"
                : activeMissions == 1 ? "1 active mission" : "\(activeMissions) active missions",
            project.usesPrivateClones ? "Isolated workspaces" : "Current checkout",
            project.model.map(shortModel),
        ].compactMap { $0 }
    }

    /// Mode, model and branch of a running chat. The mission, when any, is shown before it.
    static func workingMeta(_ item: DashboardWorkingItem) -> String {
        [item.mode == .ask ? "Ask" : "Build", item.model.map(shortModel), item.branch]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    static func needsAction(_ item: DashboardNeedsYouItem) -> String? {
        switch item.kind {
        case .unread: item.sessionId == nil ? nil : "Review"
        case .failed: item.sessionId == nil ? nil : "Open chat"
        case .question: item.missionId == nil ? nil : "Answer"
        case .scheduledFailed: item.sessionId == nil ? nil : "Open chat"
        }
    }

    static func needsSubtitle(_ item: DashboardNeedsYouItem, now: Date = Date()) -> String {
        let when = compactAgo(item.at, now: now)
        switch item.kind {
        case .unread:
            let lead = item.outcome == .stopped ? "Stopped \(when)." : "Finished \(when)."
            return [lead, item.reason].compactMap { $0 }.joined(separator: " ")
        case .failed:
            return item.reason.map { "Failed \(when): \($0)" } ?? "Failed \(when). Open the chat to see why."
        case .question:
            let count = item.count ?? 0
            if count <= 0 { return "The mission is waiting on you." }
            return count == 1 ? "1 question or blocked task is waiting on you."
                : "\(count) questions or blocked tasks are waiting on you."
        case .scheduledFailed:
            return item.reason.map { "Couldn't start: \($0)" } ?? "A scheduled item couldn't start."
        }
    }

    static func staleDetail(receivedAt: Date?, error: String?, now: Date = Date()) -> String {
        let shown = receivedAt.map { "Showing what Pilot knew \(sentenceAgo($0.timeIntervalSince1970 * 1000, now: now))." }
            ?? "Showing the last data Pilot received."
        guard let error, !error.isEmpty else { return "Waiting for pilotd to reconnect. \(shown)" }
        let sentence = error.hasSuffix(".") ? error : "\(error)."
        return "\(sentence) \(shown)"
    }

    /// "anthropic/claude-opus-5-5" reads as "claude-opus-5-5".
    static func shortModel(_ id: String) -> String {
        id.split(separator: "/").last.map(String.init) ?? id
    }

    /// "12m ago" in row subtitles.
    static func compactAgo(_ milliseconds: Double, now: Date) -> String {
        let relative = SessionTimeFormatting.relative(milliseconds, now: now)
        return relative == "now" ? "just now" : "\(relative) ago"
    }

    /// "3 minutes ago" or "yesterday" in sentences.
    static func sentenceAgo(_ milliseconds: Double, now: Date) -> String {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        guard now.timeIntervalSince(date) >= 60 else { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        formatter.dateTimeStyle = .named
        return formatter.localizedString(for: date, relativeTo: now)
    }
}

// MARK: Subscription

/// Keeps one project's dashboard subscribed while a view is on screen.
struct DashboardSubscription: ViewModifier {
    let projectId: String
    let client: PilotClient

    func body(content: Content) -> some View {
        content
            .onAppear { client.retainDashboard(projectId) }
            .onDisappear { client.releaseDashboard(projectId) }
            .onChange(of: projectId) { old, new in
                client.releaseDashboard(old)
                client.retainDashboard(new)
            }
    }
}

extension View {
    func dashboardSubscription(_ projectId: String, client: PilotClient) -> some View {
        modifier(DashboardSubscription(projectId: projectId, client: client))
    }
}

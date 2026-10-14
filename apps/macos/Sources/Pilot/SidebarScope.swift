import PilotCore
import SwiftUI

// MARK: - Model

/// What the detail area shows, remembered per sidebar scope so switching back returns to it.
enum SidebarSelection: Equatable {
    /// Home, which always covers every project.
    case home
    case session(String)
    case mission(String)
    /// A project's Overview.
    case project(String)
    case archive(projectId: String?, missionId: String?)
    /// The Inbox, its project filter preset from the sidebar's scope.
    case inbox

    /// Key for `AppModel.scopeSelections`: the project id, or "" for every project.
    static func scopeKey(_ scope: String?) -> String { scope ?? "" }

    /// The saved selection when it still exists and belongs to `scope`. Otherwise the scope's first row: the
    /// focused project's Overview, or Home for every project.
    static func restoring(_ saved: SidebarSelection?, in scope: String?, sessions: [SessionSummary],
                          missions: [Mission], projectIds: Set<String>) -> SidebarSelection {
        let fallback: SidebarSelection = scope.map { .project($0) } ?? .home
        guard let saved else { return fallback }
        switch saved {
        case .home, .inbox:
            return saved
        case let .session(id):
            guard let session = sessions.first(where: { $0.id == id }),
                  scope == nil || session.projectId == scope else { return fallback }
            return saved
        case let .mission(id):
            guard let mission = missions.first(where: { $0.id == id }),
                  scope == nil || mission.projectId == scope else { return fallback }
            return saved
        case let .project(id):
            guard projectIds.contains(id), scope == nil || scope == id else { return fallback }
            return saved
        case let .archive(projectId, missionId):
            guard let scope else {
                return .archive(projectId: projectId.flatMap { projectIds.contains($0) ? $0 : nil },
                                missionId: missionId.flatMap { id in missions.contains { $0.id == id } ? id : nil })
            }
            let mission = missions.first { $0.id == missionId && $0.projectId == scope }
            return .archive(projectId: scope, missionId: mission?.id)
        }
    }
}

/// Working and needs-you figures for the project selector and the Inbox badge.
enum SidebarScopeCounts {
    /// Every project's counts added up, optionally leaving one project out.
    static func total(_ counts: [String: ProjectDashboardCount], excluding projectId: String? = nil)
        -> ProjectDashboardCount {
        counts.reduce(into: ProjectDashboardCount()) { total, entry in
            guard entry.key != projectId else { return }
            total = ProjectDashboardCount(working: total.working + entry.value.working,
                                          needsYou: total.needsYou + entry.value.needsYou,
                                          tracked: total.tracked + entry.value.tracked)
        }
    }

    /// "2 working · 1 needs you", leaving out zeros. nil when nothing is working or waiting.
    static func summary(_ count: ProjectDashboardCount) -> String? {
        var parts: [String] = []
        if count.working > 0 { parts.append("\(count.working) working") }
        if count.needsYou > 0 { parts.append(needsYou(count.needsYou)) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func needsYou(_ count: Int) -> String { "\(count) \(count == 1 ? "needs" : "need") you" }

    /// The Inbox badge's tooltip and VoiceOver label: "5 need you: 2 questions, 1 failed, 2 not reviewed".
    /// Prefer the daemon's uncapped reasons (including scheduled failures and task/questions). Older daemons
    /// fall back to local chat reasons only when they account for the whole count. nil when nothing needs the user.
    static func needsYouReasons(total: Int, reasons: NeedsYouReasons,
                               counts: [String: ProjectDashboardCount] = [:]) -> String? {
        guard total > 0 else { return nil }
        if counts.values.reduce(0, { $0 + $1.needsYou }) == total,
           counts.values.allSatisfy({ count in
               count.needsYou == 0 || count.needsYouReasons?.values.reduce(0, +) == count.needsYou
           }) {
            return InboxText.needsYouSummary(Array(counts.values))
        }
        let parts = [
            reasons.longJobs > 0 ? "\(reasons.longJobs) \(reasons.longJobs == 1 ? "long job" : "long jobs")" : nil,
            reasons.questions > 0 ? "\(reasons.questions) \(reasons.questions == 1 ? "question" : "questions")" : nil,
            reasons.failed > 0 ? "\(reasons.failed) failed" : nil,
            reasons.limited > 0 ? "\(reasons.limited) \(reasons.limited == 1 ? "limit" : "limits") reached" : nil,
            reasons.notReviewed > 0 ? "\(reasons.notReviewed) not reviewed" : nil,
        ].compactMap { $0 }
        guard !parts.isEmpty, reasons.total == total else { return needsYou(total) }
        return "\(needsYou(total)): \(parts.joined(separator: ", "))"
    }
}

/// Why chats are in Needs you, counted from the sidebar's urgency groups.
struct NeedsYouReasons: Equatable {
    var questions = 0
    var failed = 0
    var notReviewed = 0
    /// Failed chats stopped by a subscription limit.
    var limited = 0
    var longJobs = 0

    var total: Int { questions + failed + notReviewed + limited + longJobs }

    init(questions: Int = 0, failed: Int = 0, notReviewed: Int = 0, limited: Int = 0) {
        self.questions = questions
        self.failed = failed
        self.notReviewed = notReviewed
        self.limited = limited
    }

    /// Counts the Needs you group of `SidebarUrgency.groups` by reason.
    init(_ needsYou: [SessionSummary], unread: (SessionSummary) -> Bool) {
        for session in needsYou {
            if session.attentionReason?.kind == .longJob { longJobs += 1; continue }
            switch session.signal(unread: unread(session)) {
            case .failed:
                if session.subscriptionLimit() != nil { limited += 1 } else { failed += 1 }
            case .needsYou where session.status == .question: questions += 1
            default: notReviewed += 1
            }
        }
    }
}

// MARK: - Views

/// The top of the sidebar: Home (with compose) and the Inbox, which always cover every project, then the project
/// selector ("All projects" or one focused project) heading everything scoped to it, and the focused project's
/// Overview as its first row. Archived chats, search and grouping live in the selector's menu.
struct SidebarHeader: View {
    @ObservedObject var model: AppModel
    @ObservedObject var client: PilotClient
    let counts: [String: ProjectDashboardCount]
    let homeSelected: Bool
    let inboxSelected: Bool
    let overviewSelected: Bool
    /// What needs the user across every project, badged on the Inbox.
    let needsYou: Int
    /// The badge's tooltip and VoiceOver detail, summing the reasons when known.
    let needsYouHelp: String?
    let archivedCount: Int
    let onNewFolder: () -> Void

    var body: some View {
        let project = model.focusedProject
        VStack(alignment: .leading, spacing: 1) {
            SidebarNavRow(title: "Home", icon: PilotIcon.home, selected: homeSelected, help: "Every project at a glance",
                          action: { model.openHome() }) {
                composeButton(project: project)
            }
            SidebarNavRow(title: "Inbox", icon: PilotIcon.inbox, selected: inboxSelected,
                          help: needsYouHelp ?? "Nothing needs you",
                          accessibilityDetail: needsYouHelp, action: { model.showInbox() }) {
                if needsYou > 0 {
                    CountBadge(count: needsYou, style: .attention)
                        .help(needsYouHelp ?? SidebarScopeCounts.needsYou(needsYou))
                        .padding(.trailing, 6)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .animation(Theme.Motion.quick, value: needsYou > 0)
            SidebarProjectSelector(model: model, counts: counts, archivedCount: archivedCount,
                                   onNewFolder: onNewFolder)
                .padding(.top, 8)
            if let project {
                SidebarNavRow(title: "Overview", icon: PilotIcon.overview, selected: overviewSelected,
                              help: "Open \(project.name)'s Overview", action: { model.openOverview() }) {
                    EmptyView()
                }
                .padding(.top, 2)
            }
        }
    }

    private func composeButton(project: Project?) -> some View {
        Menu {
            Button("New Chat") { model.newChatInScope() }
            Button("New Mission…") { model.missionSheet = .create(projectId: project?.id) }
                .disabled(client.projects.isEmpty)
        } label: {
            PilotSymbol(PilotIcon.compose)
        } primaryAction: {
            model.newChatInScope()
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .frame(width: 28, height: 28)
        .help(project.map { "New chat in \($0.name) (⌘N). Hold for New Mission." } ?? "New chat (⌘N). Hold for New Mission.")
        .accessibilityLabel(project.map { "New chat in \($0.name)" } ?? "New chat")
    }
}

/// One navigation row at the top of the sidebar (Home, Inbox, Overview): a symbol, a title and an optional trailing
/// accessory such as a badge or button. Hover and selection use the sidebar's selection fill.
struct SidebarNavRow<Accessory: View>: View {
    let title: String
    let icon: PilotIcon
    let selected: Bool
    var help: String?
    var accessibilityDetail: String?
    let action: () -> Void
    @ViewBuilder var accessory: () -> Accessory
    @State private var hovered = false

    var body: some View {
        HStack(spacing: 0) {
            Button(action: action) {
                HStack(spacing: 7) {
                    PilotSymbol(icon, filled: selected, context: .row)
                        .foregroundStyle(selected ? Theme.foreground : Theme.mutedForeground)
                        .frame(width: 16)
                    Text(title)
                        .font(.pilot(.body, weight: selected ? .semibold : .regular))
                        .foregroundStyle(Theme.foreground)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(help ?? "")
            .accessibilityLabel([title, accessibilityDetail].compactMap { $0 }.joined(separator: ", "))
            .accessibilityAddTraits(selected ? .isSelected : [])
            accessory()
        }
        .padding(.leading, 8)
        .padding(.trailing, 2)
        .frame(height: 28)
        .background(RoundedRectangle(cornerRadius: 7).fill(selected || hovered ? Theme.selected : .clear))
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
    }
}

/// The project selector: "All projects" or the focused project, opening the list of projects and the sidebar's
/// secondary actions. ⌘0 to ⌘9 switch from anywhere (`SidebarScopeCommands`).
struct SidebarProjectSelector: View {
    @ObservedObject var model: AppModel
    let counts: [String: ProjectDashboardCount]
    let archivedCount: Int
    let onNewFolder: () -> Void
    @State private var showingList = false
    @State private var hovered = false

    var body: some View {
        let project = model.focusedProject
        Button { showingList.toggle() } label: {
            HStack(spacing: 7) {
                PilotSymbol(project == nil ? PilotIcon.allProjects : PilotIcon.project, context: .row)
                    .frame(width: 16)
                Text(project?.name ?? "All projects")
                    .font(.pilot(.body, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                PilotSymbol(PilotIcon.popUp, context: .disclosure)
                    .foregroundStyle(Theme.mutedForeground)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 8)
            .frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 7).fill(showingList || hovered ? Theme.selected : Theme.muted))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .accessibilityLabel("Sidebar shows \(project?.name ?? "all projects")")
        .accessibilityHint("Choose which projects the sidebar lists")
        .help("Switch projects: ⌘0 for all projects, ⌘1 to ⌘9 for one")
        .popover(isPresented: $showingList, arrowEdge: .bottom) {
            SidebarScopeList(projects: model.orderedProjects, scope: project?.id, counts: counts,
                             archivedCount: archivedCount, groupsByUrgency: model.sidebarGroupsByUrgency,
                             choose: { id in
                                 showingList = false
                                 model.focus(on: id)
                             },
                             showArchive: {
                                 showingList = false
                                 model.showArchive(in: project?.id)
                             },
                             search: {
                                 showingList = false
                                 model.showSidebarSearch()
                             },
                             toggleGrouping: { model.sidebarGroupsByUrgency.toggle() },
                             addProject: {
                                 showingList = false
                                 model.addProject()
                             },
                             newFolder: {
                                 showingList = false
                                 onNewFolder()
                             })
        }
    }
}

/// The open switcher: All projects, then each project in sidebar order with its counts and shortcut, then the
/// sidebar's secondary actions (archived chats, search, grouping) and project management.
struct SidebarScopeList: View {
    let projects: [Project]
    let scope: String?
    let counts: [String: ProjectDashboardCount]
    let archivedCount: Int
    let groupsByUrgency: Bool
    let choose: (String?) -> Void
    let showArchive: () -> Void
    let search: () -> Void
    let toggleGrouping: () -> Void
    let addProject: () -> Void
    let newFolder: () -> Void

    private static let rowHeight: CGFloat = 26

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SidebarScopeRow(title: "All projects", icon: PilotIcon.allProjects, checked: scope == nil,
                            count: SidebarScopeCounts.total(counts), shortcut: "⌘0") { choose(nil) }
            if !projects.isEmpty {
                HairlineDivider().padding(.vertical, 4)
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(projects.enumerated()), id: \.element.id) { index, project in
                            SidebarScopeRow(title: project.name, icon: PilotIcon.project, checked: scope == project.id,
                                            count: counts[project.id] ?? ProjectDashboardCount(),
                                            shortcut: index < 9 ? "⌘\(index + 1)" : nil,
                                            help: project.path.abbreviatingHome) { choose(project.id) }
                        }
                    }
                }
                // Long lists scroll; a half row hints there is more.
                .frame(height: min(CGFloat(projects.count), 12.5) * Self.rowHeight)
                .scrollBounceBehavior(.basedOnSize)
            }
            HairlineDivider().padding(.vertical, 4)
            SidebarScopeRow(title: "Archived chats (\(archivedCount))", icon: PilotIcon.archive, action: showArchive)
            SidebarScopeRow(title: "Search chats", icon: PilotIcon.search, shortcut: "⌘F", action: search)
            if scope == nil {
                SidebarScopeRow(title: "Group chats by urgency", icon: PilotIcon.groupByUrgency, checked: groupsByUrgency,
                                help: "List Needs you, Ready to merge, Working and Recent instead of projects and folders",
                                action: toggleGrouping)
            }
            HairlineDivider().padding(.vertical, 4)
            SidebarScopeRow(title: "Add Project…", icon: PilotIcon.newProject, action: addProject)
            SidebarScopeRow(title: "New Folder…", icon: PilotIcon.chatFolder, action: newFolder)
        }
        .padding(5)
        .frame(width: 300)
    }
}

private struct SidebarScopeRow: View {
    let title: String
    let icon: PilotIcon
    var checked = false
    var count: ProjectDashboardCount?
    var shortcut: String?
    var help: String?
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                PilotSymbol(PilotIcon.selectedOption)
                    .opacity(checked ? 1 : 0)
                    .frame(width: 12)
                PilotSymbol(icon, context: .row).frame(width: 16)
                Text(title).font(.pilot(.body)).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
                if let count {
                    if count.working > 0 { CountBadge(count: count.working) }
                    if count.needsYou > 0 { CountBadge(count: count.needsYou, style: .attention) }
                }
                if let shortcut {
                    Text(shortcut)
                        .font(.pilot(.caption))
                        .foregroundStyle(Theme.faintForeground)
                        .frame(width: 26, alignment: .trailing)
                }
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 5).fill(hovered ? Theme.selected : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .help(help ?? "")
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(checked ? .isSelected : [])
    }

    private var accessibilityLabel: String {
        let detail = count.flatMap(SidebarScopeCounts.summary)
        return [title, detail].compactMap { $0 }.joined(separator: ", ")
    }
}

// MARK: - Commands

/// View menu: All Projects (⌘0) and the first nine projects (⌘1…⌘9), checked when current.
struct SidebarScopeCommands: Commands {
    @ObservedObject var model: AppModel
    @ObservedObject var client: PilotClient

    var body: some Commands {
        CommandGroup(after: .sidebar) {
            Divider()
            Button("Search Chats") { model.showSidebarSearch() }
                .keyboardShortcut("f", modifiers: .command)
            // A focused project always groups its chats by urgency; the choice applies to All projects.
            Toggle("Group Chats by Urgency", isOn: $model.sidebarGroupsByUrgency)
                .disabled(model.focusedProject != nil)
            Divider()
            Toggle("All Projects", isOn: binding(nil))
                .keyboardShortcut("0", modifiers: .command)
            ForEach(Array(model.orderedProjects.prefix(9).enumerated()), id: \.element.id) { index, project in
                Toggle(project.name, isOn: binding(project.id))
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
            }
        }
    }

    private func binding(_ projectId: String?) -> Binding<Bool> {
        Binding(
            get: { model.focusedProject?.id == projectId },
            set: { _ in model.focus(on: projectId) }
        )
    }
}

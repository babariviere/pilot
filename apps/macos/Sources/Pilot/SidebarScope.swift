import PilotCore
import SwiftUI

// MARK: - Model

/// What the detail area shows, remembered per sidebar scope so switching back returns to it.
enum SidebarSelection: Equatable {
    /// Home: today's Home with every project, the project page when focused.
    case home
    case session(String)
    case mission(String)
    case project(String)
    case archive(projectId: String?, missionId: String?)
    /// The Inbox, scoped like the sidebar.
    case inbox

    /// Key for `AppModel.scopeSelections`: the project id, or "" for every project.
    static func scopeKey(_ scope: String?) -> String { scope ?? "" }

    /// The saved selection when it still exists and belongs to `scope`, else Home.
    static func restoring(_ saved: SidebarSelection?, in scope: String?, sessions: [SessionSummary],
                          missions: [Mission], projectIds: Set<String>) -> SidebarSelection {
        guard let saved else { return .home }
        switch saved {
        case .home, .inbox:
            return saved
        case let .session(id):
            guard let session = sessions.first(where: { $0.id == id }),
                  scope == nil || session.projectId == scope else { return .home }
            return saved
        case let .mission(id):
            guard let mission = missions.first(where: { $0.id == id }),
                  scope == nil || mission.projectId == scope else { return .home }
            return saved
        case let .project(id):
            // A focused scope's own page is its Home.
            guard scope == nil, projectIds.contains(id) else { return .home }
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

/// Working and needs-you figures for the scope switcher, the Home badge and the Elsewhere line.
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
        if count.needsYou > 0 { parts.append("\(count.needsYou) \(count.needsYou == 1 ? "needs" : "need") you") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The line under a focused switcher. Only shown when other projects have activity. The compact form,
    /// for narrow sidebars, keeps what needs the user and drops the working count when both are present.
    static func elsewhere(_ count: ProjectDashboardCount, compact: Bool = false) -> String? {
        let shown = compact && count.needsYou > 0 ? ProjectDashboardCount(needsYou: count.needsYou) : count
        return summary(shown).map { "Elsewhere: \($0)" }
    }
}

// MARK: - Views

/// The top of the sidebar, in one row: the scope switcher ("All projects" or one focused project), Home for that
/// scope with what needs the user, and a compose button. When focused, a quiet line about work in other projects
/// follows; it opens the switcher. Archived chats, search and grouping live in the switcher's menu.
struct SidebarScopeSwitcher: View {
    @ObservedObject var model: AppModel
    @ObservedObject var client: PilotClient
    let counts: [String: ProjectDashboardCount]
    /// Things that need the user in this scope, badged on Home.
    let needsYou: Int
    let homeSelected: Bool
    /// What the Inbox lists in this scope (needs you plus open tracked items), a neutral count on its button.
    let inboxCount: Int
    let inboxSelected: Bool
    let archivedCount: Int
    let onNewFolder: () -> Void
    @State private var showingList = false
    @State private var hovered = false

    var body: some View {
        let project = model.focusedProject
        let elsewhere = project.map { SidebarScopeCounts.total(counts, excluding: $0.id) }
        let elsewhereText = elsewhere.flatMap { SidebarScopeCounts.elsewhere($0) }
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Button { showingList.toggle() } label: {
                    HStack(spacing: 7) {
                        Image(systemName: project == nil ? "square.grid.2x2" : "folder")
                            .font(.pilot(.label))
                            .frame(width: 16)
                        Text(project?.name ?? "All projects")
                            .font(.pilot(.body, weight: .semibold))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.pilot(.glyph, weight: .semibold))
                            .foregroundStyle(Theme.mutedForeground)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.foreground)
                    .frame(height: 28)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Sidebar shows \(project?.name ?? "all projects")")
                .accessibilityHint("Choose which projects the sidebar lists")
                .help("Switch projects: ⌘0 for all projects, ⌘1 to ⌘9 for one")
                homeButton(project: project)
                inboxButton(project: project)
                composeButton(project: project)
            }
            if let elsewhereText, let elsewhere {
                Button { showingList.toggle() } label: {
                    HStack(spacing: 7) {
                        Circle()
                            .fill(elsewhere.needsYou > 0 ? Theme.warning : Theme.faintForeground)
                            .frame(width: 6, height: 6)
                            .frame(width: 16)
                        ViewThatFits(in: .horizontal) {
                            Text(elsewhereText)
                            Text(SidebarScopeCounts.elsewhere(elsewhere, compact: true) ?? elsewhereText)
                                .lineLimit(1)
                        }
                        .font(.pilot(.caption))
                        .foregroundStyle(Theme.mutedForeground)
                        Spacer(minLength: 0)
                    }
                    .padding(.bottom, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(elsewhereText)
                .accessibilityLabel(elsewhereText)
                .accessibilityHint("Shows every project and what it needs")
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, 2)
        .background(RoundedRectangle(cornerRadius: 7).fill(showingList || hovered ? Theme.selected : Theme.muted))
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
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

    /// Home for the scope: today's Home, or the focused project's page. Badged with what needs the user.
    private func homeButton(project: Project?) -> some View {
        let title = project.map { "Open \($0.name)'s project page" } ?? "Open Home"
        return Button { model.openScopeHome() } label: {
            Image(systemName: homeSelected ? "house.fill" : "house")
                .font(.pilot(.label))
                .foregroundStyle(homeSelected ? Theme.foreground : Theme.mutedForeground)
                .frame(width: 24, height: 24)
                .overlay(alignment: .topTrailing) {
                    if needsYou > 0 {
                        CountBadge(count: needsYou, style: .attention)
                            .scaleEffect(0.85)
                            .offset(x: 7, y: -4)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(Theme.Motion.quick, value: needsYou > 0)
        .padding(.trailing, needsYou > 0 ? 6 : 0)
        .help(title)
        .accessibilityLabel(needsYou > 0 ? "\(title), \(needsYou) \(needsYou == 1 ? "needs" : "need") you" : title)
        .accessibilityAddTraits(homeSelected ? .isSelected : [])
    }

    /// The Inbox for the scope: what waits on the user, with open tracked items. Its count is neutral, since
    /// tickets do not interrupt; Home keeps the attention badge.
    private func inboxButton(project: Project?) -> some View {
        let title = project.map { "Open the Inbox for \($0.name)" } ?? "Open the Inbox"
        return Button { model.showInbox() } label: {
            Image(systemName: inboxSelected ? "tray.fill" : "tray")
                .font(.pilot(.label))
                .foregroundStyle(inboxSelected ? Theme.foreground : Theme.mutedForeground)
                .frame(width: 24, height: 24)
                .overlay(alignment: .topTrailing) {
                    if inboxCount > 0 {
                        CountBadge(count: inboxCount)
                            .scaleEffect(0.85)
                            .offset(x: 7, y: -4)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(Theme.Motion.quick, value: inboxCount > 0)
        .padding(.trailing, inboxCount > 0 ? 6 : 0)
        .help(title)
        .accessibilityLabel(inboxCount > 0 ? "\(title), \(inboxCount) waiting" : title)
        .accessibilityAddTraits(inboxSelected ? .isSelected : [])
    }

    private func composeButton(project: Project?) -> some View {
        Menu {
            Button("New Chat") { model.newChatInScope() }
            Button("New Mission…") { model.missionSheet = .create(projectId: project?.id) }
                .disabled(client.projects.isEmpty)
        } label: {
            Image(systemName: "square.and.pencil")
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
            SidebarScopeRow(title: "All projects", icon: "square.grid.2x2", checked: scope == nil,
                            count: SidebarScopeCounts.total(counts), shortcut: "⌘0") { choose(nil) }
            if !projects.isEmpty {
                HairlineDivider().padding(.vertical, 4)
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(projects.enumerated()), id: \.element.id) { index, project in
                            SidebarScopeRow(title: project.name, icon: "folder", checked: scope == project.id,
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
            SidebarScopeRow(title: "Archived chats (\(archivedCount))", icon: "archivebox", action: showArchive)
            SidebarScopeRow(title: "Search chats", icon: "magnifyingglass", shortcut: "⌘F", action: search)
            if scope == nil {
                SidebarScopeRow(title: "Group chats by urgency", icon: "list.bullet.indent", checked: groupsByUrgency,
                                help: "List Needs you, Working and Recent instead of projects and folders",
                                action: toggleGrouping)
            }
            HairlineDivider().padding(.vertical, 4)
            SidebarScopeRow(title: "Add Project…", icon: "folder.badge.plus", action: addProject)
            SidebarScopeRow(title: "New Folder…", icon: "folder.fill.badge.plus", action: newFolder)
        }
        .padding(5)
        .frame(width: 300)
    }
}

private struct SidebarScopeRow: View {
    let title: String
    let icon: String
    var checked = false
    var count: ProjectDashboardCount?
    var shortcut: String?
    var help: String?
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: "checkmark")
                    .font(.pilot(.small, weight: .semibold))
                    .opacity(checked ? 1 : 0)
                    .frame(width: 12)
                Image(systemName: icon).font(.pilot(.label)).frame(width: 16)
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
            Toggle("Group Chats by Urgency", isOn: $model.sidebarGroupsByUrgency)
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

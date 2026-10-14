import PilotCore
import SwiftUI

/// Home dashboard cards, built only from data pilotd has today.
struct Dashboard: View {
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        VStack(spacing: 32) {
            HomeOverview()
                .frame(maxWidth: Theme.column)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 340), spacing: 14, alignment: .top)], spacing: 14) {
                WorkingNowCard(sessions: client.activeSessions.filter(\.isWorking))
                ActivityCard(sessions: client.activeSessions)
                ReadyToMergeCard(sessions: client.activeSessions)
                IdleCard(sessions: client.activeSessions.filter(\.isIdleAwaitingReview))
                ScheduledCard(items: ScheduleText.listed(client.schedules, includeFailed: true))
                ProjectsCard(projects: client.projects, sessions: client.activeSessions)
            }
        }
    }
}

private struct ReadyToMergeCard: View {
    let sessions: [SessionSummary]
    @EnvironmentObject private var app: AppModel

    private var ready: [(SessionSummary, SessionPullRequest)] {
        sessions.flatMap { session in
            session.linkedPullRequests.filter { $0.state == .open && $0.readiness?.state == .ready }
                .map { (session, $0) }
        }
    }

    var body: some View {
        DashboardCard(title: "Ready to merge", icon: "checkmark.circle.fill", count: ready.count) {
            if ready.isEmpty { EmptyLine(text: "No pull requests are ready to merge.") }
            ForEach(Array(ready.indices.prefix(5)), id: \.self) { index in
                let (session, pr) = ready[index]
                Button { app.selectedSessionId = session.id } label: {
                    HoverRow(verticalPadding: 5) { _ in
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success)
                                .accessibilityHidden(true)
                            Text("#\(pr.number)").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(pr.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                                Text(session.title).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                            }
                            Spacer(minLength: 4)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Pull request #\(pr.number), \(pr.title), ready to merge. Open chat \(session.title).")
                if index < min(ready.count, 5) - 1 { HairlineDivider(leading: 24) }
            }
        }
    }
}

struct DashboardCard<Content: View>: View {
    let title: String
    let icon: String
    var count: Int?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(title: title, icon: icon, count: count)
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 170, alignment: .topLeading)
        .card(radius: 12)
    }
}

private struct EmptyLine: View {
    let text: String
    var body: some View {
        Text(text).font(.pilot(.body)).foregroundStyle(Theme.faintForeground)
    }
}

/// Scheduled chats and follow-ups across projects. Items that could not start come first, until dismissed.
private struct ScheduledCard: View {
    let items: [ScheduledItem]
    @EnvironmentObject private var app: AppModel

    var body: some View {
        DashboardCard(title: "Scheduled", icon: "calendar.badge.clock", count: items.count) {
            if items.isEmpty { EmptyLine(text: "Nothing scheduled. Use Send later to start work when you’re back.") }
            ForEach(Array(items.prefix(5).enumerated()), id: \.element.id) { index, item in
                if index > 0 { HairlineDivider(leading: 32) }
                ScheduledItemRow(item: item, detail: detail(item), verticalPadding: 5, spacing: 8) {
                    app.selectedSessionId = $0
                }
            }
        }
    }

    private func detail(_ item: ScheduledItem) -> String {
        switch item.target {
        case let .chat(spawn, _):
            let project = app.client.project(item.projectId ?? spawn.projectId)
            return ScheduleText.detail(item, projectName: project?.name ?? spawn.cwd?.abbreviatingHome)
        case let .message(sessionId, _):
            return ScheduleText.detail(item, chatTitle: app.client.session(sessionId)?.title)
        }
    }
}

private struct WorkingNowCard: View {
    let sessions: [SessionSummary]
    @EnvironmentObject private var app: AppModel

    var body: some View {
        DashboardCard(title: "Working now", icon: "waveform.path.ecg", count: sessions.count) {
            if sessions.isEmpty { EmptyLine(text: "Nothing running. Start a task above.") }
            ForEach(sessions.prefix(5)) { session in
                VStack(alignment: .leading, spacing: 4) {
                    Button { app.selectedSessionId = session.id } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                SessionStatusIcon(status: session.status)
                                Text(session.title).font(.pilot(.body, weight: .medium)).lineLimit(1)
                                Spacer()
                                Text(elapsed(session.listActivityAt)).font(.pilot(.caption).monospacedDigit())
                                    .foregroundStyle(Theme.mutedForeground)
                            }
                            Text("\(app.client.project(session.projectId)?.name ?? session.cwd.abbreviatingHome) · \(session.model ?? "default model")")
                                .font(.pilot(.caption))
                                .foregroundStyle(Theme.faintForeground)
                                .lineLimit(1)
                                .padding(.leading, 22)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    PullRequestBadge(session: session).padding(.leading, 22)
                }
            }
        }
    }

    private func elapsed(_ milliseconds: Double) -> String {
        let seconds = Int(max(0, Date().timeIntervalSince1970 - milliseconds / 1000))
        return seconds < 3600 ? "\(seconds / 60)m \(seconds % 60)s" : "\(seconds / 3600)h \(seconds % 3600 / 60)m"
    }
}

/// Sessions started per day, last 14 days.
private struct ActivityCard: View {
    let sessions: [SessionSummary]

    var body: some View {
        let counts = days()
        let total = counts.reduce(0) { $0 + $1.count }
        let peak = max(1, counts.map(\.count).max() ?? 1)
        DashboardCard(title: "Activity", icon: "chart.bar") {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(total)").font(.pilot(.display, weight: .semibold)).foregroundStyle(Theme.foreground)
                Text("sessions · 14 days").font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
            }
            HStack(alignment: .bottom, spacing: 5) {
                ForEach(Array(counts.enumerated()), id: \.offset) { index, day in
                    VStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(index == counts.count - 1 ? Theme.info : Theme.info.opacity(0.75))
                            .frame(height: max(3, CGFloat(day.count) / CGFloat(peak) * 54))
                        Text(day.label).font(.pilot(.micro)).foregroundStyle(Theme.faintForeground)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .frame(height: 74, alignment: .bottom)
        }
    }

    private func days() -> [(label: String, count: Int)] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let symbols = calendar.veryShortWeekdaySymbols
        return (0 ..< 14).reversed().map { offset in
            let day = calendar.date(byAdding: .day, value: -offset, to: today)!
            let next = calendar.date(byAdding: .day, value: 1, to: day)!
            let count = sessions.filter {
                let created = Date(timeIntervalSince1970: $0.createdAt / 1000)
                return created >= day && created < next
            }.count
            return (symbols[calendar.component(.weekday, from: day) - 1], count)
        }
    }
}

/// Idle chats with an open PR or none yet. Chats with merged or closed PRs are settled and left out.
private struct IdleCard: View {
    let sessions: [SessionSummary]
    @EnvironmentObject private var app: AppModel

    var body: some View {
        DashboardCard(title: "Idle chats", icon: "moon.zzz", count: sessions.count) {
            if sessions.isEmpty { EmptyLine(text: "No idle chats with open work.") }
            ForEach(sessions.prefix(6)) { session in
                VStack(alignment: .leading, spacing: 4) {
                    Button { app.selectedSessionId = session.id } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            SessionStatusIcon(status: session.status)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(session.title).font(.pilot(.body)).lineLimit(1)
                                Text(app.client.project(session.projectId)?.name ?? session.cwd.abbreviatingHome)
                                    .font(.pilot(.caption))
                                    .foregroundStyle(Theme.faintForeground)
                                    .lineLimit(1)
                            }
                            Spacer()
                            if app.isUnread(session) { UnreadBadge() }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    PullRequestBadge(session: session).padding(.leading, 20)
                }
            }
        }
    }
}

private struct ProjectsCard: View {
    let projects: [Project]
    let sessions: [SessionSummary]
    @EnvironmentObject private var app: AppModel

    var body: some View {
        DashboardCard(title: "Projects", icon: "folder", count: projects.count) {
            if projects.isEmpty { EmptyLine(text: "Add a project to group sessions by repository.") }
            ForEach(projects.prefix(6)) { project in
                let owned = sessions.filter { $0.projectId == project.id }
                Button { app.openProject(project.id) } label: {
                    HStack(spacing: 8) {
                        Circle().fill(owned.contains(where: \.isWorking) ? Theme.success : Theme.faintForeground.opacity(0.5))
                            .frame(width: 6, height: 6)
                        Text(project.name).font(.pilot(.body, weight: .medium))
                        Text(project.path.abbreviatingHome)
                            .font(.pilot(.caption, design: .monospaced))
                            .foregroundStyle(Theme.faintForeground)
                            .lineLimit(1)
                            .truncationMode(.head)
                        Spacer()
                        Text("\(owned.count)").font(.pilot(.caption).monospacedDigit()).foregroundStyle(Theme.mutedForeground)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Open \(project.name)")
                .contextMenu {
                    Button("Open Project") { app.openProject(project.id) }
                    Button("New Chat") { app.newSession(in: project.id) }
                }
            }
            Button { app.addProject() } label: {
                Label("Add project", systemImage: "plus").font(.pilot(.label))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.mutedForeground)
        }
    }
}

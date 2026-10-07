import PilotCore
import SwiftUI

/// Home dashboard cards, built only from data pilotd has today.
struct Dashboard: View {
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 340), spacing: 14, alignment: .top)], spacing: 14) {
            WorkingNowCard(sessions: client.sessions.filter(\.isWorking))
            ActivityCard(sessions: client.sessions)
            RecentCard(sessions: Array(client.sessions.filter { !$0.isWorking }.prefix(6)))
            ProjectsCard(projects: client.projects, sessions: client.sessions)
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
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 11))
                Text(title).font(.system(size: 12, weight: .medium))
                if let count, count > 0 {
                    Text("\(count)")
                        .font(.system(size: 10, weight: .semibold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Theme.muted))
                }
                Spacer()
            }
            .foregroundStyle(Theme.mutedForeground)
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
        Text(text).font(.system(size: 13)).foregroundStyle(Theme.faintForeground)
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
                            HStack(spacing: 8) {
                                SessionStatusIcon(status: session.status).frame(width: 12)
                                Text(session.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                                Spacer()
                                Text(elapsed(session.updatedAt)).font(.system(size: 11).monospacedDigit())
                                    .foregroundStyle(Theme.mutedForeground)
                            }
                            Text("\(app.client.project(session.projectId)?.name ?? session.cwd.abbreviatingHome) · \(session.model ?? "default model")")
                                .font(.system(size: 11, design: .monospaced))
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
                Text("\(total)").font(.system(size: 26, weight: .semibold)).foregroundStyle(Theme.foreground)
                Text("sessions · 14 days").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
            }
            HStack(alignment: .bottom, spacing: 5) {
                ForEach(Array(counts.enumerated()), id: \.offset) { index, day in
                    VStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(index == counts.count - 1 ? Theme.info : Theme.info.opacity(0.75))
                            .frame(height: max(3, CGFloat(day.count) / CGFloat(peak) * 54))
                        Text(day.label).font(.system(size: 9)).foregroundStyle(Theme.faintForeground)
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

private struct RecentCard: View {
    let sessions: [SessionSummary]
    @EnvironmentObject private var app: AppModel

    var body: some View {
        DashboardCard(title: "Recent sessions", icon: "clock") {
            if sessions.isEmpty { EmptyLine(text: "No sessions yet.") }
            ForEach(sessions) { session in
                VStack(alignment: .leading, spacing: 4) {
                    Button { app.selectedSessionId = session.id } label: {
                        HStack(spacing: 8) {
                            SessionStatusIcon(status: session.status).frame(width: 12)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(session.title).font(.system(size: 13)).lineLimit(1)
                                Text(app.client.project(session.projectId)?.name ?? session.cwd.abbreviatingHome)
                                    .font(.system(size: 11, design: .monospaced))
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
                Button { app.newSession(in: project.id) } label: {
                    HStack(spacing: 8) {
                        Circle().fill(owned.contains(where: \.isWorking) ? Theme.success : Theme.faintForeground.opacity(0.5))
                            .frame(width: 6, height: 6)
                        Text(project.name).font(.system(size: 13, weight: .medium))
                        Text(project.path.abbreviatingHome)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Theme.faintForeground)
                            .lineLimit(1)
                            .truncationMode(.head)
                        Spacer()
                        Text("\(owned.count)").font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.mutedForeground)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Button { app.addProject() } label: {
                Label("Add project", systemImage: "plus").font(.system(size: 12))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.mutedForeground)
        }
    }
}

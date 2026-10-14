import PilotCore
import SwiftUI

/// Home uses the existing lightweight snapshots, without subscribing to every mission or project.
enum HomeOverviewLists {
    static let previewLimit = 5

    static func agents(_ sessions: [SessionSummary], isUnread: (SessionSummary) -> Bool) -> [SessionSummary] {
        sessions.filter { session in
            guard !session.isArchived, !session.isWorking, !session.hasTerminalPullRequest else { return false }
            if let at = session.outcomeAt, at.isFinite {
                return session.outcome != nil && isUnread(session)
            }
            // A legacy failure without a result version cannot be reviewed away.
            return session.state == "failed"
        }.sorted {
            let lhsFailed = $0.status == .failed
            let rhsFailed = $1.status == .failed
            if lhsFailed != rhsFailed { return lhsFailed }
            return ($0.visibleOutcomeAt ?? $0.listActivityAt, $0.id) > ($1.visibleOutcomeAt ?? $1.listActivityAt, $1.id)
        }
    }

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

struct HomeOverview: View {
    @EnvironmentObject private var app: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @State private var allAgents = false
    @State private var allMissions = false

    var body: some View {
        let agents = HomeOverviewLists.agents(client.sessions, isUnread: app.isUnread)
        let missions = HomeOverviewLists.missions(client.missions)
        let sessionIds = Set(client.sessions.map(\.id))
        LazyVStack(alignment: .leading, spacing: 10) {
            if !client.connected {
                Text(client.hasProjectSnapshot ? "Waiting to reconnect. Showing the last known lists." : "Connecting to Pilot…")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
            PageSectionHeader(title: "Needs you", count: agents.count, countStyle: .attention)
            if agents.isEmpty {
                quietLine(client.hasProjectSnapshot ? "No agents need your attention." : "Loading agents…")
            }
            ForEach(agents.prefix(allAgents ? agents.count : HomeOverviewLists.previewLimit)) { session in
                agentRow(session)
            }
            if agents.count > HomeOverviewLists.previewLimit {
                listToggle(count: agents.count, expanded: $allAgents)
            }

            PageSectionHeader(title: "Missions", count: missions.count)
                .padding(.top, 18)
            if missions.isEmpty {
                quietLine(client.hasProjectSnapshot ? "No missions yet." : "Loading missions…")
            }
            ForEach(missions.prefix(allMissions ? missions.count : HomeOverviewLists.previewLimit)) { mission in
                missionRow(mission, sessionIds: sessionIds)
            }
            if missions.count > HomeOverviewLists.previewLimit {
                listToggle(count: missions.count, expanded: $allMissions)
            }
        }
    }

    private func agentRow(_ session: SessionSummary) -> some View {
        VStack(spacing: 0) {
            Button { app.reveal(session: session.id) } label: {
                HoverRow { _ in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        SessionStatusIcon(status: session.status)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(session.title).font(.pilot(.body, weight: .medium))
                                .foregroundStyle(Theme.foreground).lineLimit(1).help(session.title)
                            Text([client.project(session.projectId)?.name ?? session.cwd.abbreviatingHome,
                                  session.status == .failed ? "Failed" : "Unreviewed result"]
                                .joined(separator: " · "))
                                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        Text(session.status == .failed ? "Open chat" : "Review")
                            .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(session.title), \(session.status == .failed ? "failed" : "unreviewed result"). Open chat.")
            HairlineDivider(leading: 30)
        }
    }

    private func missionRow(_ mission: Mission, sessionIds: Set<String>) -> some View {
        VStack(spacing: 0) {
            HoverRow { _ in
                HStack(spacing: 10) {
                    Button { app.openMission(mission.id) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: MissionSymbol.name).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                                .frame(width: 14).accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(mission.title).font(.pilot(.body, weight: .medium))
                                    .foregroundStyle(mission.status == .active ? Theme.foreground : Theme.mutedForeground)
                                    .lineLimit(1).help(mission.title)
                                Text([client.project(mission.projectId)?.name, mission.status.label]
                                    .compactMap { $0 }.joined(separator: " · "))
                                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                            }
                            Spacer(minLength: 4)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(mission.title), \(mission.status.label). Open mission.")
                    if mission.status == .active, let count = mission.needsYouCount, count > 0 {
                        CountBadge(count: count, style: .attention).help("\(count) questions or blocked tasks need you")
                            .accessibilityLabel("\(count) questions or blocked tasks need you")
                    }
                    if let id = HomeOverviewLists.coordinator(mission, sessionIds: sessionIds) {
                        Button { app.reveal(session: id) } label: {
                            Label("Coordinator", systemImage: MissionCoordinatorIndicator.symbol)
                                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).fixedSize()
                        }
                        .buttonStyle(.plain)
                        .help("Open the coordinator chat for \(mission.title)")
                        .accessibilityLabel("Open coordinator for \(mission.title)")
                    } else {
                        Text(mission.coordinatorSessionId == nil ? "No coordinator" : "Coordinator unavailable")
                            .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground).fixedSize()
                    }
                }
            }
            HairlineDivider(leading: 30)
        }
    }

    private func quietLine(_ text: String) -> some View {
        Text(text).font(.pilot(.body)).foregroundStyle(Theme.faintForeground).padding(.vertical, 6)
    }

    private func listToggle(count: Int, expanded: Binding<Bool>) -> some View {
        Button(expanded.wrappedValue ? "Show fewer" : "Show all \(count)") {
            expanded.wrappedValue.toggle()
        }
        .buttonStyle(.plain).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
        .padding(.leading, 30)
    }
}

import PilotCore
import SwiftUI

/// Inspector tab for a mission member chat: the mission's header, this chat's task and one summary line that opens
/// the mission page. Everything else (other tasks, decisions, activity) lives on the page.
struct MissionInspectorPane: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        Group {
            if let missionId = session.missionId, let mission = client.mission(missionId) {
                content(mission, detail: client.missionDetails[missionId])
            } else {
                EmptyStateView(icon: PilotIcon.mission, title: "Not in a mission",
                               message: "Use Make a mission… or Add to mission… from the chat's menu.")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.background)
        .missionSubscription(session.missionId, client: client)
    }

    private func content(_ mission: Mission, detail: MissionDetail?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header(mission)
                if let detail {
                    let mine = MissionTaskOrdering.sorted(detail.tasks).filter { $0.sessionId == session.id }
                    VStack(alignment: .leading, spacing: 6) {
                        Text(mine.count > 1 ? "This chat's tasks" : "This chat's task")
                            .font(.pilot(.label, weight: .semibold)).foregroundStyle(Theme.foreground)
                            .accessibilityAddTraits(.isHeader)
                        if mine.isEmpty {
                            Text("No task claimed").font(.pilot(.label)).foregroundStyle(Theme.faintForeground)
                        }
                        ForEach(mine) { task in
                            ownTask(task, mission: mission, detail: detail)
                        }
                    }
                    summary(mission, detail: detail)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .padding(14)
        }
    }

    private func header(_ mission: Mission) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                PilotSymbol(PilotIcon.mission, context: .row).foregroundStyle(Theme.mutedForeground)
                Text(mission.title).font(.pilot(.body, weight: .semibold)).foregroundStyle(Theme.foreground).lineLimit(2)
                if mission.status != .active { MissionStatusChip(status: mission.status) }
                Spacer(minLength: 6)
                // A chevron: the page opens in this window. The arrow out is kept for the browser.
                Button { model.openMission(mission.id) } label: {
                    HStack(spacing: 3) {
                        Text("Open")
                        PilotSymbol(PilotIcon.disclosure)
                    }
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.mutedForeground)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Open the mission page")
                .accessibilityLabel("Open mission \(mission.title)")
            }
            if mission.coordinatorSessionId == session.id {
                HStack(spacing: 4) {
                    MissionCoordinatorIndicator()
                    Text("This chat coordinates")
                }
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
            if !mission.goal.isEmpty {
                Text(mission.goal).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                    .lineLimit(3).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .help(mission.goal)
            }
        }
    }

    /// "12 of 18 done · 3 working now · 2 need you" over the tasks bar and its legend, opening the mission's Overview.
    private func summary(_ mission: Mission, detail: MissionDetail) -> some View {
        let needs = model.needsYouCount(mission)
        let counts = MissionTaskCounts(detail.tasks)
        return Button { model.openMission(mission.id, tab: .overview) } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 5) {
                    Text(counts.progressLine(working: MissionTaskOrdering.inFlight(detail.tasks).count))
                        .monospacedDigit().lineLimit(1).fixedSize()
                    if needs > 0 {
                        Text("·")
                        Text(SidebarScopeCounts.needsYou(needs)).lineLimit(1).fixedSize()
                    }
                    PilotSymbol(PilotIcon.disclosure).foregroundStyle(Theme.faintForeground)
                    Spacer(minLength: 0)
                }
                if counts.total > 0 { MissionTaskProgress(counts: counts) }
            }
            .font(.pilot(.caption))
            .foregroundStyle(Theme.mutedForeground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open the mission's Overview")
        .accessibilityLabel([counts.summary, needs > 0 ? SidebarScopeCounts.needsYou(needs) : nil]
            .compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint("Opens the mission's Overview")
    }

    private func ownTask(_ task: MissionTask, mission: Mission, detail: MissionDetail) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            MissionTaskStatusMenu(task: task, missionId: mission.id)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("#\(task.number)").font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                    Text(task.title).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                        .fixedSize(horizontal: false, vertical: true)
                }
                MissionTaskDescription(task: task, collapsedLineLimit: 4)
                let resources = detail.resources.filter { $0.taskId == task.id }
                MissionTaskDelegationLabel(task: task, resources: resources)
                if !resources.isEmpty {
                    ResponsiveControlsLayout(horizontalSpacing: 10, verticalSpacing: 4) {
                        ForEach(resources) { MissionLinkChip(resource: $0, missionId: mission.id) }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.muted))
    }
}

/// Header chip that opens the chat's mission.
struct MissionChip: View {
    let missionId: String
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        Button { model.openMission(missionId) } label: {
            HStack(spacing: 4) {
                PilotSymbol(PilotIcon.mission)
                Text(client.mission(missionId)?.title ?? "Mission").lineLimit(1)
            }
            .font(.pilot(.caption, weight: .medium))
            .foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(Theme.muted))
            .frame(maxWidth: 200)
        }
        .buttonStyle(.plain)
        .help("Open mission: \(client.mission(missionId)?.title ?? "")")
        .accessibilityLabel("Open mission \(client.mission(missionId)?.title ?? "")")
    }
}

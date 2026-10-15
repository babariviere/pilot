import PilotCore
import SwiftUI

/// Inspector tab for a mission member chat: the mission at a glance, this chat's tasks, other open
/// tasks and decisions. No cards: sections separated by whitespace, like the mission page.
struct MissionInspectorPane: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @State private var decisionsExpanded = true

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
                header(mission, detail: detail)
                if let detail {
                    let ordered = MissionTaskOrdering.sorted(detail.tasks)
                    let mine = ordered.filter { $0.sessionId == session.id }
                    let others = ordered.filter { $0.sessionId != session.id && !$0.status.isClosed }
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
                    if !others.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text("Other open tasks").font(.pilot(.label, weight: .semibold)).foregroundStyle(Theme.foreground)
                                Text("\(others.count)").font(.pilot(.label)).foregroundStyle(Theme.faintForeground)
                            }
                            .accessibilityAddTraits(.isHeader)
                            .padding(.bottom, 2)
                            ForEach(others) { task in
                                CompactTaskRow(task: task, showsOwner: true)
                                    .padding(.horizontal, -8)
                            }
                        }
                    }
                    if !detail.decisions.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Button { decisionsExpanded.toggle() } label: {
                                HStack(spacing: 6) {
                                    DisclosureChevron(expanded: decisionsExpanded)
                                        .frame(width: 10)
                                    Text("Decisions").font(.pilot(.label, weight: .semibold)).foregroundStyle(Theme.foreground)
                                    Text("\(detail.decisions.count)").font(.pilot(.label)).foregroundStyle(Theme.faintForeground)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityValue(decisionsExpanded ? "Expanded" : "Collapsed")
                            if decisionsExpanded {
                                ForEach(detail.decisions) { decision in
                                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                                        Text("D\(decision.number)").font(.pilot(.small))
                                            .foregroundStyle(Theme.faintForeground).monospacedDigit()
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(decision.text).font(.pilot(.label)).foregroundStyle(Theme.foreground)
                                                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                            DecisionAudienceTag(audience: decision.audience)
                                            if let proposal = detail.decisionProposals?.first(where: { $0.decisionId == decision.id && $0.status == "pending" }) {
                                                DecisionProposalView(proposal: proposal, oldText: decision.text)
                                                    .id(proposal.id)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    HStack(spacing: 14) {
                        Button { model.openMission(mission.id, tab: .brief) } label: { Label("Brief", icon: PilotIcon.document) }
                        Button { model.openMission(mission.id, tab: .activity) } label: { Label("Activity", icon: PilotIcon.pending) }
                    }
                    .buttonStyle(.plain)
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.mutedForeground)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .padding(14)
        }
    }

    private func header(_ mission: Mission, detail: MissionDetail?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                PilotSymbol(PilotIcon.mission, context: .row).foregroundStyle(Theme.mutedForeground)
                Text(mission.title).font(.pilot(.body, weight: .semibold)).foregroundStyle(Theme.foreground).lineLimit(2)
                if mission.status != .active { MissionStatusChip(status: mission.status) }
                Spacer(minLength: 6)
                Button { model.openMission(mission.id) } label: {
                    HStack(spacing: 3) {
                        Text("Open")
                        PilotSymbol(PilotIcon.openExternal)
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
            if let detail, !detail.tasks.isEmpty {
                MissionTaskProgress(counts: MissionTaskCounts(detail.tasks), compact: true)
            }
        }
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
                if !resources.isEmpty {
                    ResponsiveControlsLayout(horizontalSpacing: 10, verticalSpacing: 4) {
                        ForEach(resources) { MissionLinkChip(resource: $0, missionId: mission.id, compact: true) }
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

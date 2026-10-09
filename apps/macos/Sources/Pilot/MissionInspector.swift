import PilotCore
import SwiftUI

/// Inspector tab for a mission member chat: the mission, this chat's tasks, other tasks and decisions.
struct MissionInspectorPane: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        Group {
            if let missionId = session.missionId, let mission = client.mission(missionId) {
                content(mission, detail: client.missionDetails[missionId])
            } else {
                Text("This chat is not in a mission").font(.callout).foregroundStyle(Theme.mutedForeground)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.background)
        .missionSubscription(session.missionId, client: client)
    }

    private func content(_ mission: Mission, detail: MissionDetail?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Button { model.openMission(mission.id) } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "scope")
                            Text(mission.title).font(.headline).lineLimit(2)
                            Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(Theme.faintForeground)
                        }
                    }
                    .buttonStyle(.plain)
                    .help("Open the mission page")
                    HStack(spacing: 6) {
                        MissionStatusChip(status: mission.status)
                        if mission.coordinatorSessionId == session.id {
                            Label("This chat coordinates", systemImage: "star.fill").foregroundStyle(Theme.warning)
                        }
                    }
                    .font(.caption)
                    if !mission.goal.isEmpty {
                        Text(mission.goal).font(.callout).foregroundStyle(Theme.mutedForeground)
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                    if let detail {
                        MissionProgressBar(done: detail.progress.done, total: detail.progress.total)
                    }
                }
                if let detail {
                    let ordered = MissionTaskOrdering.sorted(detail.tasks)
                    let mine = ordered.filter { $0.sessionId == session.id }
                    let others = ordered.filter { $0.sessionId != session.id && !$0.status.isClosed }
                    MissionSection("This chat's tasks") {
                        if mine.isEmpty {
                            Text("No task claimed").font(.callout).foregroundStyle(Theme.faintForeground).padding(10)
                        }
                        ForEach(Array(mine.enumerated()), id: \.element.id) { index, task in
                            if index > 0 { MissionRowDivider() }
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                MissionTaskStatusMenu(task: task, missionId: mission.id)
                                Text("#\(task.number)").font(.caption.monospacedDigit()).foregroundStyle(Theme.faintForeground)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(task.title)
                                    MissionTaskDescription(task: task, collapsedLineLimit: 4)
                                }
                                Spacer()
                            }
                            .font(.callout)
                            .padding(10)
                        }
                    }
                    MissionSection("Other open tasks") {
                        if others.isEmpty {
                            Text("No other open tasks").font(.callout).foregroundStyle(Theme.faintForeground).padding(10)
                        }
                        ForEach(Array(others.enumerated()), id: \.element.id) { index, task in
                            if index > 0 { MissionRowDivider() }
                            CompactTaskRow(task: task)
                        }
                    }
                    MissionSection("Decisions") {
                        if detail.decisions.isEmpty {
                            Text("No decisions yet").font(.callout).foregroundStyle(Theme.faintForeground).padding(10)
                        }
                        ForEach(Array(detail.decisions.enumerated()), id: \.element.id) { index, decision in
                            if index > 0 { MissionRowDivider() }
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: "checkmark.seal").foregroundStyle(Theme.success)
                                Text(decision.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            }
                            .font(.callout)
                            .padding(10)
                        }
                    }
                    Button("Open brief") { model.openMission(mission.id, tab: .brief) }
                        .buttonStyle(.link)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .padding(14)
        }
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
                Image(systemName: "scope")
                Text(client.mission(missionId)?.title ?? "Mission").lineLimit(1)
            }
            .font(.system(size: 11, weight: .medium))
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


import PilotCore
import SwiftUI

/// A mission in the sidebar. Missions are not chats: the row summarises the mission (progress and the most
/// urgent state of its chats, as a dithered corner) and opens the mission page. Its chats are listed in the
/// chat groups like any other chat. The needs-you badge is always visible; the coordinator and new-chat actions
/// appear on hover, in space the row always reserves, while the corner recedes from under them. Selection is the
/// row's only fill.
struct MissionSidebarRow: View {
    @Environment(\.hostViewContext) private var hostContext
    let mission: Mission
    let needsYou: Int
    let working: Int
    /// Most urgent state of the mission's chats, from MissionSidebarSummary.signal.
    let signal: SessionSignal?
    /// Its working chats only wait on background jobs: the corner uses the slower background ripple.
    var waitingOnJobs = false
    let selected: Bool
    @EnvironmentObject private var model: AppModel
    @State private var hovered = false

    var body: some View {
        let line = MissionSidebarSummary.line(mission: mission, working: working)
        let progress = line?.text
        let active = mission.status == .active
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Button { model.openMission(mission.id, context: hostContext) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        PilotSymbol(PilotIcon.mission, context: .row)
                            .foregroundStyle(active ? Theme.foreground : Theme.faintForeground)
                            .frame(width: 14)
                        Text(mission.title)
                            .font(.pilot(.body, weight: .medium))
                            .foregroundStyle(active ? Theme.foreground : Theme.mutedForeground)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    if let line {
                        // The current phase's name truncates first, so its counts stay readable.
                        HStack(spacing: 0) {
                            if let phase = line.phase {
                                Text(phase).truncationMode(.tail)
                            }
                            if let detail = line.detail {
                                Text(line.phase == nil ? detail : " · \(detail)").layoutPriority(1)
                            }
                        }
                        .font(.pilot(.small, weight: .medium))
                        .foregroundStyle(Theme.mutedForeground)
                        .monospacedDigit()
                        .lineLimit(1)
                        .padding(.leading, 22)
                    }
                }
                .contentShape(Rectangle())
            }
            .rowButtonStyle()
            .help("Open \(mission.title)")
            .accessibilityLabel([mission.title, progress, signal?.label].compactMap { $0 }.joined(separator: ", "))
            .accessibilityHint("Opens the mission")
            .accessibilityAddTraits(selected ? .isSelected : [])
            // Revealed on the first line, which the receding corner leaves empty.
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                MissionSidebarCoordinatorAction(mission: mission)
                    .revealed(hovered)
                if active {
                    Button { model.newSession(in: mission, context: hostContext) } label: { PilotSymbol(PilotIcon.compose, context: .toolbar) }
                        .rowIconButtonStyle()
                        .help("New chat in \(mission.title)")
                        .accessibilityLabel("New chat in \(mission.title)")
                        .revealed(hovered)
                }
                if needsYou > 0 {
                    CountBadge(count: needsYou, style: .attention)
                        .help("\(needsYou) item\(needsYou == 1 ? "" : "s") need you")
                        .accessibilityLabel("\(needsYou) need you")
                }
            }
        }
        // Stop short of the corner's densest cells.
        .padding(.trailing, 16)
        .padding(.vertical, 3)
        .padding(.leading, 4)
        .ditherCorner(signal, background: waitingOnJobs, outset: EdgeInsets(), cornerRadius: Theme.Radius.row)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(selected ? Theme.selected : Color.clear))
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .contextMenu {
            Button("Open Mission") { model.openMission(mission.id, context: hostContext) }
            MissionSidebarCoordinatorAction(mission: mission, inMenu: true)
            Divider()
            Button("New Chat") { model.newSession(in: mission, context: hostContext) }
                .disabled(!active)
            Menu("Add Existing Chat") { MissionExistingChatItems(mission: mission) }
            MissionEditAction(missionId: mission.id)
            Divider()
            MissionStatusActions(missionId: mission.id, status: mission.status)
            Divider()
            MissionDeleteAction(missionId: mission.id)
        }
    }
}

/// Secondary action shared by the toolbar, Chats tab and sidebar group.
struct MissionExistingChatItems: View {
    @EndpointClient private var endpoint
    let mission: Mission
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let candidates = endpoint.activeSessions.filter {
            $0.projectId == mission.projectId && $0.missionId == nil
        }
        ForEach(candidates) { session in
            Button(session.title) {
                model.missionAction { [client = endpoint, id = mission.id] in
                    try await client.joinMission(session.id, JoinMissionRequest(missionId: id))
                }
            }
        }
        if candidates.isEmpty { Text("No other chats in this project") }
    }
}

/// Both shortcuts select by ID, independent of archive state and sidebar filters.
struct MissionSidebarCoordinatorAction: View {
    @Environment(\.hostViewContext) private var hostContext
    let mission: Mission
    var inMenu = false
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let coordinator = mission.coordinatorSessionId {
            if inMenu {
                Button("Open Coordinator") { model.navigate(.session, id: coordinator, context: hostContext) }
            } else {
                Button { model.navigate(.session, id: coordinator, context: hostContext) } label: {
                    PilotSymbol(PilotIcon.coordinator)
                }
                .rowIconButtonStyle()
                .help("Open coordinator")
                .accessibilityLabel("Open coordinator")
            }
        }
    }
}

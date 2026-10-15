import PilotCore
import SwiftUI

/// A mission in the sidebar. Missions are not chats: the row summarises the mission (progress and the most
/// urgent state of its chats, as a dithered corner) and opens the mission page. Its chats are listed in the
/// chat groups like any other chat. The needs-you badge is always visible; the coordinator and new-chat actions
/// appear on hover, in space the row always reserves.
struct MissionSidebarRow: View {
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
        let progress = MissionSidebarSummary.progress(mission: mission, working: working)
        let active = mission.status == .active
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Button { model.openMission(mission.id) } label: {
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
                    if let progress {
                        Text(progress)
                            .font(.pilot(.small, weight: .medium))
                            .foregroundStyle(Theme.mutedForeground)
                            .monospacedDigit()
                            .lineLimit(1)
                            .padding(.leading, 22)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Open \(mission.title)")
            .accessibilityLabel([mission.title, progress, signal?.label].compactMap { $0 }.joined(separator: ", "))
            .accessibilityHint("Opens the mission")
            .accessibilityAddTraits(selected ? .isSelected : [])
            // The corner clears behind the actions and badge while the pointer is over the row.
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                MissionSidebarCoordinatorAction(mission: mission)
                    .revealed(hovered)
                if active {
                    Button { model.newSession(in: mission) } label: { PilotSymbol(PilotIcon.compose, context: .toolbar) }
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
            .ditherCornerClearance(hovered)
        }
        // Stop short of the corner's densest cells.
        .padding(.trailing, 16)
        .padding(.vertical, 3)
        .padding(.leading, 4)
        .ditherCorner(signal, background: waitingOnJobs, outset: EdgeInsets(), cornerRadius: Theme.Radius.row)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(selected ? Theme.selected : (hovered ? Theme.muted : Color.clear)))
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .contextMenu {
            Button("Open Mission") { model.openMission(mission.id) }
            MissionSidebarCoordinatorAction(mission: mission, inMenu: true)
            Divider()
            Button("New Chat") { model.newSession(in: mission) }
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
    let mission: Mission
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let candidates = model.client.activeSessions.filter {
            $0.projectId == mission.projectId && $0.missionId == nil
        }
        ForEach(candidates) { session in
            Button(session.title) {
                model.missionAction { [client = model.client, id = mission.id] in
                    try await client.joinMission(session.id, JoinMissionRequest(missionId: id))
                }
            }
        }
        if candidates.isEmpty { Text("No other chats in this project") }
    }
}

/// Both shortcuts select by ID, independent of archive state and sidebar filters.
struct MissionSidebarCoordinatorAction: View {
    let mission: Mission
    var inMenu = false
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let coordinator = mission.coordinatorSessionId {
            if inMenu {
                Button("Open Coordinator") { model.selectedSessionId = coordinator }
            } else {
                Button { model.selectedSessionId = coordinator } label: {
                    PilotSymbol(PilotIcon.coordinator)
                }
                .rowIconButtonStyle()
                .help("Open coordinator")
                .accessibilityLabel("Open coordinator")
            }
        }
    }
}

/// "<map> Mission name" on a mission chat's second line, always visible so the chat lists name the mission.
/// Clicking it opens the mission.
struct SessionMissionLabel: View {
    let title: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 3) {
                PilotSymbol(PilotIcon.mission)
                Text(title).lineLimit(1).truncationMode(.tail)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .font(.pilot(.small, weight: .medium))
        .foregroundStyle(Theme.mutedForeground)
        .help("Open mission: \(title)")
        .accessibilityLabel("Open mission \(title)")
    }
}

/// An active coordinator's second line: "<compass> Coordinator" in amber, then its reason or state.
/// Replaces the grey compass that used to trail the title.
struct SessionCoordinatorLine: View {
    let session: SessionSummary
    let unread: Bool

    var body: some View {
        let detail = MissionCoordinatorStatus.detail(session, unread: unread)
        HStack(spacing: 4) {
            HStack(spacing: 3) {
                PilotSymbol(PilotIcon.coordinator)
                Text("Coordinator").fontWeight(.semibold)
            }
            .foregroundStyle(Theme.warning)
            .fixedSize()
            Text("·").foregroundStyle(Theme.faintForeground)
            Text(detail)
                .foregroundStyle(Theme.mutedForeground)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .font(.pilot(.small, weight: .medium))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Coordinator, \(detail)")
    }
}

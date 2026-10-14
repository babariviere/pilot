import PilotCore
import SwiftUI

/// A mission in the sidebar: opens the mission page, and expands to its chats. The needs-you badge is
/// always visible; chat actions and the disclosure chevron appear on hover (the chevron also while expanded).
struct MissionSidebarRow: View {
    let mission: Mission
    let needsYou: Int
    let chatCount: Int
    let working: Int
    let selected: Bool
    @Binding var isExpanded: Bool
    @EnvironmentObject private var model: AppModel
    @State private var hovered = false

    var body: some View {
        HStack(spacing: 6) {
            Button { model.openMission(mission.id) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "scope")
                        .font(.pilot(.label))
                        .foregroundStyle(mission.status == .active ? Theme.foreground : Theme.faintForeground)
                        .frame(width: 14)
                    Text(mission.title)
                        .font(.pilot(.body, weight: .medium))
                        .foregroundStyle(mission.status == .active ? Theme.foreground : Theme.mutedForeground)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if working > 0, !hovered {
                        CountBadge(count: working)
                            .help("\(working) working")
                            .accessibilityLabel("\(working) working")
                    }
                    if needsYou > 0 {
                        CountBadge(count: needsYou, style: .attention)
                            .help("\(needsYou) item\(needsYou == 1 ? "" : "s") need you")
                            .accessibilityLabel("\(needsYou) need you")
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            MissionSidebarCoordinatorAction(mission: mission)
                .revealed(hovered)
            if mission.status == .active {
                Button { model.newSession(in: mission) } label: { Image(systemName: "plus") }
                    .buttonStyle(QuietIconButtonStyle())
                    .help("New chat in \(mission.title)")
                    .accessibilityLabel("New chat in \(mission.title)")
                    .revealed(hovered)
            }
            Button { isExpanded.toggle() } label: {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
            }
            .buttonStyle(QuietIconButtonStyle())
            .help("\(isExpanded ? "Hide" : "Show") \(chatCount) chat\(chatCount == 1 ? "" : "s")")
            .accessibilityLabel("\(isExpanded ? "Collapse" : "Expand") \(mission.title)")
            .revealed(hovered || isExpanded)
        }
        .padding(.vertical, 2)
        .padding(.horizontal, 4)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Theme.selected : (hovered ? Theme.muted : Color.clear)))
        .onHover { hovered = $0 }
        .contextMenu {
            Button("New Chat") { model.newSession(in: mission) }
                .disabled(mission.status != .active)
            Menu("Add Existing Chat") { MissionExistingChatItems(mission: mission) }
            Divider()
            Button("Open Mission") { model.openMission(mission.id) }
            MissionSidebarCoordinatorAction(mission: mission, inMenu: true)
            Button(isExpanded ? "Hide Chats" : "Show Chats") { isExpanded.toggle() }
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

/// Both shortcuts select by ID, independent of expansion, archive state and sidebar filters.
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
                    Image(systemName: MissionCoordinatorIndicator.symbol)
                }
                .buttonStyle(QuietIconButtonStyle())
                .help("Open coordinator")
                .accessibilityLabel("Open coordinator")
            }
        }
    }
}

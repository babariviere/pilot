import PilotCore
import SwiftUI

/// A mission in the sidebar: opens the mission page, and expands to its chats.
struct MissionSidebarRow: View {
    let mission: Mission
    let needsYou: Int
    let chatCount: Int
    let working: Int
    let selected: Bool
    @Binding var isExpanded: Bool
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 6) {
            Button { model.openMission(mission.id) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "scope")
                        .font(.system(size: 12))
                        .foregroundStyle(mission.status == .active ? Theme.foreground : Theme.faintForeground)
                        .frame(width: 14)
                    Text(mission.title)
                        .font(.system(size: 13))
                        .foregroundStyle(mission.status == .active ? Theme.foreground : Theme.mutedForeground)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if working > 0 {
                        Text("\(working)")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Capsule().fill(Color.accentColor.opacity(0.18)))
                            .foregroundStyle(Color.accentColor)
                            .help("\(working) working")
                    }
                    if needsYou > 0 {
                        Text("\(needsYou)")
                            .font(.caption2.weight(.bold))
                            .monospacedDigit()
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Capsule().fill(Theme.warning))
                            .foregroundStyle(.white)
                            .help("\(needsYou) item\(needsYou == 1 ? "" : "s") need you")
                            .accessibilityLabel("\(needsYou) need you")
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button { isExpanded.toggle() } label: {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.mutedForeground)
                    .frame(width: 16, height: 16)
            }
            .buttonStyle(.borderless)
            .help("\(isExpanded ? "Hide" : "Show") \(chatCount) chat\(chatCount == 1 ? "" : "s")")
            .accessibilityLabel("\(isExpanded ? "Collapse" : "Expand") \(mission.title)")
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 4)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Theme.selected : Color.clear))
        .contextMenu {
            Button("Open Mission") { model.openMission(mission.id) }
            Button("Edit Title and Goal…") { model.missionSheet = .edit(missionId: mission.id) }
            Divider()
            if mission.status != .done {
                Button("Mark as Done") { setStatus(.done) }
            }
            if mission.status != .active {
                Button("Reopen") { setStatus(.active) }
            }
            if mission.status != .archived {
                Button("Archive Mission") { setStatus(.archived) }
            }
        }
    }

    private func setStatus(_ status: MissionStatus) {
        model.missionAction { [client = model.client, id = mission.id] in
            try await client.updateMission(id, UpdateMissionRequest(status: status))
        }
    }
}


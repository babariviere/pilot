import SwiftUI

/// The same role mark in the sidebar, Chats tab and mission header.
struct MissionCoordinatorIndicator: View {
    var showsLabel = false

    var body: some View {
        Group {
            if showsLabel {
                Label("Coordinator", icon: PilotIcon.coordinator)
                    .font(.pilot(.small, weight: .semibold))
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(Theme.warning.opacity(0.15)))
            } else {
                PilotSymbol(PilotIcon.coordinator)
            }
        }
        .foregroundStyle(Theme.warning)
        .help("This chat coordinates the mission")
        .accessibilityLabel("Coordinator chat")
    }
}

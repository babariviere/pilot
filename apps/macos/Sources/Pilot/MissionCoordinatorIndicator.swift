import SwiftUI

/// The same role mark in the sidebar, Chats tab and mission header.
struct MissionCoordinatorIndicator: View {
    static let symbol = "star.fill"
    var showsLabel = false

    var body: some View {
        Group {
            if showsLabel {
                Label("Coordinator", systemImage: Self.symbol)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(Theme.warning.opacity(0.15)))
            } else {
                Image(systemName: Self.symbol)
                    .font(.system(size: 10))
            }
        }
        .foregroundStyle(Theme.warning)
        .help("This chat coordinates the mission")
        .accessibilityLabel("Coordinator chat")
    }
}

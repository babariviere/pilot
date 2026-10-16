import PilotCore
import SwiftUI

/// Execution location, never connection availability or agent outcome.
@MainActor struct RemoteChatBadgeText: Equatable {
    let hostName: String
    var label: String { "Remote" }
    var help: String { "Runs on \(hostName)" }
    var accessibilityLabel: String { "Remote chat on \(hostName)" }

    init?(context: HostViewContext?) {
        guard let context, context.host.hostId != "local" else { return nil }
        hostName = context.name
    }
}

/// Quiet location marker beside chat titles. Local chats need no extra chrome.
struct RemoteChatBadge: View {
    @Environment(\.hostViewContext) private var hostContext
    var context: HostViewContext? = nil

    var body: some View {
        if let text = RemoteChatBadgeText(context: context ?? hostContext) {
            Text(text.label)
                .font(.pilot(.small, weight: .medium))
                .foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.muted))
                .fixedSize()
                .help(text.help)
                .accessibilityLabel(text.accessibilityLabel)
        }
    }
}

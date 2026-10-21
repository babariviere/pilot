import PilotCore
import SwiftUI

/// Shared copy for both transcript renderers. Retired histories never offer a live action.
struct DisconnectedHistoryMessage {
    let title: String
    let detail: String
    let ownership: String?

    @MainActor init(context: HostViewContext, historyCached: Bool) {
        if context.host.hostId == "local" {
            title = "Local daemon unavailable"
            detail = "Reconnect to pilotd to continue. The saved conversation stays on this Mac."
            ownership = nil
        } else {
            title = "Remote history · \(context.name)"
            detail = historyCached
                ? "Remote devboxes are retired. Cached history is read-only; the original data remains on its host."
                : "Remote devboxes are retired. This conversation is not cached on this Mac; the original data remains on its host."
            ownership = "Retiring support does not stop work already running on that host."
        }
    }
}

/// Former remote chats remain identifiable, never redirected to Local.
struct DisconnectedNotice: View {
    let context: HostViewContext
    var historyCached = true

    var body: some View {
        let message = DisconnectedHistoryMessage(context: context, historyCached: historyCached)
        VStack(alignment: .leading, spacing: 3) {
            Text(message.title).font(.pilot(.label, weight: .medium))
            Text(message.detail).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            if let ownership = message.ownership {
                Text(ownership)
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }
}

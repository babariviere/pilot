import PilotCore
import SwiftUI

/// Former remote chats remain identifiable, never redirected to Local.
struct DisconnectedNotice: View {
    let context: HostViewContext
    var historyCached = true

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if context.host.hostId == "local" {
                Text("Local daemon unavailable").font(.pilot(.label, weight: .medium))
                Text("Reconnect to pilotd to continue. The saved conversation stays on this Mac.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            } else {
                Text("Remote history · \(context.name)").font(.pilot(.label, weight: .medium))
                Text(historyCached
                    ? "Remote devboxes are retired. Cached history is read-only; the original data remains on its host."
                    : "Remote devboxes are retired. This conversation is not cached on this Mac; the original data remains on its host.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                Text("Retiring support does not stop work already running on that host.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }
}

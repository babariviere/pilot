import PilotCore
import SwiftUI

struct DisconnectedNotice: View {
    let context: HostViewContext
    var historyCached = true
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Disconnected · \(context.name)").font(.pilot(.label, weight: .medium))
                    Text(historyCached ? "This chat may still be working. Its current state is unknown."
                         : "This chat may still be working. Reconnect to load its conversation.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                Spacer(minLength: 8)
                Button("Reconnect") {
                    busy = true
                    Task {
                        defer { busy = false }
                        do { try await context.hosts.reconnect(context.host); error = nil }
                        catch { self.error = error.localizedDescription }
                    }
                }.disabled(busy).controlSize(.small)
            }
            if let error { InlineProblem(error) }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }
}

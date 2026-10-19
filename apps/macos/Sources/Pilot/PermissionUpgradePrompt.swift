import PilotCore
import SwiftUI

/// Separate from message entry: only these explicit native decisions can approve publication.
struct PermissionUpgradePrompt: View {
    let request: PermissionUpgradeRequest
    let onDecide: (String, Bool) async throws -> Void
    @State private var sending = false
    @State private var finished = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Allow publish permission?")
                .font(.pilot(.headline, weight: .semibold)).foregroundStyle(Theme.foreground)
            Text(request.chatTitle)
                .font(.pilot(.label, weight: .semibold)).foregroundStyle(Theme.foreground)
                .lineLimit(2)
            Text(request.scope)
                .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                .lineLimit(4).textSelection(.enabled)
            Text("Requested by Control · Publish")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            Text("Allows pushing and opening or updating pull requests at the next run. Current work is unchanged. Never allows merging.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Spacer()
                Button("Deny") { decide(false) }.buttonStyle(.bordered)
                    .accessibilityIdentifier("publish-permission-deny")
                    .background(PermissionUpgradeActionAnchor(allow: false))
                Button("Allow") { decide(true) }.buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("publish-permission-allow")
                    .background(PermissionUpgradeActionAnchor(allow: true))
            }
            .disabled(sending || finished)
            if let error {
                Text(error).font(.pilot(.caption)).foregroundStyle(Theme.destructive)
            }
        }
        .padding(14)
        .background(Theme.tray, in: RoundedRectangle(cornerRadius: Theme.Radius.tray))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.tray).strokeBorder(Theme.border))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Publish permission request for \(request.chatTitle)")
    }

    private func decide(_ allow: Bool) {
        guard !sending && !finished else { return }
        sending = true
        error = nil
        Task { @MainActor in
            defer { sending = false }
            do { try await onDecide(request.id, allow); finished = true }
            catch { self.error = error.localizedDescription }
        }
    }
}

/// Passive geometry for native event routing and mounted verification, never an approval or hit target.
private struct PermissionUpgradeActionAnchor: NSViewRepresentable {
    let allow: Bool
    func makeNSView(context: Context) -> PermissionUpgradeActionAnchorView {
        let view = PermissionUpgradeActionAnchorView()
        view.allow = allow
        view.setAccessibilityElement(false)
        return view
    }
    func updateNSView(_ view: PermissionUpgradeActionAnchorView, context: Context) { view.allow = allow }
}
final class PermissionUpgradeActionAnchorView: NSView {
    var allow = false
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

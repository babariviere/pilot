import AppKit
import PilotCore
import SwiftUI

@MainActor
final class ComposerState: ObservableObject {
    @Published var draft = ""
    @Published var error: String?
    @Published var editorHeight: CGFloat = 18

    var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// Floating message box at the bottom of a chat.
/// Return steers the current run (or starts one), Option-Return queues a follow-up,
/// Shift-Return adds a line.
struct Composer: View {
    @ObservedObject var state: ComposerState
    let working: Bool
    let queued: Int
    let onSend: (String, DeliveryMode) -> Void
    let onStop: () -> Void
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topLeading) {
                if state.draft.isEmpty {
                    Text(working ? "Steer the agent…" : "Reply to Pilot…")
                        .font(fonts.body)
                        .foregroundStyle(Theme.faintForeground)
                        .allowsHitTesting(false)
                }
                ChatTextEditor(text: $state.draft, height: $state.editorHeight, font: fonts.nsBody) { flags in
                    send(flags.contains(.option) ? .followUp : .steer)
                }
                .frame(height: state.editorHeight)
            }
            HStack(spacing: 10) {
                KeyHints(working: working)
                if queued > 0 {
                    Label("\(queued) queued", systemImage: "tray.full").font(.caption).foregroundStyle(Theme.mutedForeground)
                }
                if let error = state.error {
                    Text(error).font(.caption).foregroundStyle(Theme.destructive).lineLimit(1)
                }
                Spacer()
                if working {
                    Button(action: onStop) { Image(systemName: "stop.fill") }
                        .buttonStyle(CircleIconButtonStyle(tint: Theme.destructive))
                        .help("Stop the current run")
                }
                Button { send(.steer) } label: { Image(systemName: "arrow.up") }
                    .buttonStyle(CircleIconButtonStyle())
                    .disabled(state.trimmed.isEmpty)
                    .help(working ? "Steer (↩)" : "Send (↩)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .card(radius: 14, shadow: true)
        .frame(maxWidth: Theme.column)
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
        .padding(.top, 6)
        .frame(maxWidth: .infinity)
    }

    private func send(_ mode: DeliveryMode) {
        let message = state.trimmed
        guard !message.isEmpty else { return }
        onSend(message, mode)
    }
}

private struct KeyHints: View {
    let working: Bool

    var body: some View {
        HStack(spacing: 10) {
            hint("↩", working ? "steer" : "send")
            if working { hint("⌥↩", "follow up") }
            hint("⇧↩", "new line")
        }
        .font(.system(size: 11))
        .foregroundStyle(Theme.faintForeground)
    }

    private func hint(_ key: String, _ label: String) -> some View {
        HStack(spacing: 4) {
            Text(key)
                .font(.system(size: 10, weight: .medium))
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 4).fill(Theme.muted))
            Text(label)
        }
    }
}

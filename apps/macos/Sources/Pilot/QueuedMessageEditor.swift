import PilotCore
import SwiftUI

/// Edits the selected queue row in place, keeping the main composer draft separate.
/// Like the composer, Return saves it as steering and Option-Return as a follow-up.
struct QueuedMessageEditor: View {
    @ObservedObject var state: ComposerState
    let available: Bool
    let completionDirectory: String?
    let onSave: (DeliveryMode) -> Void
    let onRemove: () -> Void
    let onNavigate: (QueueNavigationDirection) -> Bool
    @Environment(\.pilotFonts) private var fonts

    private var canSave: Bool {
        !state.mutatingQueue && available
            && !state.queueEditing.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ChatTextEditor(
                text: $state.queueEditing.draft, height: $state.queueEditorHeight, font: fonts.nsBody,
                minLines: 1, maxLines: 6,
                isEditable: !state.mutatingQueue,
                focusToken: state.queueFocus,
                onNavigateQueue: onNavigate,
                onCancel: state.cancelQueueEdit,
                onRemoveQueuedMessage: {
                    guard available, !state.mutatingQueue else { return }
                    onRemove()
                },
                completionDirectory: completionDirectory
            ) { flags in onSave(flags.contains(.option) ? .followUp : .steer) }
            .frame(height: state.queueEditorHeight)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.info.opacity(0.5)))
            if let error = state.queueEditError {
                Text(error).font(.pilot(.caption)).foregroundStyle(Theme.destructive).textSelection(.enabled)
            } else if !available {
                Text("Message is no longer queued. Your edit has not been sent.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.destructive).textSelection(.enabled)
            }
            HStack(spacing: 10) {
                // Hints drop out at narrow widths; the buttons always stay.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        KeyHint(key: "↩", label: "steer")
                        KeyHint(key: "⌥↩", label: "follow up")
                        KeyHint(key: "esc", label: "cancel")
                        KeyHint(key: "⌘⌫", label: "remove")
                    }
                    HStack(spacing: 10) {
                        KeyHint(key: "↩", label: "steer")
                        KeyHint(key: "⌥↩", label: "follow up")
                    }
                    Color.clear.frame(width: 0, height: 0)
                }
                Spacer(minLength: 4)
                if state.savingQueueEdit { ProgressView().controlSize(.mini) }
                Button("Cancel", action: state.cancelQueueEdit)
                    .keyboardShortcut(.cancelAction)
                    .disabled(state.mutatingQueue)
                Button("Follow up") { onSave(.followUp) }
                    .disabled(!canSave)
                    .help("Save and send after the current run (⌥↩)")
                Button("Steer") { onSave(.steer) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
                    .help("Save and deliver during the current run (↩)")
            }
            .controlSize(.small)
        }
        .padding(.vertical, 2)
    }
}

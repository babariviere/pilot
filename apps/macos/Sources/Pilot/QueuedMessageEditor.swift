import PilotCore
import SwiftUI

/// Edits the selected queue row in place, keeping the main composer draft separate.
struct QueuedMessageEditor: View {
    @ObservedObject var state: ComposerState
    let available: Bool
    let completionDirectory: String
    let onSave: () -> Void
    let onRemove: () -> Void
    let onNavigate: (QueueNavigationDirection) -> Bool
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ChatTextEditor(
                text: $state.queueEditing.draft, height: $state.queueEditorHeight, font: fonts.nsBody,
                minLines: 2, maxLines: 6,
                isEditable: !state.mutatingQueue,
                focusToken: state.queueFocus,
                onNavigateQueue: onNavigate,
                onCancel: state.cancelQueueEdit,
                onRemoveQueuedMessage: {
                    guard available, !state.mutatingQueue else { return }
                    onRemove()
                },
                completionDirectory: completionDirectory
            ) { _ in onSave() }
            .frame(height: state.queueEditorHeight)
            .padding(8)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border))
            if let error = state.queueEditError {
                Text(error).font(.caption).foregroundStyle(Theme.destructive).textSelection(.enabled)
            } else if !available {
                Text("Message is no longer queued. Your edit has not been sent.")
                    .font(.caption).foregroundStyle(Theme.destructive).textSelection(.enabled)
            }
            HStack {
                Text("↩ save · esc cancel · ⇧↩ new line · ⌘⌫ remove")
                    .font(.caption).foregroundStyle(Theme.mutedForeground)
                Spacer()
                if state.savingQueueEdit { ProgressView().controlSize(.small) }
                Button("Cancel", action: state.cancelQueueEdit)
                    .keyboardShortcut(.cancelAction)
                    .disabled(state.mutatingQueue)
                Button("Save", action: onSave)
                    .keyboardShortcut(.defaultAction)
                    .disabled(state.mutatingQueue || !available || state.queueEditing.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}

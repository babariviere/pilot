import PilotCore
import SwiftUI

@MainActor
final class QueuedMessageEditorState: ObservableObject {
    @Published var draft: String
    @Published var saving = false
    @Published var error: String?

    init(text: String) { draft = text }

    var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// A separate draft leaves both the durable queue and the main composer untouched until Save.
struct QueuedMessageEditor: View {
    let message: QueuedMessage
    let onSave: (Int, String) async throws -> Void
    @StateObject private var state: QueuedMessageEditorState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.pilotFonts) private var fonts

    init(message: QueuedMessage, onSave: @escaping (Int, String) async throws -> Void) {
        self.message = message
        self.onSave = onSave
        _state = StateObject(wrappedValue: QueuedMessageEditorState(text: message.text))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Edit queued message").font(.headline)
            Text(message.mode == .followUp ? "Follow-up" : "Steering").font(.caption).foregroundStyle(Theme.mutedForeground)
            TextEditor(text: $state.draft)
                .font(fonts.body)
                .padding(6)
                .frame(height: 160)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border))
                .disabled(state.saving)
            Text("Changes can only be saved while this message is still queued.")
                .font(.caption)
                .foregroundStyle(Theme.mutedForeground)
            if let error = state.error {
                Text(error).font(.callout).foregroundStyle(Theme.destructive).textSelection(.enabled)
            }
            HStack {
                Spacer()
                if state.saving { ProgressView().controlSize(.small) }
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(state.saving)
                Button("Save", action: save)
                    .keyboardShortcut(.defaultAction)
                    .disabled(state.saving || state.trimmed.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 480)
        .interactiveDismissDisabled(state.saving)
    }

    private func save() {
        let text = state.trimmed
        guard !text.isEmpty, !state.saving else { return }
        state.saving = true
        state.error = nil
        Task {
            do {
                try await onSave(message.id, text)
                dismiss()
            } catch {
                // Keep the draft available to copy/retry, including when the agent consumed the original.
                state.error = error.localizedDescription
            }
            state.saving = false
        }
    }
}

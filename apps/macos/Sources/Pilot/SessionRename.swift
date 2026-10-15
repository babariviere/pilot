import PilotCore
import SwiftUI

/// The chat a "Rename…" sheet edits. Presented once from `MainWindow`.
struct SessionRenameTarget: Identifiable, Hashable {
    let id: String
    let title: String
}

/// Context-menu item that opens the rename sheet for a chat.
struct SessionRenameAction: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Button {
            model.renamingSession = SessionRenameTarget(id: session.id, title: session.title)
        } label: {
            Label("Rename…", icon: PilotIcon.edit)
        }
        .disabled(model.pendingSessionActions.contains(session.id))
        .help("Change this chat's title")
    }
}

struct SessionRenameSheet: View {
    let target: SessionRenameTarget
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title: String

    init(target: SessionRenameTarget) {
        self.target = target
        _title = State(initialValue: target.title)
    }

    private var trimmed: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool { !trimmed.isEmpty && trimmed != target.title }

    var body: some View {
        SheetScaffold("Rename chat", primary: SheetPrimaryAction(title: "Rename", enabled: valid, action: save), width: 360) {
            TextField("Chat title", text: $title)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Chat title")
                .onSubmit { if valid { save() } }
        }
    }

    private func save() {
        model.renameSession(target.id, title: trimmed)
        dismiss()
    }
}

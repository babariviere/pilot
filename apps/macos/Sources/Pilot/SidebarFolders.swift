import PilotCore
import SwiftUI

/// No SwiftUI @State: this app builds with Command Line Tools only.
@MainActor
final class ProjectFolderEditorState: ObservableObject {
    @Published var presented = false
    @Published var name = ""
    var folderId: String?
    var projectId: String?

    var valid: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    func begin(_ folder: ProjectFolder? = nil, projectId: String? = nil) {
        folderId = folder?.id
        name = folder?.name ?? ""
        self.projectId = projectId
        presented = true
    }
}

struct ProjectFolderEditor: View {
    @ObservedObject var editor: ProjectFolderEditorState
    let onSave: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(editor.folderId == nil ? "New Folder" : "Rename Folder")
                .font(.pilot(.body, weight: .bold))
            TextField("Folder name", text: $editor.name)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Folder name")
                .onSubmit { if editor.valid { onSave() } }
            Text("Folders organize projects in Pilot only. Repositories stay where they are.")
                .font(.pilot(.small)).foregroundStyle(Theme.mutedForeground)
            HStack {
                Spacer()
                Button("Cancel") { editor.presented = false }
                    .keyboardShortcut(.cancelAction)
                Button(editor.folderId == nil ? "Create" : "Save", action: onSave)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!editor.valid)
            }
        }
        .padding(20)
        .frame(width: 340)
    }
}

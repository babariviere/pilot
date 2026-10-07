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
                .font(.headline)
            TextField("Folder name", text: $editor.name)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Folder name")
                .onSubmit { if editor.valid { onSave() } }
            Text("Folders organize projects in Pilot only. Repositories stay where they are.")
                .font(.caption).foregroundStyle(.secondary)
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

struct ProjectFolderHeader: View {
    let folder: ProjectFolder
    let count: Int
    @Binding var isExpanded: Bool
    let onRename: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Button { isExpanded.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .frame(width: 12)
                    Image(systemName: "folder.fill")
                    Text(folder.name).lineLimit(1)
                    Text("\(count)").foregroundStyle(Theme.faintForeground)
                    Spacer(minLength: 0)
                }
                .font(.system(size: 11, weight: .semibold))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("\(isExpanded ? "Collapse" : "Expand") \(folder.name)")
            .accessibilityLabel("\(isExpanded ? "Collapse" : "Expand") folder \(folder.name), \(count) projects")
            Menu {
                actions
            } label: {
                Image(systemName: "ellipsis").frame(width: 16, height: 16)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Manage folder \(folder.name)")
            .accessibilityLabel("Manage folder \(folder.name)")
        }
        .contextMenu { actions }
    }

    @ViewBuilder
    private var actions: some View {
        Button("Rename Folder…", action: onRename)
        Button("Delete Folder", role: .destructive, action: onDelete)
            .help("Keep projects and sessions, removing only this folder")
    }
}

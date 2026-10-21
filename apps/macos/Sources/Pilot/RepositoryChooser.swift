import PilotCore
import SwiftUI

/// Browses only the selected daemon's allowed roots. Paths are never Mac file URLs.
struct RepositoryChooser: View {
    let host: HostRef
    @ObservedObject var hosts: ClientDirectory
    let selected: (Hosted<Project>) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selection = RepositorySelection()
    @State private var page: RepositoryDirectoryPage?
    @State private var entries: [RepositoryDirectory] = []
    @State private var busy = false
    @State private var error: String?
    @State private var importing = false

    var body: some View {
        SheetScaffold("Choose repository", subtitle: HostViewContext(host: host, hosts: hosts).name,
            error: error, primary: SheetPrimaryAction(title: "Choose repository", enabled: !busy && page != nil && hosts.available.contains(host), action: choose)) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Button("Home") { selection = RepositorySelection() }
                    Text(page?.path.isEmpty == false ? page!.path : "Home").font(.pilot(.caption)).lineLimit(1)
                    Spacer()
                }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(entries) { directory in
                            Button { selection = RepositorySelection(rootId: selection.rootId, path: directory.path) } label: {
                                HStack { Label(directory.name, icon: PilotIcon.project); Spacer(); DisclosureChevron(expanded: false) }
                                    .padding(.vertical, 7).contentShape(Rectangle())
                            }.rowButtonStyle()
                            Divider()
                        }
                        if let offset = page?.nextOffset { Button("Show more folders") { Task { await load(offset: offset) } } }
                        if page?.truncated == true { Text("Some folders could not be listed. Choose a more specific folder.").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground) }
                    }
                }.frame(minHeight: 200)
                if busy { ProgressView().controlSize(.small) }
                if let error { InlineProblem(error) }
            }
        } footerLeading: {
            Button("Import from GitHub…") { importing = true }.controlSize(.small)
        }
        .task(id: "\(selection.rootId):\(selection.path)") { await load() }
        .sheet(isPresented: $importing) {
            GitHubImportContent(host: host, hosts: hosts, initialURL: "") { project in importing = false; selected(project) }
        }
    }

    private func choose() {
        let captured = selection
        busy = true
        Task {
            defer { busy = false }
            do { selected(try await hosts.selectRepository(host: host, selection: captured)) }
            catch { self.error = error.localizedDescription }
        }
    }

    private func load(offset: Int = 0) async {
        let captured = selection
        busy = true
        defer { busy = false }
        do {
            let next = try await hosts.repositoryDirectory(host: host, selection: captured, offset: offset)
            guard !Task.isCancelled, captured == selection else { return }
            if offset == 0 { entries = next.entries } else { entries += next.entries }
            page = next; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

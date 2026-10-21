import PilotCore
import SwiftUI

@MainActor
struct GitHubImportSheet: View {
    @ObservedObject var hosts: ClientDirectory
    let localHost: HostRef?
    var initialURL = ""
    var initialHost: HostRef?
    let selected: (Hosted<Project>) -> Void
    var body: some View {
        if let localHost {
            GitHubImportContent(host: localHost, hosts: hosts, initialURL: initialURL, selected: selected)
        } else {
            SheetScaffold("Import GitHub project", width: 600) {
                SettingsNote("Waiting for the local daemon.")
            }
        }
    }
}

@MainActor
struct GitHubImportContent: View {
    let host: HostRef
    @ObservedObject var hosts: ClientDirectory
    let selected: (Hosted<Project>) -> Void
    @StateObject private var model: GitHubImportModel
    @State private var setup = false
    @State private var choosingFolder = false
    @State private var confirming: GitHubImportOperation?
    init(host: HostRef, hosts: ClientDirectory, initialURL: String, model: GitHubImportModel? = nil,
         selected: @escaping (Hosted<Project>) -> Void) {
        self.host = host; self.hosts = hosts; self.selected = selected
        precondition(model == nil || model?.host == host)
        _model = StateObject(wrappedValue: model ?? GitHubImportModel(host: host, actions: .live(hosts), initialURL: initialURL))
    }
    var body: some View {
        SheetScaffold("Import GitHub project", subtitle: HostViewContext(host: host, hosts: hosts).name,
            error: model.problem, primary: SheetPrimaryAction(title: "Clone and add project", enabled: model.canStart,
                action: { Task { await model.start() } }), width: 620) {
            if !model.available { InlineProblem("Disconnected. Reconnect this saved host. Import will not fall back to Local.") }
            TextField("Search listed repositories", text: $model.query).textFieldStyle(.roundedBorder)
                .accessibilityLabel("Search accessible GitHub repositories")
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(model.repositories.filter { model.query.isEmpty || $0.name.localizedCaseInsensitiveContains(model.query) }) { repo in
                        Button { model.choose(repo) } label: {
                            HStack { Text(repo.name); Spacer(); if repo.private { MetaText("Private") } }
                                .font(.pilot(.body)).padding(.vertical, 7).contentShape(Rectangle())
                        }.rowButtonStyle().disabled(model.busy)
                        Divider()
                    }
                    if model.repositories.isEmpty { SettingsNote("Load accessible repositories, or paste a GitHub.com URL below.") }
                }
            }.frame(height: 130)
            if model.truncated { SettingsNote("Search covers the first 300 recently updated accessible repositories. Paste a URL for others.") }
            HStack {
                Button("Load repositories") { Task { await model.refresh(loadRepositories: true) } }.disabled(model.busy || !model.available)
                Button("Connect GitHub…") { setup = true }.disabled(!model.available)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
            }.controlSize(.small)
            TextField("GitHub repository URL", text: $model.url).textFieldStyle(.roundedBorder).disabled(model.busy || model.uncertain)
                .accessibilityLabel("GitHub repository URL")
            HStack {
                TextField("Destination on this host (under Home)", text: $model.destination).textFieldStyle(.roundedBorder).disabled(model.busy || model.uncertain)
                    .accessibilityLabel("Destination on selected host")
                Button("Choose parent…") { choosingFolder = true }.controlSize(.small).disabled(model.busy || !model.available || model.uncertain)
            }
            HStack {
                Button("Check destination") { Task { await model.checkDestination() } }.controlSize(.small).disabled(model.busy || !model.available || model.uncertain)
                if let resolved = model.resolvedDestination { Text(resolved).font(.pilot(.caption, design: .monospaced)).textSelection(.enabled) }
                else { SettingsNote("Resolve and review the destination on this host before cloning.") }
            }
            SettingsNote("Clone committed GitHub files only. No local changes, setup scripts, submodules, trust grants or project context are copied. Existing destinations need validation and explicit reuse approval.")
            if !model.operations.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(model.operations.reversed()) { op in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(op.url).font(.pilot(.label)).lineLimit(1).truncationMode(.middle)
                                Text("\(op.destination) · \(op.phase.replacingOccurrences(of: "_", with: " "))").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                                if let problem = op.problem { InlineProblem(problem) }
                                HStack {
                                    if op.working { ProgressView().controlSize(.small); Button("Cancel import") { Task { await model.act(op, "cancel") } } }
                                    else if op.phase == "confirm_existing" { Button("Review existing checkout…") { confirming = op } }
                                    else if ["interrupted", "cancelled", "failed"].contains(op.phase) { Button("Resume original import") { Task { await model.act(op, "resume") } } }
                                    if op.phase == "done" { Button("Open project") { Task { if let project = await model.open(op) { selected(project) } } } }
                                }.controlSize(.small).disabled(model.busy || !model.available)
                            }
                        }
                    }
                }.frame(maxHeight: 150)
            }
            HStack {
                Button("Refresh imports") { Task { await model.refresh() } }.disabled(model.busy || !model.available)
                if model.uncertain { Button("Retry original start") { Task { await model.start(retryOriginal: true) } }.disabled(model.busy || !model.available) }
            }.controlSize(.small)
        }
        .task(id: model.available) { if model.available { await model.refresh() } else { model.detach() } }
        .task(id: model.operations.contains(where: \.working)) {
            while model.operations.contains(where: \.working), !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { break }
                await model.refresh()
            }
        }
        .onDisappear { model.detach() }
        .onChange(of: model.url) { _, _ in model.suggestDestination() }
        .sheet(isPresented: $setup) {
            SheetScaffold("GitHub on this host", width: 620) {
                ScrollView { SettingsColumn { GitHubSetupSection(host: host, hosts: hosts) } }.frame(height: 440)
            }
        }
        .sheet(isPresented: $choosingFolder) {
            GitHubDestinationChooser(host: host, hosts: hosts) { path in
                let name = GitHubImportValidation.repository(model.url)?.split(separator: "/").last.map(String.init) ?? "project"
                model.destination = path.isEmpty ? name : path + "/" + name; choosingFolder = false
            }
        }
        .sheet(item: $confirming) { value in
            GitHubReuseSheet(value: value, cancel: { confirming = nil }) {
                confirming = nil; Task { await model.act(value, "confirm_existing") }
            }
        }
    }
}

@MainActor
struct GitHubReuseSheet: View {
    let value: GitHubImportOperation
    let cancel: () -> Void
    let confirm: () -> Void
    var body: some View {
        SheetScaffold("Use existing checkout", primary: SheetPrimaryAction(title: "Use this checkout", action: confirm), cancel: cancel, width: 520) {
            Text(value.url).font(.pilot(.body))
            Text(value.destination).font(.pilot(.caption, design: .monospaced)).textSelection(.enabled)
            SettingsNote("The host validated this standalone checkout's origin and identity. Confirm that its files are ready to use. Registration does not reset files, fetch, run setup, replace credentials, grant trust or share context. Its identity and remote are checked again on confirmation.")
        }
    }
}

@MainActor
private struct GitHubDestinationChooser: View {
    let host: HostRef
    @ObservedObject var hosts: ClientDirectory
    let selected: (String) -> Void
    @State private var path = ""
    @State private var page: RepositoryDirectoryPage?
    @State private var problem: String?
    @State private var busy = false
    var body: some View {
        SheetScaffold("Choose destination parent", subtitle: HostViewContext(host: host, hosts: hosts).name,
            error: problem, primary: SheetPrimaryAction(title: "Use this folder", enabled: page != nil && !busy && hosts.available.contains(host), action: { selected(path) }), width: 500) {
            HStack { Button("Home") { path = "" }; Text(path.isEmpty ? "Home" : path).font(.pilot(.caption)).lineLimit(1) }
            ScrollView {
                VStack(alignment: .leading) {
                    ForEach(page?.entries ?? []) { directory in
                        Button(directory.name) { path = directory.path }.buttonStyle(.plain).font(.pilot(.body)).padding(.vertical, 5)
                    }
                    if page?.truncated == true || page?.nextOffset != nil { SettingsNote("Folder listing is bounded. Navigate to a more specific folder, or type the destination in the import form.") }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(height: 220)
        }
        .task(id: path) {
            let captured = path; page = nil; busy = true; defer { busy = false }
            do {
                let next = try await hosts.repositoryDirectory(host: host, selection: RepositorySelection(rootId: "home", path: captured))
                guard !Task.isCancelled, captured == path else { return }; page = next; problem = nil
            } catch { if !Task.isCancelled { problem = "Could not list folders on this host. Reconnect and try again." } }
        }
    }
}

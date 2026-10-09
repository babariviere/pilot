import AppKit
import PilotCore
import SwiftUI

@MainActor
final class NewSessionForm: ObservableObject {
    let branches = BranchSelectorState()
    private(set) var revision = UUID()
    var onDraftChanged: (() -> Void)?
    @Published var model = "" { didSet { onDraftChanged?() } }
    @Published var message = "" { didSet { onDraftChanged?() } }
    @Published var attachments = ImageAttachments() { didSet { onDraftChanged?() } }
    /// A folder outside any project.
    @Published var folder = "" { didSet { onDraftChanged?() } }
    @Published var error: String?
    @Published var busy = false
    @Published var tab: ComposerTab = .newTask { didSet { onDraftChanged?() } }
    @Published var editorHeight: CGFloat = 60
    @Published var models = ModelList(models: [])
    @Published var mode: ChatMode = .build { didSet { onDraftChanged?() } }
    @Published var workspace: WorkspaceMode? { didSet { onDraftChanged?() } }
    @Published var pendingBaseBranch: String? { didSet { onDraftChanged?() } }
    private var draftRevision = 0

    var hasUnsubmittedDraft: Bool { !message.isEmpty || !attachments.items.isEmpty || pendingBaseBranch != nil || busy }

    func resetChatContext() {
        mode = .build
        workspace = nil
        pendingBaseBranch = nil
        branches.restoreSelection(scope: nil, branch: nil)
    }

    func effectiveWorkspace(for project: Project?) -> WorkspaceMode {
        guard let project else { return .direct }
        return workspace ?? (project.usesPrivateClones ? .clone : .direct)
    }

    func chooseMode(_ mode: ChatMode) {
        if self.mode != mode {
            pendingBaseBranch = nil
            error = nil
        }
        self.mode = mode
    }

    func chooseBaseBranch(_ branch: String?) {
        pendingBaseBranch = nil
        error = nil
    }

    func resolvePendingBaseBranch(scope: String, branches: BranchSelectorState) {
        guard branches.scope == scope, branches.error == nil, let branch = pendingBaseBranch else { return }
        if branches.list.branches.contains(branch) {
            branches.select(branch, for: scope)
        } else {
            error = "The Ask source branch is no longer on origin. Choose another Build base branch."
        }
    }

    func canStart(in project: Project?, branches: BranchSelectorState? = nil) -> Bool {
        let branches = branches ?? self.branches
        let scope = BranchSelectorState.scope(project: project, mode: mode, workspace: workspace)
        let sourceReady = pendingBaseBranch.map { branch in
            branches.selection(for: scope) == branch && branches.list.branches.contains(branch)
                && branches.error == nil && !branches.loading
        } ?? true
        return !busy && (project != nil || !folder.isEmpty) && sourceReady
            && (!message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.items.isEmpty)
    }

    /// Invalidate before the new-task view mounts, not just when it consumes the prefill.
    func invalidatePendingSubmission() { revision = UUID() }

    func consumeDraft(from app: AppModel, branches: BranchSelectorState? = nil) {
        if draftRevision != app.draftRevision || app.draftMessage != nil {
            draftRevision = app.draftRevision
            mode = .build
            workspace = app.draftWorkspace
            pendingBaseBranch = app.draftBaseBranch
            (branches ?? self.branches).restoreSelection(scope: nil, branch: nil)
        }
        guard let message = app.draftMessage else { return }
        revision = UUID()
        for image in attachments.items { attachments.remove(image.id) }
        attachments.error = nil
        self.message = message
        folder = app.draftCwd ?? ""
        model = ""
        error = nil
        tab = .newTask
        app.draftMessage = nil
        app.draftBaseBranch = nil
        app.draftCwd = nil
        app.draftWorkspace = nil
    }

    /// A spawn completing after a debug prefill must not erase or navigate away from the newer draft.
    func completeSubmission(revision: UUID) -> Bool {
        guard self.revision == revision else { return false }
        self.revision = UUID()
        message = ""
        attachments = ImageAttachments()
        resetChatContext()
        return true
    }
}

enum ComposerTab: Hashable {
    case newTask
    case running
}

/// Home: a sky band, the task composer, and a dashboard of what agents are doing.
struct HomeView: View {
    @EnvironmentObject private var app: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        ScrollView {
            ZStack(alignment: .top) {
                DitherSky()
                    .frame(height: 300)
                VStack(spacing: 0) {
                    Text("What’s on your mind?")
                        .font(.system(size: 24, weight: .semibold))
                        .tracking(-0.3)
                        .foregroundStyle(Theme.foreground)
                        .shadow(color: .white, radius: 6)
                        .shadow(color: .white, radius: 16)
                        .padding(.top, 196)
                        .padding(.bottom, 16)
                    TaskComposer(form: app.newSessionForm, client: app.client)
                        .frame(maxWidth: 640)
                    Dashboard()
                        .frame(maxWidth: 1180)
                        .padding(.top, 48)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 40)
            }
        }
        .background(Theme.background)
    }
}

/// "New task" composer with a "Running" tab, as on Berth's home.
struct TaskComposer: View {
    @EnvironmentObject private var app: AppModel
    @ObservedObject private var client: PilotClient
    @Environment(\.pilotFonts) private var fonts
    @AppStorage("lastProjectId") private var lastProjectId = ""
    @StateObject private var form: NewSessionForm
    @StateObject private var branches: BranchSelectorState
    @FocusState private var focused: Bool

    @MainActor init(branches: BranchSelectorState? = nil, form: NewSessionForm? = nil, client: PilotClient? = nil) {
        let form = form ?? NewSessionForm()
        _form = StateObject(wrappedValue: form)
        _branches = StateObject(wrappedValue: branches ?? form.branches)
        _client = ObservedObject(wrappedValue: client ?? AppModel.shared.client)
    }

    private var project: Project? {
        client.project(app.draftProjectId) ?? (form.folder.isEmpty ? client.project(lastProjectId) ?? client.projects.first : nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                TabButton(title: "New chat", selected: form.tab == .newTask) { form.tab = .newTask }
                TabButton(title: "Running", count: client.workingCount, selected: form.tab == .running) { form.tab = .running }
                Spacer()
                Picker("Chat mode", selection: Binding(get: { form.mode }, set: form.chooseMode)) {
                    Text("Build").tag(ChatMode.build)
                    Text("Ask").tag(ChatMode.ask)
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 130)
                .disabled(form.busy)
                .help("Build can make changes. Ask is read-only and creates no isolated workspace.")
            }
            .padding(.horizontal, 12)
            .padding(.top, 9)
            .padding(.bottom, 7)

            if form.tab == .newTask {
                newTask
            } else {
                RunningList(sessions: client.activeSessions.filter(\.isWorking))
                    .frame(minHeight: 120, alignment: .top)
            }
        }
        // Opaque, so the sky's dissolving dots never show through.
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.tray))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border))
        .task(id: modelScopeKey) { await loadModels() }
        .task(id: branchLoadKey) { await loadBranches() }
        .onAppear { consumeDraft() }
        .onChange(of: app.draftRevision) { _, _ in consumeDraft() }
        .onChange(of: app.draftMessage) { _, message in if message != nil { consumeDraft() } }
    }

    private var newTask: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                ImageAttachmentPreviews(attachments: $form.attachments)
                    .disabled(form.busy)
                ZStack(alignment: .topLeading) {
                    if form.message.isEmpty {
                        Text(form.mode == .ask ? "Ask about the code, explore an idea, or plan a change…" : "Describe a task, a bug to fix, an idea to try…")
                            .font(fonts.body)
                            .foregroundStyle(Theme.faintForeground)
                            .allowsHitTesting(false)
                    }
                    ChatTextEditor(text: $form.message, height: $form.editorHeight, font: fonts.nsBody, minLines: 3, maxLines: 14,
                                   isEditable: !form.busy, onPasteImages: { form.attachments.paste(from: $0) },
                                   completionDirectory: form.mode == .ask ? nil : project?.path ?? (form.folder.isEmpty ? FileManager.default.homeDirectoryForCurrentUser.path : form.folder)) { _ in
                        start()
                    }
                    .frame(height: form.editorHeight)
                }
            }
                .padding(12)
                .card(radius: 10)
                .padding(.horizontal, 4)
            HStack(spacing: 6) {
                ProjectMenu(selected: project, folder: form.folder, projects: client.projects) { choice in
                    switch choice {
                    case let .project(id):
                        form.pendingBaseBranch = nil
                        app.draftProjectId = id
                        form.folder = ""
                    case .folder:
                        if let path = chooseFolder(startingAt: form.folder) {
                            form.folder = path
                            form.pendingBaseBranch = nil
                            app.draftProjectId = nil
                            lastProjectId = ""
                        }
                    case .addProject:
                        app.addProject()
                    }
                }
                if let scope = branchScopeKey {
                    BranchMenu(state: branches, scope: scope, mode: form.mode, onSelect: form.chooseBaseBranch) {
                        Task { await loadBranches() }
                    }
                    .disabled(form.busy)
                }
                ModelMenu(model: $form.model, projectDefault: project?.model, list: form.models)
                if form.mode == .build, let project {
                    Menu {
                        Button("Project default (\(project.usesPrivateClones ? "Isolated workspace" : "Current checkout"))") { form.workspace = nil }
                        Button("Isolated workspace") { form.workspace = .clone }
                        Button("Current checkout") { form.workspace = .direct }
                    } label: {
                        ChipLabel(title: form.effectiveWorkspace(for: project) == .clone ? "Isolated workspace" : "Checkout", icon: "square.on.square")
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .disabled(form.busy)
                    .help("Build workspace for this chat only. Defaults to the project's settings.")
                }
                if let error = form.error {
                    Text(error).font(.caption).foregroundStyle(Theme.destructive).lineLimit(1)
                }
                Spacer()
                if form.busy { ProgressView().controlSize(.small) }
                Button(action: start) { Image(systemName: "arrow.up") }
                    .buttonStyle(CircleIconButtonStyle())
                    .disabled(!canStart)
                    .help("Start session (↩)")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            Text(form.mode == .ask
                 ? "Ask · read-only · no isolated workspace · \(branches.selection(for: branchScopeKey).map { "origin/\($0) snapshot" } ?? "current checkout")"
                 : "Build · \(form.effectiveWorkspace(for: project) == .clone ? "isolated workspace" : "current checkout") · \(branches.selection(for: branchScopeKey).map { "origin/\($0)" } ?? (form.effectiveWorkspace(for: project) == .clone ? "default base" : "local files"))")
                .font(.caption).foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 12).padding(.bottom, 8)
        }
    }

    private var canStart: Bool {
        form.canStart(in: project, branches: branches)
    }

    /// Reloads the pi model scope when the project or folder changes.
    private var modelScopeKey: String { project?.id ?? form.folder }

    private var branchScopeKey: String? {
        BranchSelectorState.scope(project: project, mode: form.mode, workspace: form.workspace)
    }

    private func consumeDraft() {
        form.consumeDraft(from: app, branches: branches)
        Task { await loadBranches() }
    }

    private var branchLoadKey: String { "\(client.hasProjectSnapshot):\(branchScopeKey ?? form.folder)" }

    private func loadBranches() async {
        // An empty catalog during startup is not a change to the restored draft's destination.
        guard client.hasProjectSnapshot || (app.draftProjectId == nil && !form.folder.isEmpty) else { return }
        let projectId = project?.id
        let mode = form.mode
        let workspace = form.workspace
        let scope = branchScopeKey
        if scope == nil && mode == .build && form.effectiveWorkspace(for: project) == .direct {
            // Choosing a direct workspace explicitly abandons a remote Build base.
            if project != nil || !form.folder.isEmpty { form.chooseBaseBranch(nil) }
        }
        await branches.load(scope: scope, mode: mode) {
            guard let projectId else { return RemoteBranchList() }
            return try await client.remoteBranches(projectId, mode: mode, workspace: workspace)
        }
        if mode == form.mode, scope == branchScopeKey, let scope {
            form.resolvePendingBaseBranch(scope: scope, branches: branches)
        }
    }

    private func loadModels() async {
        if form.folder.isEmpty, let project, app.draftProjectId != project.id {
            // Remember the effective default project too, not just explicit picker selections.
            app.draftProjectId = project.id
        }
        form.models = (try? await client.models(projectId: project?.id, cwd: project == nil ? form.folder : nil)) ?? ModelList(models: [])
    }

    private func start() {
        guard canStart else { return }
        form.busy = true
        form.error = nil
        let revision = form.revision
        let model = form.model.trimmingCharacters(in: .whitespaces)
        do { try form.attachments.retainForHistory() }
        catch {
            form.error = "Could not retain attached images: \(error.localizedDescription)"
            form.busy = false
            return
        }
        let request = SpawnRequest(
            projectId: project?.id,
            cwd: project == nil ? form.folder : nil,
            message: form.attachments.message(text: form.message),
            model: model.isEmpty ? nil : model,
            baseBranch: branches.selection(for: branchScopeKey),
            mode: form.mode,
            workspace: form.mode == .build && project != nil ? form.workspace : nil
        )
        Task {
            defer { form.busy = false }
            do {
                let session = try await app.client.spawn(request)
                if let id = request.projectId { lastProjectId = id }
                if form.completeSubmission(revision: revision) { app.selectedSessionId = session.id }
            } catch {
                if form.revision == revision { form.error = error.localizedDescription }
            }
        }
    }
}

private struct TabButton: View {
    let title: String
    var count: Int = 0
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(title)
                if count > 0 {
                    Text("\(count)").foregroundStyle(Theme.faintForeground)
                }
            }
            .font(.system(size: 12, weight: selected ? .semibold : .regular))
            .foregroundStyle(selected ? Theme.foreground : Theme.mutedForeground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct RunningList: View {
    let sessions: [SessionSummary]
    @EnvironmentObject private var app: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if sessions.isEmpty {
                Text("No agents are running.")
                    .font(.callout)
                    .foregroundStyle(Theme.mutedForeground)
                    .frame(maxWidth: .infinity, minHeight: 100)
            }
            ForEach(sessions) { session in
                Button { app.selectedSessionId = session.id } label: {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.mini)
                        Text(session.title).lineLimit(1)
                        Spacer()
                        Text(app.client.project(session.projectId)?.name ?? URL(filePath: session.cwd).lastPathComponent)
                            .foregroundStyle(Theme.mutedForeground)
                    }
                    .font(.system(size: 13))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .card(radius: 10)
        .padding(.horizontal, 4)
        .padding(.bottom, 4)
    }
}

enum ProjectChoice {
    case project(String)
    case folder
    case addProject
}

struct ProjectMenu: View {
    let selected: Project?
    let folder: String
    let projects: [Project]
    let choose: (ProjectChoice) -> Void

    var body: some View {
        Menu {
            ForEach(projects) { project in
                Button {
                    choose(.project(project.id))
                } label: {
                    if project.id == selected?.id { Label(project.name, systemImage: "checkmark") } else { Text(project.name) }
                }
            }
            if !projects.isEmpty { Divider() }
            Button("Other Folder…") { choose(.folder) }
            Button("Add Project…") { choose(.addProject) }
        } label: {
            ChipLabel(
                title: selected?.name ?? (folder.isEmpty ? "Choose project" : URL(filePath: folder).lastPathComponent),
                icon: "folder"
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}

struct ModelMenu: View {
    @Binding var model: String
    /// The project's default model, else pi's default.
    let projectDefault: String?
    let list: ModelList

    private var fallback: String? { projectDefault ?? list.defaultModel }

    var body: some View {
        Menu {
            Button {
                model = ""
            } label: {
                let name = fallback.map(displayName) ?? "pi settings"
                if model.isEmpty { Label("Default (\(name))", systemImage: "checkmark") } else { Text("Default (\(name))") }
            }
            ForEach(groups, id: \.provider) { group in
                Section(group.provider) {
                    ForEach(group.models) { option in
                        Button {
                            model = option.id
                        } label: {
                            if model == option.id { Label(option.name, systemImage: "checkmark") } else { Text(option.name) }
                        }
                    }
                }
            }
        } label: {
            ChipLabel(title: displayName(model.isEmpty ? fallback ?? "Default model" : model), icon: "cpu", dot: Theme.warning)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Models from your pi scope (enabledModels)")
    }

    private var groups: [(provider: String, models: [ModelOption])] {
        var order: [String] = []
        var byProvider: [String: [ModelOption]] = [:]
        for option in list.models {
            if byProvider[option.provider] == nil { order.append(option.provider) }
            byProvider[option.provider, default: []].append(option)
        }
        return order.map { ($0, byProvider[$0] ?? []) }
    }

    private func displayName(_ id: String) -> String {
        list.models.first { $0.id == id }?.name ?? (id.split(separator: "/").last.map(String.init) ?? id)
    }
}

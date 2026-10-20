import AppKit
import PilotCore
import PilotTelemetry
import SwiftUI

@MainActor
final class NewSessionForm: ObservableObject {
    @Published var executionHost: HostRef? { didSet { onDraftChanged?() } }
    @Published var pendingOperationId: String? { didSet { onDraftChanged?() } }
    @Published var checkingStart = false
    @Published var checkoutChoice: CheckoutChoice?
    @Published var checkoutValidation: UUID?
    var checkoutValidationTask: Task<Void, Never>?
    var startCheckId: UUID?
    @Published var startRecoveryMessage: String?
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
    @Published var mission: Mission? { didSet { onDraftChanged?() } }
    /// The tracked ticket this chat starts from. Bound to the chat once it starts; the project is locked to it.
    @Published var trackedItem: TrackedItemBinding? { didSet { onDraftChanged?() } }
    private var draftRevision = 0

    var hasUnsubmittedDraft: Bool {
        !message.isEmpty || !attachments.items.isEmpty || pendingBaseBranch != nil || mission != nil || trackedItem != nil
            || pendingOperationId != nil || busy
    }

    var canChooseExecutionHost: Bool { !busy && mission == nil && trackedItem == nil }

    func resetChatContext() {
        mission = nil
        trackedItem = nil
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
        let destinationReady = mission.map { project?.id == $0.projectId }
            ?? trackedItem.map { project?.id == $0.projectId }
            ?? (project != nil || !folder.isEmpty)
        return !busy && checkoutValidation == nil && destinationReady && sourceReady
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

    func spawnRequest(in project: Project?, branches: BranchSelectorState? = nil, rawAttachments: Bool = false) -> SpawnRequest {
        let branches = branches ?? self.branches
        let scope = BranchSelectorState.scope(project: project, mode: mode, workspace: workspace)
        let model = model.trimmingCharacters(in: .whitespaces)
        return SpawnRequest(
            projectId: mission?.projectId ?? project?.id,
            cwd: mission == nil && project == nil ? folder : nil,
            message: rawAttachments ? message : attachments.message(text: message),
            model: model.isEmpty ? nil : model,
            baseBranch: branches.selection(for: scope),
            mode: mode,
            workspace: mode == .build && project != nil ? workspace : nil,
            missionId: mission?.id
        )
    }

    /// A scheduled chat carries its ticket so pilotd can bind the chat when it starts.
    func scheduleTarget(_ request: SpawnRequest) -> ScheduleTarget {
        .chat(request, trackedItemId: trackedItem?.itemId)
    }
}

enum ComposerTab: Hashable {
    case newTask
    case running
}

/// The live recovery row shared by Home and the isolated native-control regression fixture.
struct HostedChatStartNotice: View {
    @EnvironmentObject private var app: AppModel
    let operation: DurableOperation
    @ObservedObject var hosts: HostClients
    @ObservedObject var form: NewSessionForm
    let retryOriginal: () -> Void

    private var delivery: OperationDelivery? { hosts.operationDeliveries[operation.operationId] }

    var body: some View {
        HStack {
            Text(form.checkingStart ? "Checking chat start…" : form.startRecoveryMessage ?? "Chat start needs confirmation. Your draft has been kept.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if case let .receipt(receipt)? = delivery, receipt.state == .accepted {
                Button("Open chat") { Task { await app.checkHostedChat(operation, form: form, openConfirmed: true) } }
                    .background(ControlGeometry(id: "chat-start-check"))
                    .disabled(form.checkingStart)
            } else {
                Button(form.checkingStart ? "Checking…" : "Check") { Task { await app.checkHostedChat(operation, form: form) } }
                    .background(ControlGeometry(id: "chat-start-check"))
                    .disabled(form.checkingStart)
                if case .unknown? = delivery {
                    Button("Retry original start…", action: retryOriginal)
                        .disabled(form.checkingStart)
                }
            }
        }
        .disabled(form.busy)
        .padding(8)
    }
}

/// Shared by the real recovery row and its isolated native-button regression fixture.
struct IndependentLocalChatButton: View {
    @EnvironmentObject private var app: AppModel
    @ObservedObject var form: NewSessionForm

    var body: some View {
        Button("New Local chat") { app.newLocalChatWhileRemoteStartPending() }
            .background(ControlGeometry(id: "independent-local-chat"))
            .disabled(form.busy)
            .help("Keep the devbox request and its draft, and open an independent Local draft.")
    }
}

/// Home: a sky band, the task composer, and how every project is doing (`HomeOverview`).
struct HomeView: View {
    @EnvironmentObject private var app: AppModel
    @EndpointClient private var client

    var body: some View {
        ScrollView {
            ZStack(alignment: .top) {
                // Daytime clouds / evening sea; DitherScene falls back to the procedural sky without them.
                DitherScene(source: .homeSky, cell: 2.5, fade: 0.45)
                    .frame(height: 440)
                VStack(spacing: 0) {
                    // No heading: the composer sits where it did below the old 24 pt title (290 + ~29 + 16).
                    TaskComposer(form: app.newSessionForm, client: app.client, hosts: app.hosts)
                        .frame(maxWidth: 640)
                        .padding(.top, 335)
                    HomeOverview()
                        .frame(maxWidth: Theme.column)
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
    @EndpointClient private var localClient
    @ObservedObject private var hosts: HostClients
    @State private var choosingRepository = false
    @State private var retryingCreate: DurableOperation?
    @Environment(\.pilotFonts) private var fonts
    @AppStorage("lastProjectId") private var lastProjectId = ""
    @StateObject private var form: NewSessionForm
    @StateObject private var branches: BranchSelectorState
    @FocusState private var focused: Bool
    @Environment(\.keyboardFocus) private var keyboard
    /// Bumped by ⌘L and region focus to move the caret into the message editor.
    @State private var editorFocus: UUID?
    /// Bumped by ⌘K's "Send later: At a time…".
    @State private var scheduleAtTime = 0

    @MainActor init(branches: BranchSelectorState? = nil, form: NewSessionForm? = nil, client: PilotClient? = nil,
                    hosts: HostClients? = nil) {
        let form = form ?? NewSessionForm()
        _form = StateObject(wrappedValue: form)
        _branches = StateObject(wrappedValue: branches ?? form.branches)
        _localClient = EndpointClient(client)
        _hosts = ObservedObject(wrappedValue: hosts ?? AppModel.shared.hosts)
    }

    private var destinationHost: HostRef? { form.executionHost ?? app.localHost }
    private var pendingCreate: DurableOperation? {
        app.pendingChatCreate(on: destinationHost, operationId: form.pendingOperationId)
    }
    private var remote: Bool { destinationHost != nil && destinationHost != app.localHost }
    private var client: PilotClient { destinationHost.map { hosts.presentationClient($0) } ?? localClient }

    private var project: Project? {
        if let mission = form.mission { return client.project(mission.projectId) }
        if app.draftProjectId == "" { return nil } // An unresolved/cancelled checkout choice is not a default project.
        return client.project(app.draftProjectId) ?? (form.folder.isEmpty && !remote ? client.project(lastProjectId) ?? client.projects.first : nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                Menu {
                    if let local = app.localHost { Button("Local") { chooseHost(local) } }
                    ForEach(hosts.offlineHosts.keys.sorted { $0.hostId < $1.hostId }, id: \.self) { host in
                        Button(HostViewContext(host: host, hosts: hosts).name) { chooseHost(host) }
                            .onAppear { PilotTelemetry.shared.recordFeature(.exposure(.devboxChat)) }
                    }
                } label: {
                    ChipLabel(title: destinationHost.map { HostViewContext(host: $0, hosts: hosts).name } ?? "Local", icon: PilotIcon.terminal)
                }.chipMenuStyle().disabled(!form.canChooseExecutionHost)
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
                RunningList(sessions: client.activeSessions.filter(\.isWorking), host: destinationHost)
                    .frame(minHeight: 120, alignment: .top)
            }
        }
        // Opaque, so the sky's dissolving dots never show through.
        .background(RoundedRectangle(cornerRadius: Theme.Radius.tray).fill(Theme.tray))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.tray).strokeBorder(Theme.border))
        .task(id: modelScopeKey) { await loadModels() }
        .task(id: branchLoadKey) { await loadBranches() }
        .task(id: devboxFeatureEligibilityKey) { recordDevboxFeatureEligibility() }
        .onAppear { consumeDraft() }
        .keyboardRegion(.composer) {
            // A new editor focuses itself on appear; an existing one takes the token.
            if form.tab != .newTask { form.tab = .newTask }
            editorFocus = UUID()
            return true
        }
        .composerCommands(revision: commandsRevision) { taskCommandList() }
        .confirmationDialog("Retry the original chat start?", isPresented: Binding(get: { retryingCreate != nil }, set: { if !$0 { retryingCreate = nil } }), presenting: retryingCreate) { operation in
            Button("Retry original start") { Task { await app.checkHostedChat(operation, form: form, retryOriginal: true) } }
        } message: { _ in Text("Only the original saved request is retried on its original devbox. Your newer draft is not sent.") }
        .sheet(isPresented: $choosingRepository) {
            if let host = destinationHost {
                let revision = form.revision
                let projectId = app.draftProjectId
                let folder = form.folder
                RepositoryChooser(host: host, hosts: hosts) { selected in
                    guard form.revision == revision, destinationHost == selected.ref.host,
                          app.draftProjectId == projectId, form.folder == folder,
                          form.pendingOperationId == nil, !form.busy else { return }
                    app.draftProjectId = selected.value.id
                    form.folder = ""
                    choosingRepository = false
                }
            }
        }
        .sheet(item: $form.checkoutChoice) { choice in
            ProjectCheckoutChooser(source: choice.source, initialHost: choice.host, hosts: hosts) { target in
                app.applyCheckoutChoice(choice, target: target)
            }
        }
        .onChange(of: app.draftRevision) { _, _ in consumeDraft() }
        .onChange(of: app.draftMessage) { _, message in if message != nil { consumeDraft() } }
        .task(id: pendingCreateDelivery) {
            // Reconnect may recover a receipt without another click. Adopt only a conclusive
            // result here, never replay or continuously poll an unresolved operation.
            if let operation = pendingCreate, case let .receipt(receipt)? = pendingCreateDelivery, receipt.state != .pending {
                await app.checkHostedChat(operation, form: form)
            }
        }
    }

    private var pendingCreateDelivery: OperationDelivery? {
        pendingCreate.flatMap { hosts.operationDeliveries[$0.operationId] }
    }

    private var newTask: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let operation = pendingCreate {
                HostedChatStartNotice(operation: operation, hosts: hosts, form: form) { retryingCreate = operation }
                if operation.destination != app.localHost, app.localHost != nil {
                    IndependentLocalChatButton(form: form).padding(.horizontal, 12).padding(.bottom, 8)
                }
            }
            if let error = form.error {
                InlineProblem(error).padding(.horizontal, 12).padding(.bottom, 8)
            }
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
                                   maxWindowFraction: 0.5,
                                   isEditable: !form.busy, focusToken: editorFocus,
                                   onCancel: { [keyboard] in KeyboardFocus.leaveComposer(keyboard) },
                                   onPasteImages: { form.attachments.paste(from: $0) },
                                   completionDirectory: form.mode == .ask || remote ? nil : project?.path ?? (form.folder.isEmpty ? FileManager.default.homeDirectoryForCurrentUser.path : form.folder),
                                   slashCommands: SlashCommands.newChatAppCommands,
                                   onAppCommand: { _ = runAppCommand($0, arguments: "") }) { _ in
                        start()
                    }
                    .frame(height: form.editorHeight)
                }
            }
                .padding(12)
                .card()
                .padding(.horizontal, 4)
            HStack(spacing: 6) {
                if let mission = form.mission {
                    Label(mission.title, icon: PilotIcon.mission)
                        .font(.system(size: 12)).lineLimit(1)
                        .foregroundStyle(Theme.mutedForeground)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.muted))
                        .help("This new chat will join the mission, with no task attached.")
                }
                if let tracked = form.trackedItem {
                    HStack(spacing: 4) {
                        Label(tracked.label, icon: PilotIcon.link).lineLimit(1)
                        Button { form.trackedItem = nil } label: { PilotSymbol(PilotIcon.dismiss, context: .toolbar) }
                            .buttonStyle(.plain)
                            .disabled(form.busy)
                            .help("Don't link this chat to \(tracked.label)")
                            .accessibilityLabel("Unlink \(tracked.label)")
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.mutedForeground)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.muted))
                    .help("This chat will be linked to \(tracked.label) when it starts. Pilot never changes the ticket.")
                }
                ProjectMenu(selected: project, folder: form.folder, projects: client.projects) { choice in
                    switch choice {
                    case let .project(id):
                        form.pendingBaseBranch = nil
                        app.draftProjectId = id
                        form.folder = ""
                    case .home:
                        if remote { choosingRepository = true; return }
                        app.chooseChatFolder(FileManager.default.homeDirectoryForCurrentUser.path)
                        lastProjectId = ""
                    case .folder:
                        if remote { choosingRepository = true; return }
                        if let path = chooseFolder(startingAt: form.folder) {
                            app.chooseChatFolder(path)
                            lastProjectId = ""
                        }
                    case .addProject:
                        if remote { choosingRepository = true } else { app.addProject() }
                    }
                }
                .disabled(form.busy || pendingCreate != nil || form.mission != nil || form.trackedItem != nil)
                .help(form.mission != nil ? "The project is locked to this mission."
                    : form.trackedItem != nil ? "The project is locked to the linked ticket." : "Choose a project")
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
                        ChipLabel(title: form.effectiveWorkspace(for: project) == .clone ? "Isolated workspace" : "Checkout", icon: PilotIcon.isolatedWorkspace)
                    }
                    .chipMenuStyle().fixedSize()
                    .disabled(form.busy)
                    .help("Build workspace for this chat only. Defaults to the project's settings.")
                }
                Spacer()
                if form.busy { ProgressView().controlSize(.small) }
                if !remote { SendLaterMenu(disabled: !canStart, schedule: scheduleNewChat, atTimeRequest: scheduleAtTime) }
                Button(action: start) { PilotSymbol(PilotIcon.send, context: .toolbar) }
                    .buttonStyle(CircleIconButtonStyle())
                    .disabled(!canStart)
                    .help("Start chat (↩)")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
        }
    }

    private var devboxFeatureEligibilityKey: String {
        let configured = hosts.offlineHosts.keys.map(\.hostId).sorted().joined(separator: ",")
        let available = hosts.available.map(\.hostId).sorted().joined(separator: ",")
        return "\(configured):\(available)"
    }

    private func recordDevboxFeatureEligibility() {
        let devboxes = hosts.offlineHosts.keys
        let availability: FeatureAvailability
        if devboxes.isEmpty { availability = .notConfigured }
        else if devboxes.contains(where: { hosts.available.contains($0) }) { availability = .available }
        else { availability = .disconnected }
        PilotTelemetry.shared.recordFeature(.eligibility(.devboxChat, availability))
    }

    private var canStart: Bool {
        form.checkoutChoice == nil && !choosingRepository && pendingCreate == nil && form.pendingOperationId == nil && !form.checkingStart && form.canStart(in: project, branches: branches)
            && (!remote || (project != nil && destinationHost.map { hosts.available.contains($0) } == true))
    }

    /// `/model`, `/mode` and `/help` before a chat exists: they open the palette's choices or the shortcut
    /// reference, never start the chat. Returns false, keeping the draft, when one cannot run.
    private func runAppCommand(_ command: SlashCommand, arguments: String) -> Bool {
        form.error = nil
        if command != SlashCommands.model, !arguments.isEmpty {
            form.error = "Use \(command.invocation) without arguments."
            return false
        }
        switch command {
        case SlashCommands.model: app.showCommandPalette(query: arguments.isEmpty ? "Model: " : "Model: \(arguments)")
        case SlashCommands.mode: app.showCommandPalette(query: "Mode: ")
        case SlashCommands.help:
            guard let open = app.openKeyboardShortcutsAction else { return false }
            open()
        default:
            form.error = "\(command.invocation) needs an open chat."
            return false
        }
        return true
    }

    /// A whole message that is only an app command runs it instead of starting a chat.
    private func interceptAppCommand() -> Bool {
        guard let invocation = SlashCommands.appInvocation(form.message, in: SlashCommands.newChatAppCommands) else {
            return false
        }
        if runAppCommand(invocation.command, arguments: invocation.arguments) { form.message = "" }
        return true
    }

    private var commandsRevision: String {
        [project?.id ?? form.folder, form.mode.rawValue, form.model, branchScopeKey ?? "", "\(form.busy)",
         "\(form.models.models.count)", "\(branches.list.branches.count)", "\(form.mission != nil)",
         "\(form.trackedItem != nil)", "\(pendingCreate != nil)", destinationHost?.hostId ?? ""].joined(separator: "|")
    }

    /// The new-chat controls for ⌘K: the same choices as the chips, locked in the same cases. None starts the chat.
    private func taskCommandList() -> [ComposerCommand] {
        guard !form.busy else { return [] }
        var commands: [ComposerCommand] = []
        for mode in [ChatMode.build, .ask] {
            commands.append(ComposerCommand(id: "mode:\(mode.rawValue)", title: mode == .build ? "Mode: Build" : "Mode: Ask",
                                            keywords: ["mode", "build", "ask", "read-only"],
                                            icon: mode == .build ? .buildMode : .askMode, current: form.mode == mode) {
                form.chooseMode(mode)
            })
        }
        let locked = pendingCreate != nil || form.mission != nil || form.trackedItem != nil
        if !locked {
            for candidate in client.projects {
                commands.append(ComposerCommand(id: "project:\(candidate.id)", title: "Project: \(candidate.name)",
                                                keywords: ["project", "repository"], icon: .project,
                                                current: candidate.id == project?.id) {
                    form.pendingBaseBranch = nil
                    app.draftProjectId = candidate.id
                    form.folder = ""
                })
            }
            if !remote {
                commands.append(ComposerCommand(id: "folder", title: "Choose folder…", keywords: ["folder", "directory"],
                                                icon: .chatFolder) {
                    if let path = chooseFolder(startingAt: form.folder) {
                        app.chooseChatFolder(path)
                        lastProjectId = ""
                    }
                })
            }
        }
        if let scope = branchScopeKey, branches.scope == scope {
            let selected = branches.selection(for: scope)
            commands.append(ComposerCommand(id: "branch:default", title: "Base branch: Default",
                                            keywords: ["branch", "base"], icon: .branch, current: selected == nil) {
                branches.select(nil, for: scope)
                form.chooseBaseBranch(nil)
            })
            for branch in branches.list.branches {
                commands.append(ComposerCommand(id: "branch:\(branch)", title: "Base branch: \(branch)",
                                                keywords: ["branch", "base"], icon: .branch, current: selected == branch) {
                    branches.select(branch, for: scope)
                    form.chooseBaseBranch(branch)
                })
            }
        }
        commands.append(ComposerCommand(id: "model:default", title: "Model: Project default", keywords: ["model"],
                                        icon: .model, current: form.model.isEmpty) { form.model = "" })
        commands += ComposerCommandText.modelCommands(form.models.models, current: form.model) { form.model = $0 }
        if form.mode == .build, project != nil {
            let choices: [(String, WorkspaceMode?)] = [("Project default", nil), ("Isolated workspace", .clone),
                                                       ("Current checkout", .direct)]
            for (title, workspace) in choices {
                commands.append(ComposerCommand(id: "workspace:\(title)", title: "Workspace: \(title)",
                                                keywords: ["workspace", "clone", "checkout"], icon: .isolatedWorkspace,
                                                current: form.workspace == workspace) { form.workspace = workspace })
            }
        }
        if !remote {
            commands += ComposerCommandText.sendLater { scheduleNewChat($0) }
            commands.append(ComposerCommandText.sendLaterAtTime { scheduleAtTime += 1 })
        }
        commands.append(ComposerCommandText.pasteImage { _ = form.attachments.paste(from: .general) })
        return commands
    }

    /// Reloads the pi model scope when the project or folder changes.
    private var modelScopeKey: String { "\(destinationHost.map { HostResourceRef(host: $0, kind: .project, localId: project?.id ?? "").storageKey } ?? "local"):\(project?.id ?? form.folder)" }

    private var branchScopeKey: String? {
        BranchSelectorState.scope(project: project, mode: form.mode, workspace: form.workspace)
    }

    private func chooseHost(_ host: HostRef) {
        let intentionalFolder = !form.folder.isEmpty
        if app.chooseNewChatHost(host, sourceProject: project), intentionalFolder { choosingRepository = true }
    }

    private func consumeDraft() {
        form.consumeDraft(from: app, branches: branches)
        Task { await loadBranches() }
    }

    private var branchLoadKey: String { "\(modelScopeKey):\(client.hasProjectSnapshot):\(branchScopeKey ?? form.folder)" }

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
        let projectId = project?.id
        let cwd = project == nil ? form.folder : nil
        // Show the last known list at once, then revalidate. Equal results never re-render the form.
        let cached = client.cachedModels(projectId: projectId, cwd: cwd)
        if let cached, form.models != cached { form.models = cached }
        let key = modelScopeKey
        let fresh = try? await client.models(projectId: projectId, cwd: cwd)
        guard !Task.isCancelled, key == modelScopeKey else { return }
        // A failed refresh keeps the cached list; with nothing cached the scope has no known models.
        let next = fresh ?? cached ?? ModelList(models: [])
        if form.models != next { form.models = next }
    }

    private func start() {
        if interceptAppCommand() { return }
        guard canStart else { return }
        form.busy = true
        form.error = nil
        let revision = form.revision
        do { try form.attachments.retainForHistory() }
        catch {
            form.error = "Could not retain attached images: \(error.localizedDescription)"
            form.busy = false
            return
        }
        if remote, let host = destinationHost, let project {
            PilotTelemetry.shared.recordFeature(.attempt(.devboxChat))
            Task {
                defer { form.busy = false }
                do {
                    try await app.createHostedChat(form: form, host: host, project: project, revision: revision)
                    if let event = FeatureEvent.outcome(.devboxChat, .success, reason: .none) {
                        PilotTelemetry.shared.recordFeature(event)
                    }
                } catch {
                    let event = hosts.available.contains(host)
                        ? FeatureEvent.outcome(.devboxChat, .failure, reason: .unknown)
                        : FeatureEvent.outcome(.devboxChat, .unavailable, reason: .disconnected)
                    if let event { PilotTelemetry.shared.recordFeature(event) }
                    if form.revision == revision { form.error = error.localizedDescription }
                }
            }
            return
        }
        let request = form.spawnRequest(in: project, branches: branches)
        let tracked = form.trackedItem
        Task {
            defer { form.busy = false }
            do {
                _ = try await app.createLocalChat(request, form: form, revision: revision, tracked: tracked)
                if let id = request.projectId { lastProjectId = id }
            } catch {
                if form.revision == revision { form.error = error.localizedDescription }
            }
        }
    }

    /// Send later: the same request as Start, kept by pilotd until its trigger fires.
    private func scheduleNewChat(_ when: ScheduleWhen) {
        if interceptAppCommand() { return }
        guard canStart else { return }
        form.busy = true
        form.error = nil
        let revision = form.revision
        do { try form.attachments.retainForHistory() }
        catch {
            form.error = "Could not retain attached images: \(error.localizedDescription)"
            form.busy = false
            return
        }
        let request = form.spawnRequest(in: project, branches: branches)
        // Capture the ticket now: the form may be reset or edited before the request returns.
        let target = form.scheduleTarget(request)
        let title = ScheduleText.title(form.message, fallback: "New chat")
        Task {
            defer { form.busy = false }
            do {
                _ = try await client.createSchedule(ScheduleRequest(
                    title: title, trigger: when.trigger, at: when.at, target: target
                ))
                if let id = request.projectId { lastProjectId = id }
                _ = form.completeSubmission(revision: revision)
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
    var host: HostRef?
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
                Button { app.navigate(.session, id: session.id, context: host.map { HostViewContext(host: $0, hosts: app.hosts) }) } label: {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.mini)
                        Text(session.title).lineLimit(1)
                        Spacer()
                        Text((host.map { app.hosts.presentationClient($0) } ?? app.client).project(session.projectId)?.name ?? URL(filePath: session.cwd).lastPathComponent)
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
        .card()
        .padding(.horizontal, 4)
        .padding(.bottom, 4)
    }
}

enum ProjectChoice {
    case project(String)
    case home
    case folder
    case addProject
}

struct ProjectMenu: View {
    let selected: Project?
    let folder: String
    let projects: [Project]
    let choose: (ProjectChoice) -> Void

    var isHome: Bool {
        selected == nil && folder == FileManager.default.homeDirectoryForCurrentUser.path
    }

    var title: String {
        selected?.name ?? (isHome ? "Home" : folder.isEmpty ? "Choose project" : URL(filePath: folder).lastPathComponent)
    }

    var body: some View {
        Menu {
            ForEach(projects) { project in
                Button {
                    choose(.project(project.id))
                } label: {
                    if project.id == selected?.id { Label(project.name, icon: PilotIcon.selectedOption) } else { Text(project.name) }
                }
            }
            if !projects.isEmpty { Divider() }
            Button { choose(.home) } label: {
                if isHome { Label("Home (~)", icon: PilotIcon.selectedOption) } else { Text("Home (~)") }
            }
            Button("Other Folder…") { choose(.folder) }
            Button("Add Project…") { choose(.addProject) }
        } label: {
            ChipLabel(
                title: title,
                icon: isHome ? PilotIcon.home : PilotIcon.project
            )
        }
        .chipMenuStyle()
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
                if model.isEmpty { Label("Default (\(name))", icon: PilotIcon.selectedOption) } else { Text("Default (\(name))") }
            }
            ForEach(groups, id: \.provider) { group in
                Section(group.provider) {
                    ForEach(group.models) { option in
                        Button {
                            model = option.id
                        } label: {
                            if model == option.id { Label(option.name, icon: PilotIcon.selectedOption) } else { Text(option.name) }
                        }
                    }
                }
            }
        } label: {
            ChipLabel(title: displayName(model.isEmpty ? fallback ?? "Default model" : model), icon: PilotIcon.model, maxTitleWidth: 200)
        }
        .chipMenuStyle()
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

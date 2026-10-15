import PilotCore
import SwiftUI

/// Start chat choices. Empty values are omitted, so pilotd applies the task's preference and project defaults.
struct MissionTaskStartForm {
    var message = ""
    var model = ""
    var thinking = ""
    var mode: ChatMode = .build
    var artifacts: [MissionArtifactLink] = []
    var links: [MissionLinkReference] = []

    func request(baseBranch: String?) -> StartMissionTaskRequest {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return StartMissionTaskRequest(
            message: text.isEmpty ? nil : text,
            model: model.isEmpty ? nil : model,
            thinking: thinking.isEmpty ? nil : thinking,
            mode: mode == .build ? nil : mode,
            baseBranch: baseBranch,
            artifacts: artifacts.isEmpty ? nil : artifacts.map { MissionArtifactReference(artifactId: $0.artifactId, revision: $0.revision) },
            links: links.isEmpty ? nil : links)
    }

    /// Each reference once; a URL added twice keeps the first title.
    mutating func add(_ link: MissionLinkReference) {
        if !links.contains(where: { $0.url == link.url }) { links.append(link) }
    }

    mutating func add(_ artifact: MissionArtifactLink) {
        if !artifacts.contains(where: { $0.artifactId == artifact.artifactId }) { artifacts.append(artifact) }
    }
}

/// Start chat options for one task. Everything is optional, so ⌘↩ starts at once with the task's preferred model
/// (else the project's), Build mode, the remote default branch and the task's saved references.
/// pilotd validates the request exactly like the coordinator's start.
struct MissionTaskStartSheet: View {
    let task: MissionTask
    let mission: Mission
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @Environment(\.dismiss) private var dismiss
    @StateObject private var branches = BranchSelectorState()
    @State private var form = MissionTaskStartForm()
    @State private var options = TaskModelOptions()
    @State private var addingLink = false
    @State private var starting = false
    @State private var error: String?

    private var project: Project? { client.project(mission.projectId) }
    private var branchScope: String? { BranchSelectorState.scope(project: project, mode: form.mode, workspace: nil) }

    var body: some View {
        SheetScaffold("Start chat", subtitle: "#\(task.number) \(task.title)", error: error,
                      primary: SheetPrimaryAction(title: starting ? "Starting…" : "Start Chat", key: .commandReturn,
                                                  enabled: canStart, action: start),
                      width: 560) {
            if let gating = gatingNote {
                Label(gating, icon: PilotIcon.privateChannel)
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ComposerTray {
                MissionTextArea(prompt: "Optional instructions, added after the task description…", text: $form.message,
                                minLines: 3, maxLines: 8, label: "Opening message") { if canStart { start() } }
            } controls: {
                TaskModelFields(projectId: mission.projectId, model: $form.model, thinking: $form.thinking, options: $options,
                                defaultModel: task.preferredModel, defaultThinking: task.preferredThinking) {
                    modeMenu
                    if let scope = branchScope {
                        BranchMenu(state: branches, scope: scope, mode: form.mode) { Task { await loadBranches() } }
                    }
                }
            }
            .disabled(starting)
            references
                .disabled(starting)
        }
        .task(id: branchScope) { await loadBranches() }
    }

    private var canStart: Bool {
        !starting && !options.loading && mission.status == .active && task.sessionId == nil && task.status.canStart
    }

    /// Phase gating holds the task: starting it is the user's explicit override.
    private var gatingNote: String? {
        guard task.isPhaseGated else { return nil }
        let phases = client.missionDetails[mission.id].map { MissionPhaseIndex($0).gatingPhases(of: task) } ?? []
        let reason = MissionPhaseGating.text(phases) ?? "Waits for earlier phases"
        return "\(reason). Starting it now overrides phase gating."
    }

    private var modeMenu: some View {
        Menu {
            ForEach([ChatMode.build, .ask], id: \.self) { choice in
                Button { form.mode = choice } label: {
                    if form.mode == choice { Label(Self.title(choice), icon: PilotIcon.selectedOption) } else { Text(Self.title(choice)) }
                }
            }
        } label: {
            ChipLabel(title: Self.title(form.mode), icon: form.mode == .ask ? PilotIcon.askMode : PilotIcon.buildMode)
        }
        .chipMenuStyle()
        .fixedSize()
        .help("Build can make changes. Ask is read-only and creates no isolated workspace.")
        .accessibilityLabel("Chat mode: \(Self.title(form.mode))")
    }

    private static func title(_ mode: ChatMode) -> String { mode == .ask ? "Ask" : "Build" }

    // MARK: References

    /// Mission artifacts not already on this task or chosen here.
    private var availableArtifacts: [MissionArtifactLink] {
        guard let detail = client.missionDetails[mission.id] else { return [] }
        var seen = Set(detail.artifacts.filter { $0.taskId == task.id }.map(\.artifactId))
        seen.formUnion(form.artifacts.map(\.artifactId))
        return detail.artifacts.filter { seen.insert($0.artifactId).inserted }
    }

    private var references: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                Text("References").font(.pilot(.caption, weight: .semibold)).foregroundStyle(Theme.mutedForeground)
                Spacer()
                let available = availableArtifacts
                if !available.isEmpty {
                    Menu {
                        ForEach(available, id: \.artifactId) { item in
                            Button(item.title) { form.add(item) }
                        }
                    } label: {
                        Label("Add Artifact", icon: PilotIcon.add)
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .font(.pilot(.label))
                    .foregroundStyle(Theme.mutedForeground)
                    .help("Reference an artifact already linked to this mission")
                }
                QuietAddButton(title: "Add Link") { addingLink = true }
                    .popover(isPresented: $addingLink, arrowEdge: .bottom) {
                        StartLinkForm { link in
                            form.add(link)
                            addingLink = false
                        } cancel: { addingLink = false }
                    }
            }
            if form.artifacts.isEmpty && form.links.isEmpty {
                Text("Saved on the task when the chat starts, so later chats see them too.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
            } else {
                ResponsiveControlsLayout(horizontalSpacing: 8, verticalSpacing: 4) {
                    ForEach(form.artifacts, id: \.artifactId) { item in
                        referenceChip(item.title, icon: item.kind == "image" ? PilotIcon.image : PilotIcon.artifact) {
                            form.artifacts.removeAll { $0.artifactId == item.artifactId }
                        }
                    }
                    ForEach(form.links, id: \.url) { item in
                        referenceChip(item.title ?? item.url, icon: PilotIcon.link) {
                            form.links.removeAll { $0.url == item.url }
                        }
                    }
                }
            }
        }
    }

    private func referenceChip(_ title: String, icon: PilotIcon, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 4) {
            Label(title, icon: icon).lineLimit(1).truncationMode(.middle)
            Button(action: remove) { PilotSymbol(PilotIcon.dismiss, context: .toolbar) }
                .buttonStyle(.plain)
                .help("Remove \(title)")
                .accessibilityLabel("Remove \(title)")
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
        .padding(.horizontal, 8).padding(.vertical, 3)
        .frame(maxWidth: 240, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.muted))
    }

    // MARK: Actions

    private func loadBranches() async {
        let scope = branchScope
        let mode = form.mode
        let projectId = mission.projectId
        await branches.load(scope: scope, mode: mode) {
            try await client.remoteBranches(projectId, mode: mode)
        }
    }

    private func start() {
        guard canStart else { return }
        starting = true
        error = nil
        var request = form.request(baseBranch: branchScope.flatMap { branches.selection(for: $0) })
        if task.isPhaseGated { request.overridePhaseGating = true }
        Task {
            defer { starting = false }
            do {
                let session = try await client.startMissionTask(mission.id, taskId: task.id, request)
                dismiss()
                model.selectedSessionId = session.id
            } catch { self.error = error.localizedDescription }
        }
    }
}

/// A URL with an optional title, added to the start request rather than saved at once.
private struct StartLinkForm: View {
    let add: (MissionLinkReference) -> Void
    let cancel: () -> Void
    @State private var url = ""
    @State private var title = ""

    private var trimmedURL: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool { URL(string: trimmedURL)?.scheme != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Add a reference link").font(.pilot(.body, weight: .semibold))
            TextField("Linear, GitHub, Slack or any URL", text: $url)
                .textFieldStyle(.roundedBorder).onSubmit(submit)
            TextField("Title (optional)", text: $title)
                .textFieldStyle(.roundedBorder).onSubmit(submit)
            HStack {
                Spacer()
                Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
                Button("Add", action: submit).keyboardShortcut(.defaultAction).disabled(!valid)
            }
        }
        .padding(14)
        .frame(width: 340)
    }

    private func submit() {
        guard valid else { return }
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        add(MissionLinkReference(url: trimmedURL, title: name.isEmpty ? nil : name))
    }
}

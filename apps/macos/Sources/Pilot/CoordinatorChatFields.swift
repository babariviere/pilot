import PilotCore
import SwiftUI

struct CoordinatorChatForm {
    var model = ""
    var thinking = ""
    var message = ""
    var models = ModelList(models: [])
    var loading = true
    var error: String?
    var loadedProjectId: String?

    var selectedModel: String? { model.isEmpty ? nil : model }
    var selectedThinking: String? { thinking.isEmpty ? nil : thinking }
    var canStart: Bool { !loading && error == nil && !models.models.isEmpty }
    var request: StartMissionCoordinatorRequest {
        StartMissionCoordinatorRequest(model: selectedModel, thinking: selectedThinking, message: message)
    }
}

/// Shared new-coordinator controls: what to plan, in a composer tray, with model and thinking chips.
/// Fetch only on project changes, never on typing.
/// ModelMenu keeps the same scope presentation as New chat; the daemon also applies the task-start cap.
struct CoordinatorChatFields: View {
    let projectId: String?
    @Binding var form: CoordinatorChatForm
    /// Command-Return in the message field.
    var onSubmit: () -> Void = {}
    @EndpointClient private var client

    private var option: ModelOption? {
        let id = form.selectedModel ?? projectId.flatMap { client.project($0)?.model } ?? form.models.defaultModel
        return id.flatMap { id in form.models.models.first { $0.id == id } } ?? form.models.models.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ComposerTray {
                MissionTextArea(prompt: "Tell it what to plan: links, constraints, what done looks like…", text: $form.message,
                                minLines: 4, maxLines: 8, label: "What should it do?", onSubmit: onSubmit)
            } controls: {
                ModelMenu(model: $form.model, projectDefault: projectId.flatMap { client.project($0)?.model }, list: form.models)
                    .disabled(form.loading)
                ThinkingMenu(thinking: $form.thinking, levels: option?.thinkingLevels ?? ["off"],
                             help: "Thinking level for the coordinator")
                    .disabled(form.loading)
                if form.loading {
                    ProgressView().controlSize(.mini)
                    Text("Loading models…").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                Spacer()
            }
            if let error = form.error {
                InlineProblem(error) { Task { await load() } }
            }
            if !form.loading && form.error == nil && form.models.models.isEmpty {
                Text("No models available in this project's scope and price cap.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }
        .task(id: projectId) {
            if form.loadedProjectId != projectId {
                form.loadedProjectId = projectId
                form.model = ""
                form.thinking = ""
                form.models = ModelList(models: [])
            }
            await load()
        }
        .onChange(of: form.model) { _, _ in form.thinking = "" }
    }

    private func load() async {
        form.loading = true
        form.error = nil
        guard let projectId else { return }
        do {
            let list = try await client.models(projectId: projectId, cwd: nil, taskStart: true)
            guard !Task.isCancelled else { return }
            form.models = list
        } catch {
            guard !Task.isCancelled else { return }
            form.error = error.localizedDescription
        }
        form.loading = false
    }
}

struct StartCoordinatorSheet: View {
    let missionId: String
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client
    @Environment(\.dismiss) private var dismiss
    @State private var form = CoordinatorChatForm()
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        SheetScaffold("Start a coordinator", subtitle: client.mission(missionId)?.title ?? "Mission", error: error,
                      primary: SheetPrimaryAction(title: saving ? "Starting…" : "Start Coordinator", key: .commandReturn,
                                                  enabled: canStart, action: start),
                      width: 500) {
            Text("It drafts the brief and tasks for your review, and can start and message mission chats. It does not implement tasks itself.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
            CoordinatorChatFields(projectId: client.mission(missionId)?.projectId, form: $form) { if canStart { start() } }
                .disabled(saving)
        }
    }

    private var canStart: Bool {
        !saving && form.canStart && client.mission(missionId)?.status == .active
            && client.mission(missionId)?.coordinatorSessionId == nil
    }

    private func start() {
        saving = true
        error = nil
        let request = form.request
        Task {
            defer { saving = false }
            do {
                let session = try await client.startMissionCoordinator(missionId, request)
                dismiss()
                model.selectedSessionId = session.id
            } catch { self.error = error.localizedDescription }
        }
    }
}

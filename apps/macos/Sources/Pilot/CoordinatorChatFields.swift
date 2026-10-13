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

/// Shared new-coordinator controls. Fetch only on project changes, never on typing.
/// ModelMenu keeps the same scope presentation as New chat; the daemon also applies the task-start cap.
struct CoordinatorChatFields: View {
    let projectId: String?
    @Binding var form: CoordinatorChatForm
    @ObservedObject private var client = AppModel.shared.client

    private var option: ModelOption? {
        let id = form.selectedModel ?? projectId.flatMap { client.project($0)?.model } ?? form.models.defaultModel
        return id.flatMap { id in form.models.models.first { $0.id == id } } ?? form.models.models.first
    }

    var body: some View {
        HStack {
            ModelMenu(model: $form.model, projectDefault: projectId.flatMap { client.project($0)?.model }, list: form.models)
                .disabled(form.loading)
            Picker("Thinking", selection: $form.thinking) {
                Text("Default").tag("")
                ForEach(option?.thinkingLevels ?? ["off"], id: \.self) { Text($0.capitalized).tag($0) }
            }
            .disabled(form.loading)
        }
        VStack(alignment: .leading, spacing: 6) {
            Text("What should it do? (optional)").font(.callout)
            TextEditor(text: $form.message)
                .font(.body)
                .frame(height: 100)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.border))
                .accessibilityLabel("What should it do?")
            Text("Add context, links or constraints. The chat drafts the brief and tasks for your review.")
                .font(.caption).foregroundStyle(.secondary)
        }
        if form.loading { ProgressView("Loading models…").controlSize(.small) }
        if let error = form.error {
            Text(error).font(.callout).foregroundStyle(Theme.destructive)
            Button("Retry loading models") { Task { await load() } }
        }
        if !form.loading && form.error == nil && form.models.models.isEmpty {
            Text("No models available in this project's scope and price cap.")
                .font(.callout).foregroundStyle(.secondary)
        }
        Color.clear.frame(height: 0)
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
    @ObservedObject private var client = AppModel.shared.client
    @Environment(\.dismiss) private var dismiss
    @State private var form = CoordinatorChatForm()
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Start a coordinator").font(.headline)
            Text(client.mission(missionId)?.title ?? "Mission").font(.callout).foregroundStyle(.secondary)
            Form {
                CoordinatorChatFields(projectId: client.mission(missionId)?.projectId, form: $form)
            }
            .formStyle(.grouped).disabled(saving)
            if let error { Text(error).font(.callout).foregroundStyle(Theme.destructive) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(saving ? "Starting…" : "Start coordinator", action: start)
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving || !form.canStart || client.mission(missionId)?.status != .active
                              || client.mission(missionId)?.coordinatorSessionId != nil)
            }
        }
        .padding(20).frame(width: 480)
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

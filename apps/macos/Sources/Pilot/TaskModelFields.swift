import PilotCore
import SwiftUI

/// The daemon's task-start model list for one project: the pi scope within the task-start price cap.
struct TaskModelOptions {
    var models = ModelList(models: [])
    var loading = true
    var error: String?
    var loadedProjectId: String?

    func option(_ id: String?) -> ModelOption? {
        id.flatMap { id in models.models.first { $0.id == id } } ?? models.models.first
    }
}

/// Thinking level chip. Empty means the default: the model's configured level, or a stated preference.
struct ThinkingMenu: View {
    @Binding var thinking: String
    let levels: [String]
    /// A known default, such as a task's preferred thinking, named in the Default item and the chip.
    var defaultLevel: String?
    var help = "Thinking level"

    var body: some View {
        Menu {
            Button { thinking = "" } label: {
                if thinking.isEmpty { Label(defaultTitle, icon: PilotIcon.selectedOption) } else { Text(defaultTitle) }
            }
            ForEach(levels, id: \.self) { level in
                Button { thinking = level } label: {
                    if thinking == level { Label(Self.label(level), icon: PilotIcon.selectedOption) }
                    else { Text(Self.label(level)) }
                }
            }
        } label: {
            ChipLabel(title: chipTitle, icon: PilotIcon.thinking)
        }
        .chipMenuStyle()
        .fixedSize()
        .help(help)
        .accessibilityLabel(chipTitle)
    }

    private var defaultTitle: String { defaultLevel.map { "Default (\(Self.label($0)))" } ?? "Default" }

    private var chipTitle: String {
        if !thinking.isEmpty { return "Thinking: \(Self.label(thinking))" }
        return defaultLevel.map { "Thinking: \(Self.label($0))" } ?? "Thinking: default"
    }

    static func label(_ level: String) -> String { level == "xhigh" ? "XHigh" : level.capitalized }
}

/// Model and thinking chips for a task chat, loaded from the task-start list once per project, never on typing.
/// Empty values mean the default: `defaultModel` (a task's preferred model) when given, else the project's.
struct TaskModelFields: View {
    let projectId: String
    @Binding var model: String
    @Binding var thinking: String
    @Binding var options: TaskModelOptions
    var defaultModel: String?
    var defaultThinking: String?
    @ObservedObject private var client = AppModel.shared.client

    private var fallback: String? { defaultModel ?? client.project(projectId)?.model ?? options.models.defaultModel }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                ModelMenu(model: $model, projectDefault: fallback, list: options.models)
                    .disabled(options.loading)
                ThinkingMenu(thinking: $thinking, levels: options.option(model.isEmpty ? fallback : model)?.thinkingLevels ?? ["off"],
                             defaultLevel: model.isEmpty ? defaultThinking : nil, help: "Thinking level for this task's chat")
                    .disabled(options.loading)
                if options.loading {
                    ProgressView().controlSize(.mini)
                    Text("Loading models…").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                Spacer(minLength: 0)
            }
            if let error = options.error {
                InlineProblem(error) { Task { await load() } }
            }
            if !options.loading && options.error == nil && options.models.models.isEmpty {
                Text("No models available in this project's scope and price cap.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }
        .task(id: projectId) {
            if options.loadedProjectId != projectId {
                options.loadedProjectId = projectId
                options.models = ModelList(models: [])
            }
            await load()
        }
        .onChange(of: model) { _, _ in thinking = "" }
    }

    private func load() async {
        options.loading = true
        options.error = nil
        do {
            let list = try await client.models(projectId: projectId, cwd: nil, taskStart: true)
            guard !Task.isCancelled else { return }
            options.models = list
        } catch {
            guard !Task.isCancelled else { return }
            options.error = error.localizedDescription
        }
        options.loading = false
    }
}

enum TaskModelLabel {
    /// "Claude Opus 5.5 · High", using scope names when known and the model ID otherwise.
    static func text(model: String, thinking: String?, list: ModelList?) -> String {
        let name = list?.models.first { $0.id == model }?.name ?? (model.split(separator: "/").last.map(String.init) ?? model)
        return thinking.map { "\(name) · \(ThinkingMenu.label($0))" } ?? name
    }

    static func help(_ task: MissionTask) -> String {
        let by = task.preferredModelSetBy == "coordinator" ? "the coordinator" : "you"
        return "Preferred model for new chats on this task, set by \(by)"
    }
}

/// Sets or clears a task's preferred model. The daemon validates it against the same scope and price cap as starts.
struct MissionTaskModelSheet: View {
    let task: MissionTask
    let mission: Mission
    @ObservedObject private var client = AppModel.shared.client
    @Environment(\.dismiss) private var dismiss
    @State private var model: String
    @State private var thinking: String
    @State private var options = TaskModelOptions()
    @State private var saving = false
    @State private var error: String?

    init(task: MissionTask, mission: Mission) {
        self.task = task
        self.mission = mission
        _model = State(initialValue: task.preferredModel ?? "")
        _thinking = State(initialValue: task.preferredThinking ?? "")
    }

    var body: some View {
        SheetScaffold("Preferred model", subtitle: "#\(task.number) \(task.title)", error: error,
                      primary: SheetPrimaryAction(title: saving ? "Saving…" : "Save", enabled: canSave, action: save),
                      width: 460) {
            Text("New chats for this task start on this model unless you pick another. The coordinator keeps your choice.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
            TaskModelFields(projectId: mission.projectId, model: $model, thinking: $thinking, options: $options)
                .disabled(saving)
        }
    }

    private var unchanged: Bool { model == (task.preferredModel ?? "") && thinking == (task.preferredThinking ?? "") }
    private var canSave: Bool { !saving && !options.loading && options.error == nil && !unchanged }

    private func save() {
        saving = true
        error = nil
        let write = model.isEmpty
            ? MissionTaskWrite(preferredModel: .clear)
            : MissionTaskWrite(preferredModel: .set(model), preferredThinking: thinking.isEmpty ? nil : .set(thinking))
        Task {
            defer { saving = false }
            do {
                try await client.updateMissionTask(mission.id, taskId: task.id, write)
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}


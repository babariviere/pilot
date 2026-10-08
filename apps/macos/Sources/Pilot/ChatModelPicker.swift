import PilotCore
import SwiftUI

@MainActor
final class ChatModelPickerState: ObservableObject {
    @Published var models = ModelList(models: []) {
        didSet { rebuildPresentation() }
    }
    @Published var changing = false
    @Published var error: String?

    private let changeModel: (String, ChangeModelRequest) async throws -> Void
    private(set) var providers: [String] = []
    private(set) var modelsByProvider: [String: [ModelOption]] = [:]
    private var namesByID: [String: String] = [:]
    private var levelsByID: [String: [String]] = [:]
    private var fallbackNames: [String: String] = [:]

    private func rebuildPresentation() {
        modelsByProvider = Dictionary(grouping: models.models, by: \.provider)
        providers = modelsByProvider.keys.sorted()
        namesByID = [:]
        levelsByID = [:]
        for model in models.models where namesByID[model.id] == nil {
            namesByID[model.id] = model.name
            levelsByID[model.id] = model.thinkingLevels
        }
        fallbackNames = [:]
    }

    func displayName(for model: String?) -> String {
        guard let model, !model.isEmpty else { return "Model" }
        if let name = namesByID[model] ?? fallbackNames[model] { return name }
        let name = model.split(separator: "/").last.map(String.init) ?? model
        fallbackNames[model] = name
        return name
    }

    init(changeModel: @escaping (String, ChangeModelRequest) async throws -> Void = { id, request in
        try await AppModel.shared.client.changeModel(id, model: request.model, thinking: request.thinking)
    }) {
        self.changeModel = changeModel
    }

    func canChange(session: SessionSummary, working: Bool) -> Bool {
        !working && !session.isWorking && !session.isArchived && session.state != "failed" && !changing
    }

    func thinkingLevels(for session: SessionSummary) -> [String] {
        session.model.flatMap { levelsByID[$0] } ?? []
    }

    @discardableResult
    func selectModel(_ model: String, session: SessionSummary, working: Bool) -> Task<Void, Never>? {
        guard canChange(session: session, working: working), model != session.model,
              models.models.contains(where: { $0.id == model }) else { return nil }
        // A model-only switch uses the new model's scoped default, not the old model's level.
        return change(session: session, request: ChangeModelRequest(model: model))
    }

    @discardableResult
    func selectThinking(_ thinking: String, session: SessionSummary, working: Bool) -> Task<Void, Never>? {
        guard canChange(session: session, working: working), let model = session.model,
              thinking != session.thinking, thinkingLevels(for: session).count >= 2,
              thinkingLevels(for: session).contains(thinking) else { return nil }
        return change(session: session, request: ChangeModelRequest(model: model, thinking: thinking))
    }

    private func change(session: SessionSummary, request: ChangeModelRequest) -> Task<Void, Never> {
        changing = true
        error = nil
        return Task {
            defer { changing = false }
            do {
                try await changeModel(session.id, request)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func loadModels(cwd: String) async {
        do {
            models = try await AppModel.shared.client.models(projectId: nil, cwd: cwd)
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
}

/// Keep both selectors visible even when the composer has no room for a single controls row.
struct ChatModelControls: View {
    let session: SessionSummary
    let working: Bool
    @ObservedObject var state: ChatModelPickerState

    var body: some View {
        ResponsiveControlsLayout(horizontalSpacing: 12, verticalSpacing: 8) {
            ChatModelPicker(session: session, working: working, state: state)
            ChatThinkingPicker(session: session, working: working, state: state)
        }
    }
}

/// Model selection is an idle-only operation, never an interruption of a running turn.
struct ChatModelPicker: View {
    let session: SessionSummary
    let working: Bool
    @ObservedObject var state: ChatModelPickerState

    var body: some View {
        Menu {
            ForEach(state.providers, id: \.self) { provider in
                Section(provider) {
                    ForEach(state.modelsByProvider[provider] ?? []) { option in
                        Button { state.selectModel(option.id, session: session, working: working) } label: {
                            if session.model == option.id {
                                Label(option.name, systemImage: "checkmark")
                            } else {
                                Text(option.name)
                            }
                        }
                    }
                }
            }
            if state.models.models.isEmpty {
                Text("No models loaded")
                Button("Reload models") { Task { await state.loadModels(cwd: session.cwd) } }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "cpu")
                Text(state.displayName(for: session.model))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 200, alignment: .leading)
                if state.changing {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .medium))
                }
            }
            .font(.system(size: 11))
            .foregroundStyle(Theme.mutedForeground)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize(horizontal: true, vertical: false)
        .disabled(!state.canChange(session: session, working: working))
        .help(working || session.isWorking ? "Model can be changed when idle with no queued messages" : "Change the model for this chat")
        .accessibilityLabel("Model: \(state.displayName(for: session.model))")
    }
}

import PilotCore
import SwiftUI

@MainActor
final class ChatModelPickerState: ObservableObject {
    @Published var models = ModelList(models: []) {
        didSet { rebuildPresentation() }
    }
    @Published var changing = false
    @Published var error: String?
    /// The continuation sheet's draft. Set opens the sheet; nil closes it.
    @Published var continuation: ContinuationDraft?
    @Published var continuing = false
    @Published var continuationError: String?

    private let changeModel: (String, ChangeModelRequest) async throws -> Void
    private let continueModel: (String, ContinueModelRequest) async throws -> SessionSummary
    private let showContinuedChat: @MainActor (SessionSummary) -> Void
    private let cachedModels: @MainActor (String) -> ModelList?
    private let fetchModels: (String) async throws -> ModelList
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

    init(
        cwd: String? = nil,
        changeModel: @escaping (String, ChangeModelRequest) async throws -> Void = { id, request in
            try await AppModel.shared.client.changeModel(id, model: request.model, thinking: request.thinking)
        },
        cachedModels: @escaping @MainActor (String) -> ModelList? = { cwd in
            AppModel.shared.client.cachedModels(projectId: nil, cwd: cwd)
        },
        fetchModels: @escaping (String) async throws -> ModelList = { cwd in
            try await AppModel.shared.client.models(projectId: nil, cwd: cwd)
        },
        continueModel: @escaping (String, ContinueModelRequest) async throws -> SessionSummary = { id, request in
            try await AppModel.shared.client.continueModel(id, model: request.model, thinking: request.thinking)
        },
        showContinuedChat: @escaping @MainActor (SessionSummary) -> Void = { AppModel.shared.reveal(session: $0.id) }
    ) {
        self.changeModel = changeModel
        self.continueModel = continueModel
        self.showContinuedChat = showContinuedChat
        self.cachedModels = cachedModels
        self.fetchModels = fetchModels
        // A chat switch creates a new picker. Seed it before the first body evaluation,
        // not in .task, or the chip briefly shows the raw ID and missing thinking choices.
        if let cwd, let cached = cachedModels(cwd) {
            _models = Published(initialValue: cached)
            rebuildPresentation()
        }
    }

    func canChange(session: SessionSummary, working: Bool) -> Bool {
        !working && !session.isWorking && !session.isReadOnlyHistory && session.state != "failed" && !changing
            && !continuing
    }

    /// pilotd accepts a continuation only while an unforced pause holds the chat, even with queued messages held.
    func canContinue(session: SessionSummary, working: Bool) -> Bool {
        !session.isReadOnlyHistory && session.state != "failed" && !changing && !continuing
            && session.isSubscriptionPaused
    }

    /// The chip stays usable while a pause holds queued messages, because a pick then goes through the sheet.
    func canPick(session: SessionSummary, working: Bool) -> Bool {
        canChange(session: session, working: working) || canContinue(session: session, working: working)
    }

    /// While paused at a usage limit, a pick asks first: another provider means a new chat.
    @discardableResult
    func pick(_ model: String, session: SessionSummary, working: Bool) -> Task<Void, Never>? {
        if model != session.model, canContinue(session: session, working: working) {
            beginContinuation(session: session, model: model, working: working)
            return nil
        }
        return selectModel(model, session: session, working: working)
    }

    func beginContinuation(session: SessionSummary, model: String? = nil, working: Bool) {
        guard canContinue(session: session, working: working) else { return }
        continuationError = nil
        continuation = ContinuationDraft(sessionId: session.id, model: model == session.model ? nil : model)
    }

    func continuationKind(session: SessionSummary, model: String) -> ModelContinuation {
        ModelContinuation.kind(current: session.model, usageProvider: session.usage?.subscription?.provider,
                               target: model, models: models)
    }

    /// Confirms the sheet. A new chat (another provider) is selected as soon as pilotd returns it.
    @discardableResult
    func confirmContinuation(session: SessionSummary) -> Task<Void, Never>? {
        guard let draft = continuation, draft.sessionId == session.id, let model = draft.model, model != session.model,
              !continuing, !changing, !session.isReadOnlyHistory else { return nil }
        continuing = true
        continuationError = nil
        return Task {
            defer { continuing = false }
            do {
                let next = try await continueModel(session.id, ContinueModelRequest(model: model))
                continuation = nil
                if next.id != session.id { showContinuedChat(next) }
            } catch {
                continuationError = error.localizedDescription
            }
        }
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

    /// Shows the cached list at once, then revalidates. Equal results never trigger a view update.
    func loadModels(cwd: String) async {
        let cached = cachedModels(cwd)
        if let cached, cached != models { models = cached }
        do {
            let fresh = try await fetchModels(cwd)
            if !Task.isCancelled, fresh != models { models = fresh }
        } catch {
            // A failed background refresh is not worth an alert while a usable list is showing.
            if !Task.isCancelled, cached == nil { self.error = error.localizedDescription }
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

/// The sheet behind "Continue with another model…": what the chosen model does to this chat, then confirm.
struct ContinuationDraft: Identifiable, Equatable {
    let sessionId: String
    var model: String?
    var id: String { sessionId }
}

/// The catalog grouped by provider, the current model ticked. Shared by the chip and the continuation sheet.
struct ModelMenuItems: View {
    let session: SessionSummary
    @ObservedObject var state: ChatModelPickerState
    var selected: String?
    let onSelect: (String) -> Void

    var body: some View {
        ForEach(state.providers, id: \.self) { provider in
            Section(provider) {
                ForEach(state.modelsByProvider[provider] ?? []) { option in
                    Button { onSelect(option.id) } label: {
                        if (selected ?? session.model) == option.id {
                            Label(option.name, icon: PilotIcon.selectedOption)
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
    }
}

/// Model selection is an idle-only operation, never an interruption of a running turn. Near a usage limit a pick
/// opens the continuation sheet instead, so switching provider is always confirmed.
struct ChatModelPicker: View {
    let session: SessionSummary
    let working: Bool
    @ObservedObject var state: ChatModelPickerState

    var body: some View {
        Menu {
            ModelMenuItems(session: session, state: state) { state.pick($0, session: session, working: working) }
        } label: {
            ChipLabel(title: state.displayName(for: session.model), icon: PilotIcon.model, maxTitleWidth: 200,
                      loading: state.changing || state.continuing)
        }
        .chipMenuStyle()
        .fixedSize(horizontal: true, vertical: false)
        .disabled(!state.canPick(session: session, working: working))
        .help(help)
        .accessibilityLabel("Model: \(state.displayName(for: session.model))")
    }

    private var help: String {
        if session.isContinued { return "This chat continued in another chat" }
        if session.isSubscriptionPaused { return ModelContinuation.pickerHelp }
        return working || session.isWorking ? "Model can be changed when idle with no queued messages" : "Change the model for this chat"
    }
}

struct ModelContinuationSheet: View {
    let session: SessionSummary
    @ObservedObject var state: ChatModelPickerState

    private var model: String? { state.continuation?.model }
    private var kind: ModelContinuation? { model.map { state.continuationKind(session: session, model: $0) } }

    var body: some View {
        SheetScaffold(
            "Continue with another model",
            subtitle: "Now on \(state.displayName(for: session.model))",
            error: state.continuationError,
            primary: SheetPrimaryAction(title: kind?.confirmTitle ?? "Continue",
                                        enabled: model != nil && !state.continuing) {
                state.confirmContinuation(session: session)
            },
            cancel: { state.continuation = nil }
        ) {
            Menu {
                ModelMenuItems(session: session, state: state, selected: model) { picked in
                    state.continuation?.model = picked == session.model ? nil : picked
                    state.continuationError = nil
                }
            } label: {
                ChipLabel(title: model.map { state.displayName(for: $0) } ?? "Choose a model", icon: PilotIcon.model,
                          maxTitleWidth: 260, loading: state.continuing)
            }
            .chipMenuStyle()
            .fixedSize(horizontal: true, vertical: false)
            .disabled(state.continuing)
            .accessibilityLabel("Model to continue with")
            Label {
                Text(kind.map { $0.explanation(modelName: state.displayName(for: model)) } ?? ModelContinuation.pickerHelp)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                PilotSymbol(kind == .newChat ? PilotIcon.handoff : PilotIcon.info)
            }
            .font(.pilot(.body))
            .foregroundStyle(Theme.mutedForeground)
        }
        .interactiveDismissDisabled(state.continuing)
    }
}

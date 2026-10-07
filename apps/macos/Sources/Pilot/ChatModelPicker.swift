import PilotCore
import SwiftUI

@MainActor
final class ChatModelPickerState: ObservableObject {
    @Published var models = ModelList(models: [])
    @Published var changing = false
    @Published var error: String?

    func loadModels(cwd: String) async {
        do {
            models = try await AppModel.shared.client.models(projectId: nil, cwd: cwd)
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
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
            ForEach(providers, id: \.self) { provider in
                Section(provider) {
                    ForEach(state.models.models.filter { $0.provider == provider }) { option in
                        Button { select(option.id) } label: {
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
                Text(state.models.displayName(for: session.model))
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
        .disabled(working || session.isWorking || session.isArchived || session.state == "failed" || state.changing)
        .help(working || session.isWorking ? "Model can be changed when idle with no queued messages" : "Change the model for this chat")
        .accessibilityLabel("Model: \(state.models.displayName(for: session.model))")
    }

    private var providers: [String] { Array(Set(state.models.models.map(\.provider))).sorted() }

    private func select(_ model: String) {
        guard model != session.model, !state.changing, !working, !session.isWorking else { return }
        state.changing = true
        Task {
            defer { state.changing = false }
            do {
                try await AppModel.shared.client.changeModel(session.id, model: model)
            } catch {
                state.error = error.localizedDescription
            }
        }
    }
}

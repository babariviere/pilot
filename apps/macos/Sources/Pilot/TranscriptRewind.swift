import PilotCore
import SwiftUI

/// Retry, edit and restore for one chat's transcript. Rows reach it through the environment, so they stay
/// equatable and lazy; only the Retry button observes it.
@MainActor
final class TranscriptRewind: ObservableObject {
    struct Request: Equatable {
        let action: RewindAction
        let entryID: Int
    }

    /// The failed turn whose error row shows Retry. Nil while working or when the last turn did not fail.
    @Published var retryEntryID: Int?
    /// One request at a time: it stops work and replaces the chat's kernel.
    @Published private(set) var pending = false
    /// Waiting for the user to agree to stop the current run.
    @Published var confirmation: Request?
    var isWorking: () -> Bool = { false }
    var perform: ((Request) async -> Void)?

    func request(_ action: RewindAction, entryID: Int) {
        let request = Request(action: action, entryID: entryID)
        if isWorking() { confirmation = request } else { run(request) }
    }

    func run(_ request: Request) {
        confirmation = nil
        guard !pending, let perform else { return }
        pending = true
        Task {
            await perform(request)
            pending = false
        }
    }

    static func confirmationTitle(_ action: RewindAction) -> String {
        switch action {
        case .retry: "Stop the current run and retry?"
        case .edit: "Stop the current run and edit this message?"
        case .restore: "Stop the current run and restore to here?"
        }
    }

    static func menuTitle(_ action: RewindAction) -> String {
        switch action {
        case .retry: "Retry"
        case .edit: "Edit and Resend"
        case .restore: "Restore to Here"
        }
    }
}

private struct TranscriptRewindKey: EnvironmentKey {
    static let defaultValue: TranscriptRewind? = nil
}

extension EnvironmentValues {
    var transcriptRewind: TranscriptRewind? {
        get { self[TranscriptRewindKey.self] }
        set { self[TranscriptRewindKey.self] = newValue }
    }
}

extension View {
    /// Edit for the user's own messages and restore for agent replies, in the row's context menu.
    func rewindMenu(for row: ChatRow) -> some View { modifier(RewindMenu(row: row)) }
}

private struct RewindMenu: ViewModifier {
    let row: ChatRow
    @Environment(\.transcriptRewind) private var rewind

    func body(content: Content) -> some View {
        if let rewind, let entryID = row.entryID, let action = row.rewindAction, action != .retry {
            content.contextMenu {
                Button {
                    rewind.request(action, entryID: entryID)
                } label: {
                    Label(TranscriptRewind.menuTitle(action),
                          systemImage: action == .edit ? "pencil" : "arrow.uturn.backward")
                }
                .help(action == .edit
                    ? "Continue from before this message with it in the composer. Files are not reverted."
                    : "Continue from the end of this reply. Files are not reverted.")
            }
        } else {
            content
        }
    }
}

/// Shown only on the error row of the last, failed turn.
struct RetryButton: View {
    let entryID: Int
    @ObservedObject var rewind: TranscriptRewind

    var body: some View {
        if rewind.retryEntryID == entryID {
            Button {
                rewind.request(.retry, entryID: entryID)
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
            }
            .controlSize(.small)
            .disabled(rewind.pending)
            .help("Run this turn again in a new attempt. The failed attempt stays available.")
        }
    }
}

@MainActor
private final class AttemptSwitch: ObservableObject {
    @Published var confirming: SessionAttempt?
}

/// Toolbar chip listing the chat's attempts. Hidden while there is only the original.
struct AttemptsMenu: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel
    @StateObject private var switching = AttemptSwitch()

    static func label(for attempts: [SessionAttempt]) -> String? {
        guard attempts.count > 1, let index = attempts.firstIndex(where: \.isActive) else { return nil }
        return "Attempt \(index + 1) of \(attempts.count)"
    }

    var body: some View {
        if let attempts = session.attempts, let label = Self.label(for: attempts) {
            Menu {
                ForEach(attempts.reversed()) { attempt in
                    Button {
                        guard !attempt.isActive else { return }
                        if session.isWorking { switching.confirming = attempt } else { activate(attempt) }
                    } label: {
                        if attempt.isActive {
                            Label(itemTitle(attempt), systemImage: "checkmark")
                        } else {
                            Text(itemTitle(attempt))
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.branch")
                    Text(label).lineLimit(1)
                }
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Capsule().fill(Theme.muted))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Switch between attempts created by retry, edit and restore. Files are not reverted.")
            .accessibilityLabel("\(label). Switch attempt")
            .confirmationDialog("Stop the current run and switch attempts?", isPresented: Binding(
                get: { switching.confirming != nil },
                set: { if !$0 { switching.confirming = nil } }
            )) {
                Button("Stop and Switch") {
                    if let attempt = switching.confirming { activate(attempt) }
                    switching.confirming = nil
                }
            } message: {
                Text("Workspace files stay as they are.")
            }
        }
    }

    private func itemTitle(_ attempt: SessionAttempt) -> String {
        guard let createdAt = attempt.createdAt else { return attempt.title }
        let date = Date(timeIntervalSince1970: createdAt / 1000)
        return "\(attempt.title) · \(date.formatted(.relative(presentation: .named)))"
    }

    private func activate(_ attempt: SessionAttempt) {
        let id = session.id
        Task {
            do { try await AppModel.shared.client.activateAttempt(id, attemptId: attempt.id) }
            catch { model.sessionActionError = error.localizedDescription }
        }
    }
}


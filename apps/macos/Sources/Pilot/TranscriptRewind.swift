import PilotCore
import SwiftUI

/// Retry, edit and restore for one chat's transcript. Rows reach it through the environment, so they stay
/// equatable and lazy; only action buttons observe it.
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

/// Wires a chat's rewind actions to pilotd and its composer, and confirms stopping a running turn.
struct TranscriptRewindHost: ViewModifier {
    @ObservedObject var rewind: TranscriptRewind
    let feed: SessionFeed
    let composer: ComposerState
    let sessionId: String
    let retryEntryID: Int?

    func body(content: Content) -> some View {
        content
            .onAppear {
                rewind.isWorking = { [feed] in feed.presentation.working }
                rewind.perform = { [sessionId, composer] request in
                    await Self.perform(request, sessionId: sessionId, composer: composer)
                }
            }
            .onDisappear { rewind.perform = nil }
            .onChange(of: retryEntryID, initial: true) { _, id in rewind.retryEntryID = id }
            .confirmationDialog(title, isPresented: confirming) {
                Button("Stop and Continue") {
                    if let request = rewind.confirmation { rewind.run(request) }
                }
            } message: {
                Text("The previous attempt stays available. Workspace files stay as they are.")
            }
    }

    private var title: String {
        guard let request = rewind.confirmation else { return "" }
        return TranscriptRewind.confirmationTitle(request.action)
    }

    private var confirming: Binding<Bool> {
        Binding(get: { rewind.confirmation != nil }, set: { if !$0 { rewind.confirmation = nil } })
    }

    /// Retry resends from the daemon; edit puts the message back in the composer to change and send.
    private static func perform(_ request: TranscriptRewind.Request, sessionId: String, composer: ComposerState) async {
        composer.error = nil
        do {
            let draft = try await AppModel.shared.client.rewind(
                sessionId, action: request.action, entryId: request.entryID
            )
            guard request.action == .edit, let draft else { return }
            let current = composer.draft
            composer.draft = current.isEmpty ? draft : draft + "\n\n" + current
            composer.composerFocus = UUID()
        } catch {
            composer.error = error.localizedDescription
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
            let menu = content.contextMenu {
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
            if action == .edit {
                // Zero-opacity controls are omitted from the native accessibility tree. Keep the
                // same action on the row so VoiceOver users never need to hover first.
                menu
                    .accessibilityElement(children: .contain)
                    .accessibilityAction(named: Text(TranscriptRewind.menuTitle(action))) {
                        if !rewind.pending { rewind.request(action, entryID: entryID) }
                    }
            } else {
                menu
            }
        } else {
            content
        }
    }
}

/// Secondary action beside a user's bubble. Its reserved slot prevents hover from reflowing text.
/// Keyboard focus reveals it too; RewindMenu exposes the action to VoiceOver without hover.
struct MessageEditButton: View {
    let entryID: Int
    @ObservedObject var rewind: TranscriptRewind
    let isHovered: Bool
    @FocusState private var isFocused: Bool

    var body: some View {
        Button {
            rewind.request(.edit, entryID: entryID)
        } label: {
            Image(systemName: "pencil")
        }
        .buttonStyle(QuietIconButtonStyle())
        .disabled(rewind.pending)
        .focused($isFocused)
        .opacity(isHovered || isFocused ? 1 : 0)
        .allowsHitTesting(isHovered || isFocused)
        .help("Edit and resend this message. Files are not reverted.")
        .accessibilityLabel("Edit and Resend")
        .accessibilityIdentifier("message-edit-\(entryID)")
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

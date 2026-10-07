import PilotCore
import SwiftUI

/// Live transcript for one session, fed by pilotd's agent event stream.
@MainActor
final class SessionFeed: ObservableObject {
    @Published private(set) var transcript: Transcript
    private let sessionId: String
    private let client: PilotClient?
    private var token: UUID?

    init(sessionId: String, client: PilotClient) {
        self.sessionId = sessionId
        self.client = client
        transcript = Transcript()
    }

    /// A static transcript, for snapshots and previews.
    init(sessionId: String, transcript: Transcript) {
        self.sessionId = sessionId
        client = nil
        self.transcript = transcript
    }

    func start() {
        guard let client, token == nil else { return }
        token = client.subscribe(sessionId) { [weak self] events in
            self?.transcript.apply(events)
        }
    }

    func stop() {
        if let token { client?.unsubscribe(sessionId, token: token) }
        token = nil
    }
}

struct ChatView: View {
    let session: SessionSummary
    @StateObject private var feed: SessionFeed
    @StateObject private var composer = ComposerState()

    init(session: SessionSummary, feed: SessionFeed? = nil) {
        self.session = session
        _feed = StateObject(wrappedValue: feed ?? SessionFeed(sessionId: session.id, client: AppModel.shared.client))
    }

    var body: some View {
        let transcript = feed.transcript
        let rows = transcript.rows
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(rows) { row in
                        RowView(row: row)
                    }
                    if transcript.working, transcript.streaming == nil || rows.last.map(isToolRow) == true {
                        WorkingIndicator(retry: transcript.retry)
                    }
                    if let error = session.error, transcript.error == nil {
                        ErrorRow(text: error)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 28)
                .padding(.top, 24)
                .padding(.bottom, 8)
                .frame(maxWidth: Theme.column + 56)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: transcript) { _, _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Composer(
                state: composer,
                working: transcript.working,
                queued: transcript.queued,
                onSend: send,
                onStop: { Task { try? await AppModel.shared.client.stop(session.id) } }
            )
        }
        .onAppear { feed.start() }
        .onDisappear { feed.stop() }
    }

    private func isToolRow(_ row: ChatRow) -> Bool {
        if case .tools = row { return true }
        return false
    }

    private func send(_ message: String, _ mode: DeliveryMode) {
        composer.error = nil
        let previous = composer.draft
        composer.draft = ""
        Task {
            do {
                try await AppModel.shared.client.send(session.id, message: message, mode: mode)
            } catch {
                composer.draft = previous
                composer.error = error.localizedDescription
            }
        }
    }
}

private struct RowView: View {
    let row: ChatRow

    var body: some View {
        switch row {
        case let .user(_, text):
            UserMessage(text: text)
        case let .text(_, text):
            MarkdownView(text: text)
        case let .thinking(_, text, streaming):
            ThinkingRow(text: text, streaming: streaming)
        case let .tools(_, items):
            ToolGroupView(items: items)
        case let .error(_, text):
            ErrorRow(text: text)
        case let .notice(_, text):
            HStack {
                VStack { Divider() }
                Text(text).font(.caption).foregroundStyle(.secondary).fixedSize()
                VStack { Divider() }
            }
        }
    }
}

private struct UserMessage: View {
    @Environment(\.pilotFonts) private var fonts
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 72)
            Text(text)
                .font(fonts.body)
                .lineSpacing(3)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.muted))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.border))
        }
        .padding(.top, 6)
    }
}

private struct ThinkingRow: View {
    let text: String
    let streaming: Bool
    @StateObject private var expansion = ExpansionState()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { expansion.expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain").font(.system(size: 11))
                    Text(streaming ? "Thinking…" : "Thought").font(.callout)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(expansion.expanded ? 90 : 0))
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expansion.expanded {
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 1).fill(.quaternary).frame(width: 2)
                    }
            }
        }
    }
}

private struct ErrorRow: View {
    let text: String

    var body: some View {
        Label {
            Text(text).textSelection(.enabled)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.callout)
        .foregroundStyle(.red)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.08)))
    }
}

private struct WorkingIndicator: View {
    let retry: String?

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(retry.map { "Retrying: \($0)" } ?? "Working…")
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

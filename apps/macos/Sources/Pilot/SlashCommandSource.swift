import PilotCore
import SwiftUI

/// The slash command menu for one chat: built-ins at once, plus the session's prompt templates and skills,
/// loaded the first time the menu opens. pilotd caches the list, so loading reopens a parked chat at most once.
@MainActor
final class SlashCommandSource: ObservableObject {
    /// The session's prompt templates and skills, once loaded.
    @Published private(set) var session: [SessionCommand] = []
    private var loading: Task<Void, Never>?
    private var loaded = false

    /// Built-ins, the app commands this composer supports (unless a session command already has the name), then
    /// the session's commands.
    func commands(app: [SlashCommand]) -> [SlashCommand] { SlashCommands.all(session, app: app) }

    func load(sessionId: String, client: PilotClient) {
        guard !loaded, loading == nil else { return }
        loading = Task { [weak self] in
            let result = try? await client.commands(sessionId)
            guard let self, !Task.isCancelled else { return }
            self.loading = nil
            // A failed load keeps the built-ins and retries the next time the menu opens.
            guard let result else { return }
            self.loaded = true
            if result != self.session { self.session = result }
        }
    }

    deinit { loading?.cancel() }
}

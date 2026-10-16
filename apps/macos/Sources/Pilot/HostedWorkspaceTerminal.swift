import PilotCore
import SwiftUI

/// Real hosted entry point. The unified chat inspector can embed this same qualified pane.
struct HostedWorkspaceTerminal: View {
    let session: Hosted<SessionSummary>
    @ObservedObject var store: TerminalStore
    @ObservedObject var hosts: HostClients
    var body: some View {
        if session.value.supportsChanges {
            TerminalPane(store: store, session: session.value, ref: session.ref, hosts: hosts)
                .navigationTitle(session.value.title)
        } else {
            EmptyStateView(icon: PilotIcon.terminal, title: "Shell unavailable",
                           message: "Read-only chats do not have a writable workspace shell.")
        }
    }
}

import PilotCore
import SwiftUI

/// UI-only historical access. Never constructs ChatView, a composer, an inspector or a live feed.
struct RetainedConversationHistoryView: View {
    let reference: HostResourceRef
    @ObservedObject private var hosts: HostClients
    @StateObject private var state: RetainedConversationHistoryModel

    init(reference: HostResourceRef, hosts: HostClients) {
        self.reference = reference; self.hosts = hosts
        _state = StateObject(wrappedValue: RetainedConversationHistoryModel(source: RetainedConversationReader(reference: reference, hosts: hosts)))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PageHeader("Retained conversation", subtitle: "Read-only Control history on \(name). Control has been retired. This conversation cannot be resumed.")
                Text("\(name) · \(reference.localId)").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).textSelection(.enabled)
                if let error = state.error {
                    Text(error).font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                } else if !hosts.available.contains(reference.host) {
                    Text("Disconnected. Reconnect to the original host to load uncached history.")
                        .font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                }
                if state.busy {
                    ProgressView("Loading history…")
                } else {
                    Button("Reload history") { Task { await state.load() } }.rowButtonStyle()
                        .disabled(!hosts.available.contains(reference.host))
                }
                if state.loaded && state.entries.isEmpty {
                    Text("No retained messages.").font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                }
                if state.canLoadOlder {
                    Button("Show earlier messages") { Task { await state.load(older: true) } }.rowButtonStyle()
                } else if state.next != nil && !state.busy {
                    Text("This view has reached its display limit. The original history is still kept on its host.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                LazyVStack(alignment: .leading, spacing: 20) {
                    ForEach(state.entries) { entry in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(entry.messages.first?.role.capitalized ?? entry.kind).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                                .help("Entry \(entry.id) · \(entry.kind)")
                            ForEach(Array(entry.messages.enumerated()), id: \.offset) { _, message in
                                Text(message.text).font(.pilot(.body)).foregroundStyle(Theme.foreground).textSelection(.enabled)
                            }
                            if entry.messages.isEmpty {
                                Text("Retained event · Entry \(entry.id)").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(24).frame(maxWidth: Theme.column, alignment: .leading).frame(maxWidth: .infinity)
        }
        .background(Theme.background)
        .navigationTitle("Retained conversation").navigationSubtitle("\(name) · Read-only")
        .task(id: try? hosts.token(for: reference.host)) { await state.load() }
        .onDisappear { state.stop() }
    }
    private var name: String { HostViewContext(host: reference.host, hosts: hosts).name }
}

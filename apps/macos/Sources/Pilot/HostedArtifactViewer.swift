import PilotCore
import SwiftUI

/// Pinned remote viewer. It never resolves a reference or library against the Local client/cache.
/// Existing transcript cards remain local-only until their owning surface supplies qualified refs.
struct HostedArtifactViewer: View {
    let reference: HostedArtifactReference
    @ObservedObject var hosts: HostClients
    @Environment(\.dismiss) private var dismiss
    @StateObject private var state = ArtifactViewState()
    @StateObject private var render = ArtifactRenderState()
    @State private var client: PilotClient?

    var body: some View {
        VStack(spacing: 0) {
            ArtifactViewerHeader(reference: reference.artifact, latest: false, host: reference.host,
                                 state: state, render: render, close: { dismiss() })
            Divider()
            if state.loading {
                ProgressView("Loading artifact…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let revision = state.revision, let client {
                ArtifactWebView(revision: revision, client: client, state: render)
                    .id(reference)
            } else {
                Text(state.error ?? "Reconnect to view this artifact.")
                    .foregroundStyle(Theme.mutedForeground).padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: 800, height: 600)
        .task(id: reference) {
            state.loading = true
            state.revision = nil
            do {
                client = try hosts.endpoint(reference.host)
                let value = try await hosts.artifact(reference)
                try Task.checkCancellation()
                state.revision = value
            } catch { state.error = error.localizedDescription }
            state.loading = false
        }
    }
}


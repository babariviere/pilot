import PilotCore
import SwiftUI

/// Resolves on click, never while laying out or streaming message text.
struct ArtifactLinkView: View {
    let link: ArtifactLink
    @StateObject private var state = ArtifactLinkViewState()

    var body: some View {
        Group {
            if let reference = state.reference {
                ArtifactViewer(reference: reference, latest: true)
            } else {
                SheetScaffold("Artifact", width: 700) {
                    Group {
                        if let error = state.error {
                            EmptyStateView(icon: PilotIcon.warning, title: "Couldn't open this artifact", message: error) {
                                Button("Retry") { Task { await state.load(link, client: AppModel.shared.client) } }
                            }
                        } else {
                            ProgressView("Loading artifact…")
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 360)
                }
            }
        }
        .task(id: link.id) { await state.load(link, client: AppModel.shared.client) }
    }
}

@MainActor
final class ArtifactLinkViewState: ObservableObject {
    @Published var reference: ArtifactReference?
    @Published var error: String?
    private var loading = false

    func load(_ link: ArtifactLink, client: PilotClient) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        reference = nil
        error = nil
        do {
            let value = try await client.resolveArtifact(link)
            guard !Task.isCancelled else { return }
            reference = value
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}

import PilotCore
import SwiftUI

/// Quiet ownership metadata, using the same desktop-app link opener as other Linear links.
struct MissionTaskDelegationLabel: View {
    let task: MissionTask
    var resources: [MissionResource] = []

    var body: some View {
        if let label = task.delegationLabel {
            Group {
                if let resource = resources.first(where: { $0.kind == .linearIssue }),
                   let url = URL(string: resource.url), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                    Button { BrowserLinkOpener.shared.open(url) } label: { Text(label) }
                        .buttonStyle(.plain)
                        .accessibilityHint("Open the linked issue in Linear")
                } else {
                    Text(label)
                }
            }
            .font(.pilot(.caption))
            .foregroundStyle(Theme.mutedForeground)
            .lineLimit(1)
            .help(label)
        }
    }
}

import PilotCore
import SwiftUI

/// Compact mode context, kept visible for Ask sessions without a Changes pane.
struct SessionContextBadge: View {
    let session: SessionSummary

    var body: some View {
        ViewThatFits(in: .horizontal) {
            context(session.isAsk ? "Ask · Read-only" : session.workspaceLabel)
            context(session.isAsk ? "Ask" : "Build")
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
        .help("\(session.workspaceLabel)\n\(session.workspaceHelp)")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(session.isAsk ? "Ask" : "Build") · \(session.workspaceLabel)")
    }

    private func context(_ title: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: session.isAsk ? "questionmark.bubble" : "hammer")
                .accessibilityHidden(true)
            Text(title)
        }
        .fixedSize(horizontal: true, vertical: false)
    }
}

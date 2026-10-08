import PilotCore
import SwiftUI

/// Visible above both the live and archived composer, independent of transcript scrolling.
struct SessionContextBadge: View {
    let session: SessionSummary

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: session.isAsk ? "questionmark.bubble" : "hammer")
            Text(session.isAsk ? "Ask" : "Build").fontWeight(.semibold)
            Text("· \(session.workspaceLabel) · \(session.sourceLabel)")
            if let commit = session.sourceCommit {
                Text(String(commit.prefix(8))).monospaced()
            }
        }
        .font(.caption)
        .foregroundStyle(Theme.mutedForeground)
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(session.workspaceHelp)
    }
}

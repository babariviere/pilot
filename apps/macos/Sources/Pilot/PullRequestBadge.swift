import PilotCore
import SwiftUI

/// Browser link only. PR state never replaces outcome or unread indicators.
struct PullRequestBadge: View {
    let session: SessionSummary
    var compact = false

    var body: some View {
        Group {
            if let pr = session.pullRequest {
                if let url = pr.browserURL {
                    Link(destination: url) { badge(pr) }
                        .buttonStyle(.plain)
                } else {
                    badge(pr)
                }
            } else if session.pullRequestError != nil {
                Label("PR unavailable", systemImage: "exclamationmark.triangle")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Theme.mutedForeground)
            }
        }
        .help(session.pullRequestHelpText ?? "")
    }

    private func badge(_ pr: SessionPullRequest) -> some View {
        HStack(spacing: 4) {
            Image(systemName: pr.state.icon)
            Text(compact ? pr.compactLabel : pr.label)
            if session.pullRequestIsStale {
                Image(systemName: "exclamationmark.triangle")
                Text("cached")
            }
            if pr.browserURL == nil { Image(systemName: "exclamationmark.circle") }
        }
        .font(.system(size: 10, weight: .medium))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 5).fill(pr.state.color.opacity(0.09)))
        .foregroundStyle(pr.state.color)
        .fixedSize()
        .accessibilityLabel("Pull request \(pr.number), \(session.pullRequestIsStale ? "last known " : "")\(pr.state.label)\(pr.browserURL == nil ? ", invalid link" : "")")
    }
}

extension PullRequestState {
    var icon: String {
        switch self {
        case .draft: "pencil.circle"
        case .open: "arrow.triangle.pull"
        case .merged: "arrow.triangle.merge"
        case .closed: "xmark.circle"
        }
    }

    var color: Color {
        switch self {
        case .draft: Theme.mutedForeground
        case .open: Color(hex: 0x15803D)
        case .merged: Color(hex: 0x7C3AED)
        case .closed: Color(hex: 0xB91C1C)
        }
    }
}

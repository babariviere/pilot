import PilotCore
import SwiftUI

/// Browser link only. PR state never replaces outcome or unread indicators.
struct PullRequestBadge: View {
    let session: SessionSummary

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
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Theme.mutedForeground)
                    .accessibilityLabel("Pull request lookup unavailable")
            }
        }
        .help(session.pullRequestHelpText ?? "")
    }

    private func badge(_ pr: SessionPullRequest) -> some View {
        HStack(spacing: 4) {
            Image(systemName: pr.state.icon)
            Text("#\(pr.number)")
            if session.pullRequestIsStale || pr.browserURL == nil {
                Image(systemName: "exclamationmark.triangle")
            }
        }
        .font(.system(size: 10, weight: .medium))
        .padding(.vertical, 2)
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

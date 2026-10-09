import PilotCore
import SwiftUI

/// Browser links only, one per PR the session opened. PR state never replaces outcome or unread indicators.
struct PullRequestBadge: View {
    enum Presentation { case badge, details }

    let session: SessionSummary
    var presentation: Presentation = .badge

    var body: some View {
        Group {
            let prs = session.linkedPullRequests
            if !prs.isEmpty {
                if presentation == .details {
                    ResponsiveControlsLayout(horizontalSpacing: 10, verticalSpacing: 6) { links }
                } else {
                    HStack(spacing: 6) { links }
                }
            } else if session.pullRequestError != nil {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle")
                    if presentation == .details { Text("PR status unavailable") }
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Theme.mutedForeground)
                .accessibilityLabel("Pull request lookup unavailable")
            }
        }
        .help(session.pullRequestHelpText ?? "")
    }

    private var links: some View {
        ForEach(session.linkedPullRequests, id: \.url) { pr in
            if let url = pr.browserURL {
                Link(destination: url) { badge(pr) }
                    .buttonStyle(.plain)
            } else {
                badge(pr)
            }
        }
    }

    private func badge(_ pr: SessionPullRequest) -> some View {
        HStack(spacing: 4) {
            if presentation == .badge { pr.state.icon }
            Text(presentation == .details ? "\(pr.state.compactLabel) PR #\(pr.number)" : "#\(pr.number)")
            if session.pullRequestIsStale || pr.browserURL == nil {
                Image(systemName: "exclamationmark.triangle")
            }
            if presentation == .details, pr.browserURL != nil {
                Image(systemName: "arrow.up.right").accessibilityHidden(true)
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
    @ViewBuilder var icon: some View {
        switch self {
        case .draft: Image(systemName: "pencil.circle")
        case .open: Image(nsImage: GitBranchGlyph.image).resizable().frame(width: 11, height: 11)
        case .merged: Image(systemName: "arrow.triangle.pull")
        case .closed: Image(systemName: "xmark.circle")
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

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
            if session.isMissionCoordinator { EmptyView() } else if !prs.isEmpty {
                if presentation == .details {
                    ResponsiveControlsLayout(horizontalSpacing: 10, verticalSpacing: 6) { links }
                } else {
                    HStack(spacing: 6) { links }
                }
            } else if session.pullRequestError != nil {
                HStack(spacing: 4) {
                    PilotSymbol(PilotIcon.warning)
                    if presentation == .details { Text("PR status unavailable") }
                }
                .font(.pilot(.small, weight: .medium))
                .foregroundStyle(Theme.mutedForeground)
                .accessibilityLabel("Pull request lookup unavailable")
            }
        }
        .help(session.pullRequestHelpText ?? "")
    }

    private var links: some View {
        ForEach(session.linkedPullRequests, id: \.url) { pr in
            PullRequestLink(pullRequest: pr, presentation: presentation, stale: session.pullRequestIsStale)
        }
    }
}

/// One PR as a browser link, or plain text when its URL is unsafe to open.
struct PullRequestLink: View {
    let pullRequest: SessionPullRequest
    var presentation: PullRequestBadge.Presentation = .badge
    var stale = false

    var isReady: Bool { pullRequest.state == .open && pullRequest.readiness?.state == .ready }

    var label: String {
        presentation == .details
            ? "\(isReady ? "Ready to merge" : pullRequest.state.compactLabel) PR #\(pullRequest.number)"
            : "#\(pullRequest.number)"
    }

    var body: some View {
        if let url = pullRequest.browserURL {
            Link(destination: url) { badge }
                .buttonStyle(.plain)
        } else {
            badge
        }
    }

    private var badge: some View {
        let pr = pullRequest
        let ready = isReady
        return HStack(spacing: 4) {
            if presentation == .badge { pr.state.icon.accessibilityHidden(true) }
            Text(label)
            if stale || pr.browserURL == nil {
                PilotSymbol(PilotIcon.warning)
            }
            if presentation == .details, pr.browserURL != nil {
                PilotSymbol(PilotIcon.openExternal).accessibilityHidden(true)
            }
        }
        .font(.pilot(.small, weight: .medium))
        .padding(.vertical, 2)
        .foregroundStyle(ready ? PullRequestState.open.color : pr.state.color)
        .fixedSize()
        .accessibilityLabel("Pull request \(pr.number), \(stale ? "last known " : "")\(ready ? "Ready to merge" : pr.state.label)\(pr.browserURL == nil ? ", invalid link" : "")")
        .help(readinessHelp(pr))
    }

    private func readinessHelp(_ pr: SessionPullRequest) -> String {
        guard pr.state == .open else { return "Pull request #\(pr.number), \(pr.state.label)." }
        guard let readiness = pr.readiness else { return "Pull request #\(pr.number), \(pr.state.label). Readiness not checked." }
        if readiness.state == .ready { return "Pull request #\(pr.number) is ready to merge. Pilot will not merge it." }
        let reasons = readiness.reasons.map { reason -> String in
            switch reason.code {
            case "failing_checks": return "Failing checks: \((reason.names ?? []).joined(separator: ", "))"
            case "unresolved_comments": return "\(reason.count ?? 0) unresolved review comments"
            case "conflicts": return "Merge conflicts"
            case "draft": return "Draft pull request"
            case "changes_requested": return "Changes requested"
            case "review_required": return "Review required"
            case "behind": return "Branch is behind its base"
            case "readiness_unknown": return "Readiness could not be determined"
            default: return reason.value ?? reason.code.replacingOccurrences(of: "_", with: " ")
            }
        }
        return ([readiness.state == .pending ? "Readiness pending" : "Blocked from merging"] + reasons).joined(separator: "\n")
    }
}

extension PullRequestState {
    @MainActor @ViewBuilder var icon: some View {
        switch self {
        case .draft: PilotMarkIcon(mark: .gitBranch)
        case .open: PilotMarkIcon(mark: .gitBranch)
        case .merged: PilotMarkIcon(mark: .pullRequestMerged)
        case .closed: PilotMarkIcon(mark: .pullRequestClosed)
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

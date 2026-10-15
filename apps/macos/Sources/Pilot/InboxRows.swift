import AppKit
import PilotCore
import SwiftUI

// Rows and helpers shared by the Inbox and a project's Overview. They name the project only when a list mixes
// projects, read like the chat's sidebar row on their second line, and carry the sidebar's dithered corner.

extension View {
    /// The sidebar's dithered status corner on an Inbox or Overview row. The same trailing room on every row keeps
    /// actions aligned and off the corner's densest cells, so they stay readable and a state change never shifts
    /// them. `background` draws the subtler working corner of a chat that only waits on its jobs.
    func inboxCorner(_ signal: SessionSignal?, background: Bool = false) -> some View {
        padding(.trailing, 24).ditherCorner(signal, background: background)
    }
}

/// The body of an Inbox or Overview row: the title, the sidebar-like second line and a trailing action or time.
/// There is no leading status icon: the row's dithered corner (`inboxCorner`) carries its state, as in the
/// sidebar. Divide these rows with `HairlineDivider(leading: InboxRowLayout.dividerInset)`.
struct InboxRowLabel<Detail: View, Trailing: View>: View {
    let title: String
    @ViewBuilder var detail: Detail
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                detail
            }
            Spacer(minLength: 8)
            trailing
        }
    }
}

enum InboxRowLayout {
    /// Lines dividers up with the text of rows without a leading icon, which starts at the row's own padding.
    static let dividerInset: CGFloat = 8
}

/// A row's trailing action, such as "Review" or "Open PR", brighter while the row is hovered.
struct InboxRowAction: View {
    let title: String
    var icon: PilotIcon = .disclosure
    let hovered: Bool

    var body: some View {
        HStack(spacing: 10) {
            Text(title).font(.pilot(.label, weight: .medium))
                .foregroundStyle(hovered ? Theme.foreground : Theme.mutedForeground)
                .fixedSize()
            PilotSymbol(icon, context: .disclosure)
                .foregroundStyle(Theme.faintForeground)
                .accessibilityHidden(true)
        }
    }
}

extension AppModel {
    /// A Linear or Slack row's corner follows the latest chat it started (working, failed, unread, ready to
    /// merge), like that chat's sidebar row. Items nothing has started yet stay quiet.
    func trackedItemSignal(_ item: TrackedItem) -> SessionSignal? {
        guard let session = trackedItemSession(item) else { return nil }
        return session.signal(unread: isUnread(session))
    }

    /// The latest chat a Linear or Slack item started, when it is still listed.
    func trackedItemSession(_ item: TrackedItem) -> SessionSummary? {
        item.sessionId.flatMap { client.session($0) }
    }
}

/// The second line of an Inbox row, as in the chat's sidebar row: the project when the list mixes projects, then
/// "<compass> Coordinator · <state>" for an active coordinator, or the chat's mission, PR badge, branch and the
/// row's reason. A ready-to-merge row passes its pull request, shown in place of the chat's badge. Rows show no
/// file or line counts; those stay in the chat's Changes pane.
struct InboxRowDetail: View {
    var projectName: String?
    /// The live chat behind the row, when there is one.
    var session: SessionSummary?
    var missionTitle: String?
    var reason: String?
    var pullRequest: DashboardPullRequest?
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 4) {
            if let projectName {
                Text(projectName).fontWeight(.medium).lineLimit(1).layoutPriority(1)
                if hasMore(afterProject: true) { dot }
            }
            if let session, session.isActiveMissionCoordinator {
                SessionCoordinatorLine(session: session, unread: model.isUnread(session))
            } else {
                if let missionTitle {
                    InboxMissionLabel(title: missionTitle)
                    if hasMore(afterProject: false) { dot }
                }
                if let pullRequest {
                    InboxPullRequestMark(pr: pullRequest)
                    if let branch = pullRequest.branch, !branch.isEmpty {
                        dot
                        Text(branch).fontWeight(.medium).lineLimit(1).truncationMode(.middle).layoutPriority(-1)
                            .accessibilityLabel("Branch \(branch)")
                    }
                } else if let session, hasRepository(session) {
                    SessionRepositoryMetadataContent(session: session, summary: nil, branch: session.branch, error: nil)
                }
                if let reason {
                    if pullRequest != nil || session.map(hasRepository) == true { dot }
                    Text(reason).lineLimit(1).layoutPriority(1)
                }
            }
        }
        .font(.pilot(.small))
        .foregroundStyle(Theme.mutedForeground)
        .lineLimit(1)
    }

    private var dot: some View {
        Text("·").foregroundStyle(Theme.faintForeground).accessibilityHidden(true)
    }

    private func hasRepository(_ session: SessionSummary) -> Bool {
        !session.isAsk && (session.branch?.isEmpty == false || !session.linkedPullRequests.isEmpty)
    }

    /// Whether anything follows the project name (or, with `afterProject` false, the mission label).
    private func hasMore(afterProject: Bool) -> Bool {
        if let session, session.isActiveMissionCoordinator { return afterProject }
        if afterProject, missionTitle != nil { return true }
        return pullRequest != nil || reason != nil || session.map(hasRepository) == true
    }

    /// The same line as plain text, for VoiceOver.
    var accessibilityText: String {
        var parts = [projectName]
        if let session, session.isActiveMissionCoordinator {
            parts.append("Coordinator")
        } else {
            parts.append(missionTitle.map { "Mission \($0)" })
            if let pullRequest {
                parts.append("Pull request \(pullRequest.number)")
                parts.append(pullRequest.branch.map { "Branch \($0)" })
            } else if let branch = session?.branch, !branch.isEmpty, session?.isAsk == false {
                parts.append("Branch \(branch)")
            }
            parts.append(reason)
        }
        return parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// A chat's mission on an Inbox row. Not a button: the row is one. The row's context menu opens the mission.
struct InboxMissionLabel: View {
    let title: String

    var body: some View {
        HStack(spacing: 3) {
            PilotSymbol(PilotIcon.mission)
            Text(title).lineLimit(1).truncationMode(.tail)
        }
        .font(.pilot(.small, weight: .medium))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Mission \(title)")
    }
}

/// "#441" with its merge readiness, as a chat's PR badge reads.
struct InboxPullRequestMark: View {
    let pr: DashboardPullRequest

    var body: some View {
        let readiness = PullRequestReadinessStyle(pr)
        HStack(spacing: 3) {
            PilotMarkIcon(mark: .gitBranch)
            Text(verbatim: "#\(pr.number)").monospacedDigit()
        }
        .font(.pilot(.small, weight: .medium))
        .foregroundStyle(readiness.color)
        .fixedSize()
        .help("Pull request #\(pr.number), \(readiness.label)")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Pull request \(pr.number), \(readiness.label)")
    }
}

/// A pull request ready to merge. Clicking opens it on GitHub, where the user merges it (Pilot never merges); the
/// context menu and an accessibility action open its chat. The second line reads like the chat's sidebar row.
struct InboxReadyToMergeRow: View {
    let pr: DashboardPullRequest
    /// The project name, when the list mixes projects.
    var context: String?
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let url = InboxLinks.browserURL(pr.url)
        let session = model.client.session(pr.sessionId)
        let missionTitle = pr.missionId.flatMap { model.client.mission($0)?.title }
        let detail = InboxRowDetail(projectName: context, session: session, missionTitle: missionTitle,
                                    pullRequest: pr)
        Button { if let url { BrowserLinkOpener.shared.open(url) } else { openChat() } } label: {
            HoverRow(verticalPadding: 7) { hovered in
                InboxRowLabel(title: pr.title) { detail } trailing: {
                    InboxRowAction(title: url == nil ? "Open chat" : "Open PR",
                                   icon: url == nil ? PilotIcon.disclosure : PilotIcon.openExternal, hovered: hovered)
                }
            }
        }
        .rowButtonStyle()
        .help("Pull request #\(pr.number) is ready to merge. Pilot will not merge it. Chat: \(pr.sessionTitle)")
        .accessibilityLabel("\(pr.title). Ready to merge. \(detail.accessibilityText)")
        .accessibilityHint(url == nil ? "Opens the chat" : "Opens the pull request in the browser")
        .accessibilityAction(named: "Open chat", openChat)
        .contextMenu {
            if let url { Link("Open in Browser", destination: url) }
            Button("Open Chat", action: openChat)
            if let missionId = pr.missionId { Button("Open Mission") { model.openMission(missionId) } }
            Button("Copy Link") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(pr.url, forType: .string)
            }
        }
    }

    private func openChat() { model.selectedSessionId = pr.sessionId }
}

enum InboxLinks {
    /// Opens only http(s) links, as chat PR badges do.
    static func browserURL(_ url: String) -> URL? {
        SessionPullRequest(number: 0, url: url, title: "", state: .open, checkedAt: 0).browserURL
    }
}

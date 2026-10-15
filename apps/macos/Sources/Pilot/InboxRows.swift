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
    /// Settled rows, such as merged pull requests, read quieter than the ones still in play.
    var quiet = false
    @ViewBuilder var detail: Detail
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.pilot(.body)).foregroundStyle(quiet ? Theme.mutedForeground : Theme.foreground)
                    .lineLimit(1)
                detail
            }
            Spacer(minLength: 8)
            trailing
        }
    }
}

/// The one Needs you row of the Inbox, a project's Overview and a mission's Overview: the title, the sidebar-like
/// reason line and a trailing action ("Review", "Answer", "Open chat"). Lists add `.inboxCorner(signal)`; the
/// help tag and VoiceOver carry the full reason.
struct NeedsYouRow<Detail: View>: View {
    let title: String
    /// Nil when there is nothing to open; the row is then disabled.
    let action: String?
    let help: String
    let accessibilityDetail: String
    let open: () -> Void
    @ViewBuilder var detail: Detail

    var body: some View {
        Button(action: open) {
            HoverRow(verticalPadding: 7) { hovered in
                InboxRowLabel(title: title) { detail } trailing: {
                    if let action { InboxRowAction(title: action, hovered: hovered) }
                }
            }
        }
        .rowButtonStyle()
        .disabled(action == nil)
        .help(help)
        .accessibilityLabel("\(title). \(accessibilityDetail)")
        .accessibilityHint(action ?? "")
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

/// The second line of an Inbox or Overview row, laid out like the chat's sidebar row (`RowLine`): the project when
/// the list mixes projects, then "<compass> Coordinator · <state>" for an active coordinator, or Ask, the row's
/// reason, the chat's PRs, its mission and branch. A ready-to-merge row passes its pull request, shown in place of
/// the chat's badges with its branch. These rows have more room than the sidebar, so the line may wrap once before
/// it fades. Rows show no file or line counts; those stay in the chat's Changes pane.
///
/// A chat's unsent draft replaces the details after the project, as on its sidebar row. Pull request rows keep their
/// badge instead: they stand for the pull request, not the chat.
struct InboxRowDetail: View {
    var projectName: String?
    /// The live chat behind the row, when there is one.
    var session: SessionSummary?
    var missionTitle: String?
    var reason: String?
    var pullRequest: DashboardPullRequest?
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let draft = draft
        let line = RowLine(segments: RowLineSegments.shown(segments(unread: session.map { model.isUnread($0) } ?? false),
                                                           draft: draft), maxLines: 2)
        // The row's own tooltip stays on the rest of the row; the line names the whole draft.
        if let draft { line.help(draft.help) } else { line }
    }

    private var draft: RowDraft? {
        pullRequest == nil ? model.chatDraft(session?.id) : nil
    }

    private func segments(unread: Bool) -> [RowLineSegment] {
        let coordinator = session.flatMap { $0.isActiveMissionCoordinator ? $0 : nil }
        return RowLineSegments.session(
            session, projectName: projectName, missionTitle: missionTitle, reason: reason,
            branch: session?.branch, coordinatorDetail: coordinator.map { MissionCoordinatorStatus.detail($0, unread: unread) },
            pullRequest: pullRequest)
    }

    /// The same line as plain text, for VoiceOver, with every segment the line has no room for.
    var accessibilityText: String {
        let coordinator = session.flatMap { $0.isActiveMissionCoordinator ? $0 : nil }
        return RowLineSegments.described(RowLineSegments.session(
            session, projectName: projectName, missionTitle: missionTitle, reason: reason, branch: session?.branch,
            coordinatorDetail: coordinator == nil ? nil : "", pullRequest: pullRequest), draft: draft).accessibilityText
    }
}

/// A chat's mission on a row that is one button. The row's context menu opens the mission.
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

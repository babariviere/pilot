import AppKit
import PilotCore
import SwiftUI

// The Overview's one Links list: open pull requests (ready to merge first), Linear, other links, then merged pull
// requests, with closed ones under Show all. Links come from the mission and from every task, de-duplicated by URL.

/// Builds the link groups once per change of the mission's links, not on every body evaluation.
/// A body only compares the saved links and task numbers with the last build. Chats' PR reports are read
/// only while some pull request link has no saved state.
@MainActor
final class MissionLinkGroupsCache: ObservableObject {
    private var input: MissionLinksInput?
    private var unresolved: Set<String> = []
    private var cached = MissionLinkGroups(MissionLinksInput(resources: [], taskNumbers: [:]))
    /// How many times the groups were rebuilt, for tests.
    private(set) var builds = 0

    func groups(for detail: MissionDetail, sessions: @autoclosure () -> [SessionSummary]) -> MissionLinkGroups {
        let numbers = MissionLinksInput.taskNumbers(detail.tasks)
        let unchanged = input.map { $0.resources == detail.resources && $0.taskNumbers == numbers } ?? false
        let pending = unchanged
            ? unresolved
            : MissionLinksInput(resources: detail.resources, taskNumbers: numbers).unresolvedPullRequestURLs
        let reported = pending.isEmpty ? [:] : Self.reported(pending, in: sessions())
        if unchanged, reported == input?.reportedPullRequests { return cached }
        let next = MissionLinksInput(resources: detail.resources, taskNumbers: numbers, reportedPullRequests: reported)
        builds += 1
        unresolved = pending
        input = next
        cached = MissionLinkGroups(next)
        return cached
    }

    private static func reported(_ urls: Set<String>, in sessions: [SessionSummary]) -> [String: SessionPullRequest] {
        var result: [String: SessionPullRequest] = [:]
        for session in sessions {
            for pullRequest in session.linkedPullRequests where urls.contains(pullRequest.url) {
                result[MissionLinks.normalizedURL(pullRequest.url)] = pullRequest
            }
        }
        return result
    }
}

struct MissionLinksSection: View {
    let mission: Mission
    let detail: MissionDetail
    @EndpointClient private var client
    @StateObject private var cache = MissionLinkGroupsCache()
    @State private var expanded: Bool

    /// The list shows this many rows before "Show all".
    static let collapsedLimit = 5

    init(mission: Mission, detail: MissionDetail, expanded: Bool = false) {
        self.mission = mission
        self.detail = detail
        _expanded = State(initialValue: expanded)
    }

    var body: some View {
        let groups = cache.groups(for: detail, sessions: client.sessions)
        let listed = groups.listed
        let collapsed = Array(listed.prefix(Self.collapsedLimit))
        // Closed pull requests only appear under Show all.
        let shown = expanded ? listed + groups.closed : collapsed
        let total = listed.count + groups.closed.count
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                PageSectionHeader(title: "Links", count: listed.count)
                MissionAddLinkButton(missionId: mission.id)
            }
            .help("Links of the mission and its tasks")
            if groups.isEmpty {
                Text("No links yet. Add a Linear, GitHub or Slack item, or any URL.")
                    .font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                    .padding(.horizontal, 8).padding(.vertical, 4)
            } else if shown.isEmpty {
                Text("Only closed pull requests.")
                    .font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                    .padding(.horizontal, 8).padding(.vertical, 4)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, link in
                    if index > 0 { HairlineDivider(leading: InboxRowLayout.dividerInset) }
                    MissionLinkRow(link: link, missionId: mission.id).equatable()
                }
            }
            if total > collapsed.count {
                ListToggle(total: total, expanded: $expanded)
                    .padding(.leading, 8)
                    .accessibilityHint(groups.closed.isEmpty ? "" : "Includes pull requests closed without merging")
            }
        }
    }
}

// MARK: Actions

@MainActor
private enum MissionLinkActions {
    static func open(_ link: MissionLink) {
        guard let url = URL(string: link.url), ["http", "https"].contains(url.scheme?.lowercased()) else { return }
        BrowserLinkOpener.shared.open(url)
    }

    static func copy(_ link: MissionLink) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link.url, forType: .string)
    }

    static func remove(_ link: MissionLink, missionId: String, client: PilotClient) {
        guard let id = link.resourceIds.first, link.resourceIds.count == 1 else { return }
        AppModel.shared.missionAction { try await client.deleteMissionResource(missionId, resourceId: id) }
    }

    static func showTask(_ link: MissionLink) {
        guard let taskId = link.taskId else { return }
        AppModel.shared.showMissionTask(taskId)
    }

    /// What VoiceOver reads: the service and number or ID, the title and the task.
    static func accessibilityLabel(_ link: MissionLink, status: String? = nil) -> String {
        var parts = [link.resource.accessibilityName(pullRequest: link.pullRequest)]
        if !link.title.isEmpty, !parts[0].contains(link.title) { parts.append(link.title) }
        // Saved state is already in the name; readiness is not.
        if let status, link.pullRequest?.state == .open { parts.append(status) }
        if let number = link.taskNumber { parts.append("task \(number)") }
        return parts.joined(separator: ", ")
    }

    static func help(_ link: MissionLink) -> String {
        var lines = [link.url]
        if let stack = link.pullRequest?.stack { lines.append(stack.helpText) }
        if let number = link.taskNumber { lines.append("Task #\(number)") }
        return lines.joined(separator: "\n")
    }
}

private struct MissionLinkMenuItems: View {
    @EndpointClient private var endpoint
    let link: MissionLink
    let missionId: String

    var body: some View {
        Button("Open Link") { MissionLinkActions.open(link) }
        if link.taskId != nil {
            Button("Show Task") { MissionLinkActions.showTask(link) }
        }
        Button("Copy Link") { MissionLinkActions.copy(link) }
        if link.resourceIds.count == 1 {
            Divider()
            Button("Remove Link", role: .destructive) { MissionLinkActions.remove(link, missionId: missionId, client: endpoint) }
        }
    }
}

// MARK: Row

/// One link, modelled on a project's pull request row: the title, then a second line with the service mark, where it
/// points ("#412", "ENG-123", "Slack thread"), the pull request's readiness in the Inbox's words and its task. Ready
/// to merge rows carry that corner. Merged and closed pull requests read quieter. Clicking opens the link.
/// Equatable so rows are not rebuilt when only unrelated state changes.
struct MissionLinkRow: View, Equatable {
    let link: MissionLink
    let missionId: String

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.link == rhs.link && lhs.missionId == rhs.missionId }

    var body: some View {
        let status = status
        Button { MissionLinkActions.open(link) } label: {
            HoverRow(verticalPadding: 7) { hovered in
                InboxRowLabel(title: link.rowTitle, quiet: settled) {
                    detail(status)
                } trailing: {
                    PilotSymbol(PilotIcon.openExternal)
                        .foregroundStyle(hovered ? Theme.mutedForeground : Theme.faintForeground)
                        .accessibilityHidden(true)
                }
            }
        }
        .rowButtonStyle()
        .inboxCorner(link.isReadyToMerge ? .readyToMerge : nil)
        .contextMenu { MissionLinkMenuItems(link: link, missionId: missionId) }
        .help(MissionLinkActions.help(link))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MissionLinkActions.accessibilityLabel(link, status: status?.text))
        .accessibilityAddTraits(.isLink)
        .accessibilityAction { MissionLinkActions.open(link) }
        .accessibilityAction(named: "Show task") { MissionLinkActions.showTask(link) }
    }

    /// Merged and closed pull requests: history, not work in play.
    private var settled: Bool { link.pullRequest?.isTerminal == true }

    private struct Status {
        let text: String
        let color: Color
    }

    /// A pull request's state in the Inbox's vocabulary ("Ready to merge", "Checks pending", "Merged · 2d").
    private var status: Status? {
        guard let pr = link.pullRequest else { return nil }
        switch pr.state {
        case .open, .draft:
            let readiness = PullRequestReadinessStyle(pr)
            return Status(text: readiness.label, color: readiness.kind == .ready ? readiness.color : Theme.mutedForeground)
        case .merged:
            return Status(text: "Merged · \(missionRelativeTime(link.age))", color: Theme.faintForeground)
        case .closed:
            return Status(text: pr.state.label, color: Theme.faintForeground)
        }
    }

    private func detail(_ status: Status?) -> some View {
        HStack(spacing: 4) {
            MissionLinkIcon(kind: link.kind, pullRequestState: link.pullRequest?.state, size: 10)
            Text(link.reference).monospacedDigit().lineLimit(1).layoutPriority(1)
            if let status {
                Text("·").foregroundStyle(Theme.faintForeground)
                Text(status.text).foregroundStyle(status.color).lineLimit(1)
            }
            if let stack = link.pullRequest?.stack, !settled {
                Text("·").foregroundStyle(Theme.faintForeground)
                Text(stack.label).lineLimit(1)
            }
            if let number = link.taskNumber {
                Text("·").foregroundStyle(Theme.faintForeground)
                Text("Task #\(number)").monospacedDigit().lineLimit(1).fixedSize()
            }
        }
        .font(.pilot(.small))
        .foregroundStyle(Theme.mutedForeground)
    }
}

import AppKit
import PilotCore
import SwiftUI

// Overview links, grouped by provider: Linear, pull requests (open, merged, closed) and a compact row of
// other links. Links come from the mission and from every task, de-duplicated by URL.

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

enum MissionLinkSlice: Hashable { case linear, open, merged, closed }

/// Which lists are unfolded. Plain values, so a snapshot can start in any state.
struct MissionLinksDisclosure: Equatable {
    var expanded: Set<MissionLinkSlice> = []
    var showClosed = false
    /// Nil follows the default: shown unless there are many.
    var otherExpanded: Bool?
}

struct MissionLinksSection: View {
    let mission: Mission
    let detail: MissionDetail
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var cache = MissionLinkGroupsCache()
    @State private var disclosure: MissionLinksDisclosure

    /// Lists show this many rows before "Show all".
    static let collapsedLimit = 5
    /// More other links than this start folded.
    static let otherFoldedAbove = 8

    init(mission: Mission, detail: MissionDetail, disclosure: MissionLinksDisclosure = MissionLinksDisclosure()) {
        self.mission = mission
        self.detail = detail
        _disclosure = State(initialValue: disclosure)
    }

    var body: some View {
        let groups = cache.groups(for: detail, sessions: client.sessions)
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    PageSectionHeader(title: "Links")
                    MissionAddLinkButton(missionId: mission.id)
                }
                if !groups.isEmpty {
                    Text("From the mission and its tasks").font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                }
            }
            if groups.isEmpty {
                Text("No links yet. Add a Linear, GitHub or Slack item, or any URL.")
                    .font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
            }
            if !groups.linear.isEmpty { linear(groups.linear) }
            if groups.hasPullRequests { pullRequests(groups) }
            if !groups.other.isEmpty { other(groups.other) }
        }
    }

    // MARK: Groups

    private func linear(_ links: [MissionLink]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            groupHeader("Linear", count: links.count)
            rows(links, list: .linear, noun: "")
        }
    }

    private func pullRequests(_ groups: MissionLinkGroups) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            groupHeader("Pull requests", count: groups.pullRequestCount) {
                if !groups.closed.isEmpty {
                    Button(disclosure.showClosed ? "Hide closed" : "Show closed (\(groups.closed.count))") {
                        disclosure.showClosed.toggle()
                    }
                    .buttonStyle(.plain)
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .accessibilityHint("Pull requests closed without merging")
                }
            }
            if !groups.open.isEmpty {
                subheader("Open", count: groups.open.count, color: PullRequestState.open.color)
                rows(groups.open, list: .open, noun: " open")
            }
            if !groups.merged.isEmpty {
                subheader("Merged", count: groups.merged.count, color: PullRequestState.merged.color)
                rows(groups.merged, list: .merged, noun: " merged")
            }
            if disclosure.showClosed, !groups.closed.isEmpty {
                subheader("Closed", count: groups.closed.count, color: PullRequestState.closed.color)
                rows(groups.closed, list: .closed, noun: " closed")
            }
        }
    }

    private func other(_ links: [MissionLink]) -> some View {
        let expanded = disclosure.otherExpanded ?? (links.count <= Self.otherFoldedAbove)
        return VStack(alignment: .leading, spacing: 8) {
            Button { disclosure.otherExpanded = !expanded } label: {
                HStack(spacing: 6) {
                    PilotSymbol(expanded ? PilotIcon.disclosureOpen : PilotIcon.disclosure, context: .disclosure).foregroundStyle(Theme.faintForeground).frame(width: 10)
                    Text("Other links").font(.pilot(.label, weight: .medium)).foregroundStyle(Theme.mutedForeground)
                    Text("\(links.count)").font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Other links, \(links.count)")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded {
                ResponsiveControlsLayout(horizontalSpacing: 6, verticalSpacing: 6) {
                    ForEach(links) { MissionLinkChipView(link: $0, missionId: mission.id).equatable() }
                }
            }
        }
    }

    // MARK: Pieces

    private func groupHeader<Trailing: View>(_ title: String, count: Int,
                                              @ViewBuilder trailing: () -> Trailing = { EmptyView() }) -> some View {
        HStack(spacing: 6) {
            Text(title).font(.pilot(.label, weight: .semibold)).foregroundStyle(Theme.foreground)
                .accessibilityAddTraits(.isHeader)
            CountBadge(count: count)
            Spacer(minLength: 8)
            trailing()
        }
    }

    private func subheader(_ title: String, count: Int, color: Color) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 6, height: 6).accessibilityHidden(true)
            Text(title.uppercased()).font(.pilot(.small, weight: .semibold)).tracking(0.6)
                .foregroundStyle(Theme.mutedForeground)
            Text("\(count)").font(.pilot(.small)).monospacedDigit().foregroundStyle(Theme.faintForeground)
        }
        .padding(.top, 8).padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private func rows(_ links: [MissionLink], list: MissionLinkSlice, noun: String) -> some View {
        let expanded = disclosure.expanded.contains(list)
        let shown = expanded ? links : Array(links.prefix(Self.collapsedLimit))
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, link in
                if index > 0 { HairlineDivider(leading: 32) }
                MissionLinkRow(link: link, missionId: mission.id).equatable()
            }
        }
        if links.count > Self.collapsedLimit {
            Button {
                if expanded { disclosure.expanded.remove(list) } else { disclosure.expanded.insert(list) }
            } label: {
                Text(expanded ? "Show fewer" : "Show all \(links.count)\(noun)")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.leading, 8).padding(.top, 4)
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

    static func remove(_ link: MissionLink, missionId: String) {
        guard let id = link.resourceIds.first, link.resourceIds.count == 1 else { return }
        let client = AppModel.shared.client
        AppModel.shared.missionAction { try await client.deleteMissionResource(missionId, resourceId: id) }
    }

    static func showTask(_ link: MissionLink) {
        guard let taskId = link.taskId else { return }
        AppModel.shared.showMissionTask(taskId)
    }

    /// What VoiceOver reads: the service and number or ID, the title and the task.
    static func accessibilityLabel(_ link: MissionLink) -> String {
        var parts = [link.resource.accessibilityName(pullRequest: link.pullRequest)]
        if !link.title.isEmpty, !parts[0].contains(link.title) { parts.append(link.title) }
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
            Button("Remove Link", role: .destructive) { MissionLinkActions.remove(link, missionId: missionId) }
        }
    }
}

// MARK: Row and chip

/// One Linear item or pull request: mark (with the PR-state dot), identifier, title, task and age.
/// Equatable so rows are not rebuilt when only unrelated state changes.
struct MissionLinkRow: View, Equatable {
    let link: MissionLink
    let missionId: String

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.link == rhs.link && lhs.missionId == rhs.missionId }

    var body: some View {
        HoverRow(verticalPadding: 7) { hovered in
            HStack(spacing: 10) {
                MissionLinkIcon(kind: link.kind, pullRequestState: link.pullRequest?.state, size: 12)
                Text(link.identifier).font(.pilot(.label, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1).frame(width: 64, alignment: .leading)
                Text(link.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                if link.isDraft {
                    Text("Draft").font(.pilot(.small, weight: .medium)).foregroundStyle(Theme.mutedForeground)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(Theme.muted))
                        .fixedSize()
                }
                Spacer(minLength: 8)
                if let number = link.taskNumber {
                    Text("#\(number)").font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                        .fixedSize()
                }
                if link.pullRequest != nil {
                    Text(missionRelativeTime(link.age)).font(.pilot(.caption)).monospacedDigit()
                        .foregroundStyle(Theme.faintForeground).lineLimit(1).fixedSize()
                        .frame(minWidth: 28, alignment: .trailing)
                }
                Menu { MissionLinkMenuItems(link: link, missionId: missionId) } label: { PilotSymbol(PilotIcon.more, context: .toolbar) }
                    .menuStyle(.button)
                    .rowIconButtonStyle()
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .revealed(hovered)
                    .accessibilityLabel("Actions for \(link.identifier)")
            }
        }
        .onTapGesture { MissionLinkActions.open(link) }
        .contextMenu { MissionLinkMenuItems(link: link, missionId: missionId) }
        .help(MissionLinkActions.help(link))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MissionLinkActions.accessibilityLabel(link))
        .accessibilityAddTraits(.isLink)
        .accessibilityAction { MissionLinkActions.open(link) }
        .accessibilityAction(named: "Show task") { MissionLinkActions.showTask(link) }
    }
}

/// A Slack thread, GitHub issue, plain URL or pull request of unknown state, as a small outlined chip.
struct MissionLinkChipView: View, Equatable {
    let link: MissionLink
    let missionId: String

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.link == rhs.link && lhs.missionId == rhs.missionId }

    var body: some View {
        HStack(spacing: 5) {
            MissionLinkIcon(kind: link.kind, size: 10)
            Text(link.chipTitle).lineLimit(1)
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
        .padding(.leading, 7).padding(.trailing, 9).padding(.vertical, 3)
        .background(Capsule().strokeBorder(Theme.border))
        .frame(maxWidth: 260)
        .contentShape(Capsule())
        .onTapGesture { MissionLinkActions.open(link) }
        .contextMenu { MissionLinkMenuItems(link: link, missionId: missionId) }
        .help(MissionLinkActions.help(link))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MissionLinkActions.accessibilityLabel(link))
        .accessibilityAddTraits(.isLink)
        .accessibilityAction { MissionLinkActions.open(link) }
        .accessibilityAction(named: "Show task") { MissionLinkActions.showTask(link) }
    }
}

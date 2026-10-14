import Foundation

/// What a project's Overview lists from its dashboard, kept apart from views so it can be tested.
///
/// Up next leads the page: the project's top Inbox rows, Needs you first, then pull requests ready to merge, with
/// the Inbox's own count behind "Open Inbox (N)". A ready pull request is listed only while its chat neither works
/// nor needs the user, as pilotd's Inbox and the sidebar's Ready to merge group do, so each chat appears once.
/// Pull requests then lists only the open ones still waiting on checks, review or a fix.
public struct ProjectOverview: Equatable, Sendable {
    /// Rows Up next shows before "Open Inbox".
    public static let upNextLimit = 3

    public let upNext: [ProjectOverviewRow]
    /// The project's Needs you and Ready to merge rows, as the Inbox filtered to the project lists them.
    public let inboxTotal: Int
    /// Open and draft pull requests that are not ready to merge, in dashboard order.
    public let pullRequests: [DashboardPullRequest]
    /// Every such pull request, including those past the dashboard's section limit.
    public let pullRequestTotal: Int

    public init(_ dashboard: ProjectDashboard, upNextLimit: Int = ProjectOverview.upNextLimit) {
        var busy = Set(dashboard.working.items.map(\.sessionId))
        for item in dashboard.needsYou.items where item.kind != .scheduledFailed {
            // A failed schedule names the chat it targets; that chat is not waiting on the user.
            if let sessionId = item.sessionId { busy.insert(sessionId) }
        }
        let ready = dashboard.pullRequests.items.filter(\.isReady)
        let listed = ready.filter { !busy.contains($0.sessionId) }
        // Ready pull requests past the section limit cannot be checked against busy chats; count them as listed.
        let readyTotal = max(listed.count, dashboard.summary.readyPullRequests - (ready.count - listed.count))
        upNext = Array((dashboard.needsYou.items.map(ProjectOverviewRow.needsYou)
            + listed.map(ProjectOverviewRow.readyToMerge)).prefix(max(0, upNextLimit)))
        inboxTotal = dashboard.needsYou.total + readyTotal
        pullRequests = dashboard.pullRequests.items.filter { !$0.isReady }
        pullRequestTotal = max(pullRequests.count,
                               dashboard.summary.openPullRequests - dashboard.summary.readyPullRequests)
    }

    /// "Open Inbox (5)", or "Open Inbox" when nothing waits.
    public var inboxLinkTitle: String {
        inboxTotal > 0 ? "Open Inbox (\(inboxTotal))" : "Open Inbox"
    }
}

/// One Up next row: something that needs the user, or a pull request ready to merge.
public enum ProjectOverviewRow: Identifiable, Equatable, Sendable {
    case needsYou(DashboardNeedsYouItem)
    case readyToMerge(DashboardPullRequest)

    public var id: String {
        switch self {
        case let .needsYou(item): "needs:\(item.id)"
        case let .readyToMerge(pr): "ready:\(pr.url)"
        }
    }

    /// The row's dithered corner, as in the Inbox.
    public var signal: SessionSignal {
        switch self {
        case let .needsYou(item): item.signal
        case .readyToMerge: .readyToMerge
        }
    }
}

extension DashboardMission {
    /// The mission's corner from its dashboard counts, for when its live summary is not loaded yet: needs you
    /// over working, quiet otherwise.
    public var signal: SessionSignal? {
        if needsYou > 0 { return .needsYou }
        if working > 0 { return .working }
        return nil
    }
}

extension DashboardRecentItem {
    /// A finished chat's corner from its outcome, for when its live summary is not loaded: failures stay red and
    /// open questions amber; done and stopped chats are quiet.
    public var signal: SessionSignal? {
        switch outcome {
        case .failed: .failed
        case .question: .needsYou
        case .done, .stopped: nil
        }
    }
}


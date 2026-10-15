import CoreGraphics
import Foundation

/// One atomic piece of a list row's second line, such as the project, the reason or a PR badge. Segments are
/// shown whole or not at all: a separator sits only between two shown segments, and a line that runs out of room
/// fades out rather than truncating each piece. Build them with `RowLineSegments` and lay them out with
/// `RowLineArrangement`, so the sidebar, Home, the Inbox and Overview read the same way.
public struct RowLineSegment: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable {
        /// The chat's project, in lists that mix projects. Never dropped there: it always comes first.
        case project(String)
        /// "Ask · <source>" for a read-only Ask chat. One unit, though it reads with a dot.
        case ask(source: String)
        /// The amber "Coordinator" mark of a mission coordinator. Its state follows as `.reason`.
        case coordinator
        /// The row's Needs you reason, a coordinator's state or a working chat's mode, in its own wording.
        case reason(String)
        /// One of the chat's pull requests, linked to the browser.
        case pullRequest(SessionPullRequest, stale: Bool)
        /// A dashboard pull request shown in place of the chat's (ready to merge rows).
        case dashboardPullRequest(DashboardPullRequest)
        /// The PR lookup failed and nothing is cached.
        case pullRequestUnavailable
        /// The mission icon and name, one unit. `id` opens the mission where the row allows it.
        case mission(id: String?, title: String)
        case branch(String)
        /// Any other quiet text, such as a project's counts or a mission's progress.
        case text(String)
    }

    public let kind: Kind

    public init(_ kind: Kind) { self.kind = kind }

    public var id: String {
        switch kind {
        case let .project(name): "project:\(name)"
        case let .ask(source): "ask:\(source)"
        case .coordinator: "coordinator"
        case let .reason(text): "reason:\(text)"
        case let .pullRequest(pr, _): "pr:\(pr.url)"
        case let .dashboardPullRequest(pr): "pr:\(pr.url)"
        case .pullRequestUnavailable: "pr-unavailable"
        case let .mission(id, title): "mission:\(id ?? title)"
        case let .branch(name): "branch:\(name)"
        case let .text(text): "text:\(text)"
        }
    }

    /// The segment as words, for row accessibility labels and tooltips. Every segment keeps its full text here,
    /// including the ones the line had no room to show.
    public var accessibilityText: String {
        switch kind {
        case let .project(name): name
        case let .ask(source): "Ask, \(source)"
        case .coordinator: "Coordinator"
        case let .reason(text): text
        case let .pullRequest(pr, stale): "Pull request \(pr.number)\(stale ? ", last known" : "")"
        case let .dashboardPullRequest(pr): "Pull request \(pr.number)"
        case .pullRequestUnavailable: "Pull request lookup unavailable"
        case let .mission(_, title): "Mission \(title)"
        case let .branch(name): "Branch \(name)"
        case let .text(text): text
        }
    }
}

extension Array where Element == RowLineSegment {
    /// Every segment in words, for a row's accessibility label.
    public var accessibilityText: String { map(\.accessibilityText).joined(separator: ", ") }
}

/// The segments of a chat row's second line, in the order they are shown and kept: the project (only when the
/// list mixes projects), what kind of chat it is (Ask or Coordinator), its reason, its pull requests, its mission
/// and finally its branch. When the line runs out of room the last ones fade and go first: the branch, then the
/// mission, then the extra pull requests. The reason keeps the row's own wording.
public enum RowLineSegments {
    /// - Parameters:
    ///   - coordinatorDetail: non-nil for a coordinator, whose line is "Coordinator" and this state instead.
    ///   - pullRequest: a dashboard PR shown in place of the chat's own badges, with its branch.
    public static func session(
        _ session: SessionSummary?, projectName: String? = nil, missionId: String? = nil, missionTitle: String? = nil,
        reason: String? = nil, branch: String? = nil, coordinatorDetail: String? = nil,
        pullRequest: DashboardPullRequest? = nil
    ) -> [RowLineSegment] {
        var segments: [RowLineSegment] = []
        if let projectName, !projectName.isEmpty { segments.append(RowLineSegment(.project(projectName))) }
        if let coordinatorDetail {
            segments.append(RowLineSegment(.coordinator))
            if !coordinatorDetail.isEmpty { segments.append(RowLineSegment(.reason(coordinatorDetail))) }
            return segments
        }
        let isAsk = session?.isAsk == true
        if let session, isAsk { segments.append(RowLineSegment(.ask(source: session.sourceLabel))) }
        if let reason, !reason.isEmpty { segments.append(RowLineSegment(.reason(reason))) }
        var shownBranch = branch
        if let pullRequest {
            segments.append(RowLineSegment(.dashboardPullRequest(pullRequest)))
            shownBranch = pullRequest.branch
        } else if let session, !isAsk {
            let prs = session.linkedPullRequests
            for pr in prs { segments.append(RowLineSegment(.pullRequest(pr, stale: session.pullRequestIsStale))) }
            if prs.isEmpty, session.pullRequestError != nil { segments.append(RowLineSegment(.pullRequestUnavailable)) }
        }
        if let missionTitle, !missionTitle.isEmpty {
            segments.append(RowLineSegment(.mission(id: missionId, title: missionTitle)))
        }
        if !isAsk, let shownBranch, !shownBranch.isEmpty { segments.append(RowLineSegment(.branch(shownBranch))) }
        return segments
    }

    /// "Pull requests: #6555, #6554" for a row's tooltip, so every PR stays readable when the line fades.
    public static func pullRequestSummary(_ session: SessionSummary) -> String? {
        let numbers = session.linkedPullRequests.map { "#\($0.number)" }
        guard !numbers.isEmpty else { return nil }
        return (numbers.count == 1 ? "Pull request " : "Pull requests: ") + numbers.joined(separator: ", ")
    }
}

/// Where each segment of a row line goes, from the segments' natural widths alone, so a row never measures
/// itself in a feedback loop. Segments keep their order and are never truncated one by one:
///
/// - The first segment always shows, at the start of the first line.
/// - Each later segment follows a separator on the same line when it ends before the fade.
/// - Otherwise it starts the next line, without a separator, while lines remain.
/// - On the last line it shows partly, fading out at the trailing edge, when at least `minimumVisible` of it
///   comes before the fade; then every later segment is left out, so no separator is ever orphaned.
public enum RowLineArrangement {
    public struct Placement: Equatable, Sendable {
        public var line: Int
        public var x: CGFloat
        /// Where the separator before this segment goes, on the same line. Nil at the start of a line.
        public var separatorX: CGFloat?

        public init(line: Int, x: CGFloat, separatorX: CGFloat? = nil) {
            self.line = line
            self.x = x
            self.separatorX = separatorX
        }
    }

    /// Width of the trailing fade. Text only enters it when the line has more than fits.
    public static let fade: CGFloat = 16
    /// How much of a segment must come before the fade for it to show at all.
    public static let minimumVisible: CGFloat = 12

    /// One placement per segment, nil for segments left out.
    public static func arrange(widths: [CGFloat], separatorWidth: CGFloat, spacing: CGFloat, available: CGFloat,
                               maxLines: Int = 1, fade: CGFloat = RowLineArrangement.fade,
                               minimumVisible: CGFloat = RowLineArrangement.minimumVisible) -> [Placement?] {
        let limit = available - fade
        let lastLine = max(1, maxLines) - 1
        var placements: [Placement?] = []
        placements.reserveCapacity(widths.count)
        var line = 0
        var end: CGFloat = 0
        var stopped = false
        for (index, width) in widths.enumerated() {
            if stopped {
                placements.append(nil)
                continue
            }
            if index == 0 {
                placements.append(Placement(line: 0, x: 0))
                end = width
                continue
            }
            let separatorX = end + spacing
            let x = separatorX + separatorWidth + spacing
            if x + width <= limit {
                placements.append(Placement(line: line, x: x, separatorX: separatorX))
                end = x + width
            } else if line < lastLine {
                line += 1
                placements.append(Placement(line: line, x: 0))
                end = width
            } else {
                placements.append(x + minimumVisible <= limit ? Placement(line: line, x: x, separatorX: separatorX) : nil)
                stopped = true
            }
        }
        return placements
    }

    /// Lines used by `placements`, at least one.
    public static func lineCount(_ placements: [Placement?]) -> Int {
        (placements.compactMap { $0?.line }.max() ?? 0) + 1
    }

    /// The whole line's width with nothing left out, as it would sit on one unbounded line.
    public static func naturalWidth(widths: [CGFloat], separatorWidth: CGFloat, spacing: CGFloat) -> CGFloat {
        guard !widths.isEmpty else { return 0 }
        return widths.reduce(0, +) + CGFloat(widths.count - 1) * (separatorWidth + 2 * spacing)
    }
}

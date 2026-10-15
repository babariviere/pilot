import CoreGraphics
import Foundation
import PilotCore
import Testing

private func pr(_ number: Int, branch: String? = nil) -> SessionPullRequest {
    SessionPullRequest(number: number, url: "https://github.com/example/repo/pull/\(number)", title: "Change \(number)",
                       state: .open, checkedAt: 1, branch: branch)
}

private func chat(branch: String? = "fix/rows", prs: [SessionPullRequest] = [], mode: ChatMode? = nil,
                  pullRequestError: String? = nil, missionId: String? = nil) -> SessionSummary {
    SessionSummary(id: "chat", title: "Chat", cwd: "/repo", branch: branch, createdAt: 1, updatedAt: 1, state: "idle",
                   pullRequestError: pullRequestError, pullRequests: prs.isEmpty ? nil : prs, mode: mode,
                   sourceBranch: mode == .ask ? "main" : nil, missionId: missionId)
}

private func kinds(_ segments: [RowLineSegment]) -> [String] {
    segments.map { segment in
        switch segment.kind {
        case .project: "project"
        case .ask: "ask"
        case .coordinator: "coordinator"
        case .reason: "reason"
        case let .pullRequest(pr, _): "#\(pr.number)"
        case let .dashboardPullRequest(pr): "#\(pr.number)"
        case .pullRequestUnavailable: "pr?"
        case .mission: "mission"
        case .branch: "branch"
        case .text: "text"
        case .draft: "draft"
        }
    }
}

@Test func chatSegmentsKeepOneOrderFromProjectToBranch() {
    let session = chat(prs: [pr(6555), pr(6554)], missionId: "m")
    let segments = RowLineSegments.session(session, projectName: "phishing", missionId: "m",
                                           missionTitle: "New /v2/scenario rollout", reason: "New result",
                                           branch: "feat/scenario")
    #expect(kinds(segments) == ["project", "reason", "#6555", "#6554", "mission", "branch"])
    #expect(segments.last?.kind == .branch("feat/scenario"))
    // The mission is one unit: its icon never survives without its name.
    #expect(segments.contains { $0.kind == .mission(id: "m", title: "New /v2/scenario rollout") })
    #expect(segments.accessibilityText ==
        "phishing, New result, Pull request 6555, Pull request 6554, Mission New /v2/scenario rollout, Branch feat/scenario")
}

@Test func focusedListsLeaveOutTheProjectAndEmptyPieces() {
    let segments = RowLineSegments.session(chat(branch: nil), projectName: nil, missionTitle: "", reason: "", branch: "")
    #expect(segments.isEmpty)
    #expect(kinds(RowLineSegments.session(chat(), branch: "fix/rows")) == ["branch"])
}

@Test func askChatsReadAskAndSourceWithoutBranchOrPullRequests() {
    let session = chat(branch: "ignored", prs: [pr(1)], mode: .ask)
    let segments = RowLineSegments.session(session, projectName: "pilot", reason: "Asks: which file?", branch: "ignored")
    #expect(kinds(segments) == ["project", "ask", "reason"])
    #expect(segments[1].kind == .ask(source: "origin/main"))
}

@Test func coordinatorsReadCoordinatorThenTheirStateOnly() {
    let segments = RowLineSegments.session(chat(prs: [pr(1)]), projectName: "pilot", missionTitle: "Redesign",
                                           reason: "ignored", branch: "main", coordinatorDetail: "New result")
    #expect(kinds(segments) == ["project", "coordinator", "reason"])
    #expect(segments.accessibilityText == "pilot, Coordinator, New result")
}

@Test func dashboardPullRequestReplacesTheChatsBadgesAndBringsItsBranch() {
    let ready = DashboardPullRequest(number: 441, url: "https://github.com/example/repo/pull/441", title: "Ready",
                                     branch: "feat/ready", sessionId: "chat", sessionTitle: "Chat", checkedAt: 1)
    let segments = RowLineSegments.session(chat(prs: [pr(1)]), branch: "fix/rows", pullRequest: ready)
    #expect(kinds(segments) == ["#441", "branch"])
    #expect(segments.last?.kind == .branch("feat/ready"))
}

@Test func failedPullRequestLookupWithoutCacheShowsOneWarning() {
    let segments = RowLineSegments.session(chat(pullRequestError: "offline"), branch: "fix/rows")
    #expect(kinds(segments) == ["pr?", "branch"])
    #expect(RowLineSegments.pullRequestSummary(chat(prs: [pr(6555), pr(6554)])) == "Pull requests: #6555, #6554")
    #expect(RowLineSegments.pullRequestSummary(chat(prs: [pr(7)])) == "Pull request #7")
    #expect(RowLineSegments.pullRequestSummary(chat()) == nil)
}

// MARK: - Drafts

@Test func aDraftReplacesTheDetailsAfterTheProject() throws {
    let session = chat(prs: [pr(6555)], missionId: "m")
    let details = RowLineSegments.session(session, projectName: "pilot", missionId: "m", missionTitle: "Redesign",
                                          reason: "New result", branch: "feat/rows")
    let draft = try #require(RowDraft(text: "  Can you also   check\tthe sidebar?\nSecond line  "))
    let shown = RowLineSegments.shown(details, draft: draft)
    #expect(kinds(shown) == ["project", "draft"])
    #expect(draft.preview == "\u{201C}Can you also check the sidebar?\u{201D}")
    // Focused lists have no project: the draft is the whole line.
    #expect(kinds(RowLineSegments.shown(RowLineSegments.session(session, branch: "feat/rows"), draft: draft)) == ["draft"])
    // No draft leaves the line as it was.
    #expect(RowLineSegments.shown(details, draft: nil) == details)
}

@Test func whitespaceOnlyDraftsAreEmpty() {
    #expect(RowDraft(text: "") == nil)
    #expect(RowDraft(text: "  \n\t ") == nil)
    #expect(RowDraft(text: " \n ", imageCount: 0) == nil)
}

@Test func imageOnlyDraftsNameTheirImages() throws {
    let one = try #require(RowDraft(text: "  ", imageCount: 1))
    #expect(one.preview == "Image draft")
    #expect(one.accessibilityText == "Unsent draft: 1 image")
    let three = try #require(RowDraft(text: "", imageCount: 3))
    #expect(three.preview == "3 images")
    #expect(three.accessibilityText == "Unsent draft: 3 images")
    let mixed = try #require(RowDraft(text: "Look at this", imageCount: 2))
    #expect(mixed.preview == "\u{201C}Look at this\u{201D}")
    #expect(mixed.accessibilityText == "Unsent draft: Look at this (with 2 images)")
}

@Test func draftsReadInFullForVoiceOverAndClampedInTooltips() throws {
    let text = (1...6).map { "Line \($0)" }.joined(separator: "\n")
    let draft = try #require(RowDraft(text: text))
    let details = RowLineSegments.session(chat(), projectName: "pilot", reason: "New result", branch: "fix/rows")
    let described = RowLineSegments.described(details, draft: draft)
    #expect(kinds(described) == ["project", "draft", "reason", "branch"])
    #expect(described.accessibilityText ==
        "pilot, Unsent draft: \(text), New result, Branch fix/rows")
    #expect(draft.help == "Unsent draft: Line 1\nLine 2\nLine 3\nLine 4…")
    let long = try #require(RowDraft(text: String(repeating: "a", count: 400)))
    #expect(long.help == "Unsent draft: " + String(repeating: "a", count: RowDraft.helpCharacterLimit) + "…")
    #expect(RowLineSegments.described(details, draft: nil) == details)
}

@Test func longDraftsAreBoundedAndFadeAtTheTrailingEdge() throws {
    let draft = try #require(RowDraft(text: String(repeating: "word ", count: 100)))
    // The row keeps a bounded preview; the fade, not an ellipsis, ends it in any list.
    #expect(draft.preview.count <= RowDraft.previewLimit + 3)
    #expect(draft.preview.hasSuffix("word…\u{201D}"))
    #expect(draft.preview.hasPrefix("\u{201C}word word"))
    // After the project, a draft wider than the row still shows, fading out, on the same line.
    let placements = arrange([50, 600], available: 200)
    #expect(placements == [.init(line: 0, x: 0), .init(line: 0, x: 61, separatorX: 54)])
    // Alone (a focused list), it starts the line and fades the same way.
    #expect(arrange([600], available: 200) == [.init(line: 0, x: 0)])
}

// MARK: - Arrangement

private let separator: CGFloat = 3
private let spacing: CGFloat = 4

private func arrange(_ widths: [CGFloat], available: CGFloat, lines: Int = 1) -> [RowLineArrangement.Placement?] {
    RowLineArrangement.arrange(widths: widths, separatorWidth: separator, spacing: spacing, available: available,
                               maxLines: lines, fade: 16, minimumVisible: 12)
}

@Test func everythingFitsWithASeparatorBetweenEachPair() {
    let placements = arrange([40, 30, 20], available: 200)
    #expect(placements == [
        .init(line: 0, x: 0),
        .init(line: 0, x: 51, separatorX: 44),
        .init(line: 0, x: 92, separatorX: 85),
    ])
    #expect(RowLineArrangement.lineCount(placements) == 1)
    #expect(RowLineArrangement.naturalWidth(widths: [40, 30, 20], separatorWidth: separator, spacing: spacing) == 112)
}

@Test func overflowFadesTheFirstSegmentThatDoesNotFitAndDropsTheRest() {
    // The limit is 120 - 16 = 104. The second segment starts at 51 and ends at 131: it shows, fading.
    let placements = arrange([40, 80, 20, 10], available: 120)
    #expect(placements[0] != nil)
    #expect(placements[1] == .init(line: 0, x: 51, separatorX: 44))
    #expect(placements[2] == nil)
    #expect(placements[3] == nil)
}

@Test func aSegmentWithTooLittleRoomBeforeTheFadeIsDroppedWithItsSeparator() {
    // The second segment ends at 101, before the fade at 104. The third would start at 101 + 11 = 112, past the
    // limit: dropped, and no separator is left hanging.
    let fits = arrange([70, 20, 30], available: 120)
    #expect(fits[1] == .init(line: 0, x: 81, separatorX: 74))
    #expect(fits[2] == nil)
    // Starting 4 pt before the limit is less than the 12 pt minimum: dropped too.
    let tight = arrange([89, 30], available: 120)
    #expect(tight[1] == nil)
}

@Test func theFirstSegmentAlwaysShowsEvenWhenItAloneOverflows() {
    let placements = arrange([300, 20], available: 120)
    #expect(placements[0] == .init(line: 0, x: 0))
    #expect(placements[1] == nil)
    #expect(arrange([], available: 120).isEmpty)
    #expect(RowLineArrangement.lineCount([]) == 1)
}

@Test func widerRowsWrapOnceWithoutALeadingSeparatorThenFade() {
    let placements = arrange([60, 50, 70, 40, 30], available: 140, lines: 2)
    #expect(placements[0] == .init(line: 0, x: 0))
    #expect(placements[1] == .init(line: 0, x: 71, separatorX: 64))
    // The third would end at 202, past the fade at 124: it starts the second line without a separator.
    #expect(placements[2] == .init(line: 1, x: 0))
    #expect(placements[3] == .init(line: 1, x: 81, separatorX: 74))
    // No third line: the last segment has too little room before the fade, so it is left out.
    #expect(placements[4] == nil)
    #expect(RowLineArrangement.lineCount(placements) == 2)
}

@Test func segmentsKeepTheirOrderAndNeverSkipAheadToAShorterOne() {
    // A short last segment that would fit is still left out once an earlier one was.
    let placements = arrange([50, 200, 5], available: 160)
    #expect(placements[1] != nil)
    #expect(placements[2] == nil)
    let placed = placements.compactMap { $0 }
    #expect(zip(placed, placed.dropFirst()).allSatisfy { $0.line < $1.line || $0.x < $1.x })
}

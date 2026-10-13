import Foundation
import Testing
@testable import PilotCore

private func resource(
    _ id: String, _ url: String, _ kind: MissionResourceKind, task: String? = nil, title: String? = nil,
    externalId: String? = nil, pr: SessionPullRequest? = nil, at: Double = 1
) -> MissionResource {
    MissionResource(id: id, taskId: task, pullRequest: pr, url: url, title: title, kind: kind, externalId: externalId,
                    addedBySessionId: nil, createdAt: at)
}

private func pr(_ number: Int, _ state: PullRequestState, merged: Double? = nil, title: String? = nil,
                checked: Double = 10) -> SessionPullRequest {
    SessionPullRequest(number: number, url: "https://github.com/o/r/pull/\(number)", title: title ?? "PR \(number)",
                       state: state, checkedAt: checked, mergedAt: merged)
}

private func prResource(_ id: String, _ number: Int, _ state: PullRequestState?, task: String? = nil,
                        merged: Double? = nil, at: Double = 1) -> MissionResource {
    resource(id, "https://github.com/o/r/pull/\(number)", .githubPullRequest, task: task, externalId: "o/r#\(number)",
             pr: state.map { pr(number, $0, merged: merged) }, at: at)
}

private func groups(_ resources: [MissionResource], tasks: [String: Int] = [:],
                    reported: [String: SessionPullRequest] = [:]) -> MissionLinkGroups {
    MissionLinkGroups(MissionLinksInput(resources: resources, taskNumbers: tasks, reportedPullRequests: reported))
}

@Test func linksSplitByProviderAndPullRequestState() {
    let result = groups([
        resource("l1", "https://linear.app/a/issue/ENG-1/x", .linearIssue, externalId: "ENG-1"),
        prResource("p1", 1, .open),
        prResource("p2", 2, .draft),
        prResource("p3", 3, .merged, merged: 5),
        prResource("p4", 4, .closed),
        prResource("p5", 5, nil),
        resource("s1", "https://acme.slack.com/archives/C1/p1111111111111111", .slackThread),
        resource("u1", "https://example.com/rfc", .url, title: "RFC"),
        resource("g1", "https://github.com/o/r/issues/31", .githubIssue, externalId: "o/r#31"),
    ])
    #expect(result.linear.map(\.id) == ["l1"])
    #expect(Set(result.open.map(\.id)) == ["p1", "p2"])
    #expect(result.merged.map(\.id) == ["p3"])
    #expect(result.closed.map(\.id) == ["p4"])
    // A pull request without any known state is not guessed to be open.
    #expect(Set(result.other.map(\.id)) == ["p5", "s1", "u1", "g1"])
    #expect(result.pullRequestCount == 3)
    #expect(result.open.first { $0.id == "p2" }?.isDraft == true)
    #expect(!result.isEmpty)
}

@Test func emptyResourcesGiveEmptyGroups() {
    let result = groups([])
    #expect(result.isEmpty)
    #expect(!result.hasPullRequests)
    #expect(result.pullRequestCount == 0)
}

@Test func linearProjectsComeBeforeIssues() {
    let result = groups([
        resource("i1", "https://linear.app/a/issue/ENG-1", .linearIssue, externalId: "ENG-1", at: 1),
        resource("p1", "https://linear.app/a/project/api-v2-0123456789ab", .linearProject, title: "API v2", at: 5),
        resource("i2", "https://linear.app/a/issue/ENG-2", .linearIssue, externalId: "ENG-2", at: 2),
    ])
    #expect(result.linear.map(\.id) == ["p1", "i1", "i2"])
    #expect(result.linear[0].identifier == "Project")
    #expect(result.linear[0].title == "API v2")
}

@Test func linearTitlesUseSavedTitlesThenTheURLSlug() {
    let result = groups([
        resource("i1", "https://linear.app/a/issue/ENG-1/restack-dependent-prs", .linearIssue, externalId: "ENG-1"),
        resource("i2", "https://linear.app/a/issue/ENG-2/ignored-slug", .linearIssue, title: "Saved title", externalId: "ENG-2"),
        resource("i3", "https://linear.app/a/issue/ENG-3", .linearIssue, externalId: "ENG-3"),
        resource("p1", "https://linear.app/a/project/api-v2-0123456789ab", .linearProject, externalId: "api-v2-0123456789ab"),
    ])
    let byId = Dictionary(uniqueKeysWithValues: result.linear.map { ($0.id, $0) })
    #expect(byId["i1"]?.identifier == "ENG-1")
    #expect(byId["i1"]?.title == "Restack dependent prs")
    #expect(byId["i2"]?.title == "Saved title")
    #expect(byId["i3"]?.title == "")
    #expect(byId["p1"]?.title == "Api v2")
}

@Test func pullRequestsAreSortedNewestFirst() {
    let result = groups([
        prResource("a", 10, .open), prResource("b", 12, .draft), prResource("c", 11, .open),
        prResource("m1", 1, .merged, merged: 1_000), prResource("m2", 2, .merged, merged: 3_000),
        prResource("m3", 3, .merged, merged: 2_000),
    ])
    #expect(result.open.map(\.id) == ["b", "c", "a"])
    #expect(result.merged.map(\.id) == ["m2", "m3", "m1"])
}

@Test func duplicateURLsCollapseAndKeepTheLowestTask() {
    let tasks = ["t1": 3, "t2": 7]
    let result = groups([
        prResource("mission", 5, .open),
        prResource("second", 5, .open, task: "t2"),
        prResource("first", 5, .open, task: "t1"),
        resource("spelled", "HTTPS://GitHub.com/o/r/pull/5/", .githubPullRequest, externalId: "o/r#5"),
    ], tasks: tasks)
    #expect(result.open.count == 1)
    let link = result.open[0]
    #expect(link.taskId == "t1")
    #expect(link.taskNumber == 3)
    #expect(Set(link.resourceIds) == ["mission", "second", "first", "spelled"])
}

@Test func missionLinkWithoutTasksHasNoTaskNumber() {
    let link = groups([resource("l", "https://linear.app/a/issue/ENG-9", .linearIssue, externalId: "ENG-9")]).linear[0]
    #expect(link.taskId == nil)
    #expect(link.taskNumber == nil)
    #expect(link.resourceIds == ["l"])
}

@Test func pullRequestStateComesFromTheSavedLinkThenChatReports() {
    let url = "https://github.com/o/r/pull/9"
    let unknown = resource("r", url, .githubPullRequest, externalId: "o/r#9")
    #expect(groups([unknown]).other.map(\.id) == ["r"])
    let reported = groups([unknown], reported: [url: pr(9, .merged, merged: 3, title: "Reported")])
    #expect(reported.merged.first?.title == "Reported")
    // Saved state wins over a chat's report.
    let saved = resource("s", url, .githubPullRequest, externalId: "o/r#9", pr: pr(9, .open))
    #expect(groups([saved], reported: [url: pr(9, .merged)]).open.map(\.id) == ["s"])
    #expect(MissionLinksInput(resources: [unknown, saved], taskNumbers: [:]).unresolvedPullRequestURLs == [url])
}

@Test func pullRequestRowsShowNumberTitleAndAge() {
    let merged = groups([prResource("m", 7, .merged, merged: 9_000, at: 2)]).merged[0]
    #expect(merged.identifier == "#7")
    #expect(merged.title == "PR 7")
    #expect(merged.age == 9_000)
    let open = groups([prResource("o", 8, .open, at: 4)]).open[0]
    #expect(open.age == 4)
}

@Test func otherLinksGetReadableChipTitles() {
    let result = groups([
        resource("g", "https://github.com/o/r/issues/31", .githubIssue, externalId: "o/r#31"),
        resource("s", "https://acme.slack.com/archives/C1/p1111111111111111", .slackThread),
        resource("u", "https://gist.github.com/x", .url, title: "OptChat gist"),
        resource("h", "https://docs.example.com/stack", .url),
        prResource("p", 96, nil),
    ])
    let chips = Dictionary(uniqueKeysWithValues: result.other.map { ($0.id, $0.chipTitle) })
    #expect(chips["g"] == "Issue #31")
    #expect(chips["s"] == "Slack thread")
    #expect(chips["u"] == "OptChat gist")
    #expect(chips["h"] == "docs.example.com")
    #expect(chips["p"] == "#96")
}

@Test func largeListsGroupCorrectly() {
    var resources: [MissionResource] = []
    for number in 1...400 {
        resources.append(prResource("p\(number)", number, number % 9 == 0 ? .open : .merged, task: "t\(number % 40)",
                                    merged: Double(number)))
    }
    let tasks = Dictionary(uniqueKeysWithValues: (0..<40).map { ("t\($0)", $0 + 1) })
    let result = groups(resources, tasks: tasks)
    #expect(result.open.count == 44)
    #expect(result.merged.count == 356)
    #expect(result.merged.first?.pullRequest?.number == 400)
}

import Foundation
import Testing
@testable import PilotCore

@Test func inboxDecodesProjectRowsAndOptionalSources() throws {
    let inbox = try JSONDecoder().decode(Inbox.self, from: Data(#"""
    {
      "needsYou": {"total": 3, "items": [
        {"kind":"failed","id":"session:s1","title":"Retry webhook queue","sessionId":"s1","outcome":"failed","at":10,"projectId":"p1"},
        {"kind":"question","id":"mission:m1","title":"Billing export","missionId":"m1","count":1,"at":9,"projectId":"p2"}
      ]},
      "slack": {"total": 1, "hidden": [{"label":"Product","count":2}], "items": [
        {"id":"t1","projectId":"p1","kind":"slack","externalId":"C1/1.000001","title":"Checkout fails","url":"https://example.com/t1",
         "status":"open","metadata":{"severity":"high"},"dismissed":false,"createdAt":1,"updatedAt":2}
      ]}
    }
    """#.utf8))
    #expect(inbox.needsYou.hiddenCount == 1)
    #expect(inbox.needsYou.items.map(\.projectId) == ["p1", "p2"])
    #expect(inbox.needsYou.items[0].item.kind == .failed)
    #expect(inbox.needsYou.items[0].id == "p1:session:s1")
    #expect(inbox.linear == nil)
    #expect(inbox.readyToMerge.total == 0, "older daemons send no Ready to merge section")
    #expect(inbox.slack?.items.first?.kind == .slack)
    #expect(!inbox.isEmpty)
    #expect(try JSONDecoder().decode(Inbox.self, from: JSONEncoder().encode(inbox)) == inbox)
    #expect(Inbox().isEmpty)
}

@Test func inboxDecodesReadyToMergeRowsWithTheirProject() throws {
    let inbox = try JSONDecoder().decode(Inbox.self, from: Data(#"""
    {
      "needsYou": {"total": 0, "items": []},
      "readyToMerge": {"total": 2, "items": [
        {"number":441,"url":"https://github.com/o/r/pull/441","title":"Inbox filter","state":"open","branch":"feat/inbox",
         "sessionId":"s1","sessionTitle":"Inbox","missionId":"m1","checkedAt":5,"readiness":{"state":"ready","reasons":[]},
         "projectId":"p2"}
      ]}
    }
    """#.utf8))
    let row = try #require(inbox.readyToMerge.items.first)
    #expect(row.projectId == "p2" && row.id == "p2:https://github.com/o/r/pull/441")
    #expect(row.pullRequest.isReady && row.pullRequest.branch == "feat/inbox" && row.pullRequest.missionId == "m1")
    #expect(inbox.readyToMerge.hiddenCount == 1)
    #expect(!inbox.isEmpty, "a ready pull request alone keeps the Inbox from reading as clear")
    #expect(try JSONDecoder().decode(Inbox.self, from: JSONEncoder().encode(inbox)) == inbox)
}

@Test func readyToMergeKeyFollowsReadyOpenPullRequestsOnly() {
    func chat(_ id: String, _ state: PullRequestState, _ readiness: PullRequestReadiness.State?, archived: Bool = false) -> SessionSummary {
        let pr = SessionPullRequest(number: 1, url: "https://github.com/o/r/pull/\(id)", title: "t", state: state, checkedAt: 1,
                                    readiness: readiness.map { PullRequestReadiness(state: $0, reasons: [], checkedAt: 1) })
        return SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle",
                              pullRequest: pr, archivedAt: archived ? 1 : nil)
    }
    let key = InboxText.readyToMergeKey([chat("a", .open, .ready), chat("b", .open, .pending), chat("c", .draft, .ready),
                                         chat("d", .merged, .ready), chat("e", .open, .ready, archived: true)])
    #expect(key == ["a https://github.com/o/r/pull/a"])
}

@Test func inboxFilterAndClearStateNameTheProject() {
    let project = Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)
    #expect(InboxText.filterTitle(nil) == "All projects")
    #expect(InboxText.filterTitle(project) == "pilot")
    #expect(InboxText.clearMessage(projectName: "pilot").hasSuffix("in pilot appear here."))
    #expect(InboxText.clearMessage(projectName: nil).contains("pull requests ready to merge"))
}

@Test func dashboardCountsReadTrackedItemsWhenPresent() throws {
    let counts = try JSONDecoder().decode(ProjectDashboardCounts.self, from: Data(#"""
    {"projects":{"p1":{"working":1,"needsYou":2,"tracked":4},"p2":{"working":0,"needsYou":1}}}
    """#.utf8))
    #expect(counts.counts(for: "p1") == ProjectDashboardCount(working: 1, needsYou: 2, tracked: 4))
    #expect(counts.counts(for: "p2").tracked == 0)
    #expect(InboxText.badge(counts.counts(for: "p1")) == 6)
}

@Test func needsYouRowsUseTheSidebarCornerStates() {
    func row(_ kind: DashboardNeedsYouKind) -> DashboardNeedsYouItem {
        DashboardNeedsYouItem(kind: kind, id: kind.rawValue, title: "t", at: 1)
    }
    #expect(row(.failed).signal == .failed)
    #expect(row(.scheduledFailed).signal == .failed)
    #expect(row(.unread).signal == .needsYou)
    #expect(row(.question).signal == .needsYou)
}

@Test func inboxFooterNamesHiddenLabels() {
    #expect(InboxText.hiddenFooter([]) == nil)
    #expect(InboxText.hiddenFooter([InboxHiddenLabel(label: "Product", count: 2, closed: true)])
        == "Closed: 2 Slack messages labelled Product.")
    #expect(InboxText.hiddenFooter([InboxHiddenLabel(label: "Archive", count: 1),
                                    InboxHiddenLabel(label: "Product", count: 2, closed: true)])
        == "Hidden: 1 Slack message labelled Archive. Closed: 2 labelled Product.")
    #expect(InboxText.hiddenFooter([InboxHiddenLabel(label: "Product", count: 1)])
        == "Hidden: 1 Slack message labelled Product.")
    #expect(InboxText.hiddenFooter([InboxHiddenLabel(label: "Product", count: 2), InboxHiddenLabel(label: "Billing", count: 1)])
        == "Hidden: 3 Slack messages labelled Product or Billing.")
    #expect(InboxText.hiddenFooter(["A", "B", "C"].map { InboxHiddenLabel(label: $0, count: 1) })
        == "Hidden: 3 Slack messages labelled A, B or C.")
    #expect(InboxText.capNote(shown: 50, total: 50) == nil)
    #expect(InboxText.capNote(shown: 50, total: 72) == "Showing the first 50 of 72.")
}

@Test func triageLinksEachProjectInScopeThatTracksSlack() {
    let projects = ["p1", "p2", "p3"].map { Project(id: $0, name: "Project \($0)", path: "/tmp/\($0)", createdAt: 1) }
    let source = { (project: String, kind: TrackedKind, configured: Bool) in
        TrackingSource(id: "\(project):\(kind.rawValue)", projectId: project, kind: kind, label: kind.rawValue,
                       configured: configured, status: .ok)
    }
    let sources = [source("p3", .slack, true), source("p1", .slack, true), source("p2", .linear, true),
                   source("p2", .slack, false)]
    // Every project: Slack-tracking projects in the given order, without Linear-only or unconfigured ones.
    #expect(InboxText.triageProjects(projects, sources: sources, scope: nil).map(\.id) == ["p1", "p3"])
    #expect(InboxText.triageProjects(projects, sources: sources, scope: "p3").map(\.id) == ["p3"])
    #expect(InboxText.triageProjects(projects, sources: sources, scope: "p2").isEmpty)
}

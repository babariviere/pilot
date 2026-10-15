import Foundation
import Testing
@testable import PilotCore

@Test func projectDashboardDecodesAndToleratesNewerValues() throws {
    let dashboard = try JSONDecoder().decode(ProjectDashboard.self, from: Data(#"""
    {
      "projectId": "p1",
      "summary": {"chats": 4, "working": 1, "needsYou": 3, "openPullRequests": 2, "readyPullRequests": 1, "activeMissions": 1},
      "needsYou": {"total": 7, "items": [
        {"kind":"failed","id":"session:s1","title":"Fix build","sessionId":"s1","outcome":"failed","reason":"Out of credits","at":10},
        {"kind":"question","id":"mission:m1","title":"API v2","missionId":"m1","count":2,"at":9},
        {"kind":"scheduled_failed","id":"scheduled:x","title":"Nightly","scheduledId":"x","reason":"Project is gone","at":8},
        {"kind":"from_the_future","id":"session:s2","title":"Odd","sessionId":"s2","outcome":"done","at":7}
      ]},
      "working": {"total": 1, "items": [
        {"sessionId":"s3","title":"Refactor","state":"starting","mode":"ask","missionId":"m1","missionTitle":"API v2",
         "model":"a/b","branch":"feat/x","pullRequest":{"number":7,"url":"https://github.com/o/r/pull/7","state":"open"},"startedAt":50}
      ]},
      "pullRequests": {"total": 2, "items": [
        {"number":7,"url":"https://github.com/o/r/pull/7","title":"Refactor","state":"open","sessionId":"s3","sessionTitle":"Refactor",
         "checkedAt":60,"readiness":{"state":"ready"}},
        {"number":8,"url":"https://github.com/o/r/pull/8","title":"Draft","state":"draft","branch":"feat/y","sessionId":"s4","sessionTitle":"Draft",
         "checkedAt":61,"readiness":{"state":"blocked","reasons":["failing checks: build"]}}
      ]},
      "missions": {"total": 1, "items": [{"id":"m1","title":"API v2","tasksDone":2,"tasksTotal":5,"working":1,"needsYou":3,"coordinatorSessionId":"s9"}]},
      "scheduled": {"total": 1, "items": [{"id":"x","title":"Plan","kind":"chat","trigger":"on_back","state":"pending"}]},
      "tracked": [{"source":"linear","label":"Linear","status":"sign_in_required","total":0,"items":[]},
                  {"source":"slack","label":"Slack","status":"brand_new","error":"boom","total":9,"items":[{"id":"1","title":"Bug","status":"open"}]}],
      "recent": {"total": 6, "items": [{"sessionId":"s5","title":"Done","outcome":"done","outcomeAt":5,"branch":"b"}]}
    }
    """#.utf8))
    #expect(dashboard.summary.needsYou == 3)
    #expect(dashboard.needsYou.total == 7)
    #expect(dashboard.needsYou.hiddenCount == 3)
    #expect(dashboard.needsYou.items.map(\.kind) == [.failed, .question, .scheduledFailed, .unread])
    #expect(dashboard.needsYou.items[1].count == 2)
    #expect(dashboard.working.items[0].state == .starting)
    #expect(dashboard.working.items[0].mode == .ask)
    #expect(dashboard.working.items[0].pullRequest?.number == 7)
    #expect(dashboard.pullRequests.items[0].isReady)
    #expect(!dashboard.pullRequests.items[1].isReady)
    #expect(dashboard.pullRequests.items[1].readiness?.reasons == ["failing checks: build"])
    #expect(dashboard.missions.items[0].tasksTotal == 5)
    #expect(dashboard.missions.items[0].tasksInReview == 0, "older daemons omit per-status counts")
    #expect(dashboard.missions.items[0].tasksToDo == 3)
    #expect(dashboard.scheduled.items[0].trigger == .onBack)
    #expect(dashboard.tracked.map(\.status) == [.signInRequired, .error])
    #expect(dashboard.tracked[1].total == 9)
    #expect(dashboard.recent.hiddenCount == 5)
    #expect(try JSONDecoder().decode(ProjectDashboard.self, from: JSONEncoder().encode(dashboard)) == dashboard)
}

@Test func emptyProjectDashboardHasNoRowsAndNoPullRequestReadiness() throws {
    let empty = ProjectDashboard(projectId: "p")
    #expect(empty.needsYou.items.isEmpty && empty.tracked.isEmpty)
    #expect(empty.summary.chats == 0)
    let pr = DashboardPullRequest(number: 1, url: "u", title: "t", sessionId: "s", sessionTitle: "c", checkedAt: 1)
    #expect(!pr.isReady)
    #expect(DashboardPullRequest(number: 1, url: "u", title: "t", state: .draft, sessionId: "s", sessionTitle: "c",
                                 checkedAt: 1, readiness: .init(state: .ready)).isReady == false)
}

@Test func dashboardUpdatesDecodeFromTheSocket() throws {
    let counts = try #require(try ServerUpdate.decode(Data(#"{"type":"dashboard.counts","counts":{"projects":{"p1":{"working":2,"needsYou":1}}}}"#.utf8)))
    guard case let .dashboardCounts(value) = counts else { Issue.record("expected counts"); return }
    #expect(value.counts(for: "p1") == ProjectDashboardCount(working: 2, needsYou: 1))
    #expect(value.counts(for: "other") == ProjectDashboardCount())
    let update = try #require(try ServerUpdate.decode(Data(#"""
    {"type":"dashboard","dashboard":{"projectId":"p1","summary":{"chats":0,"working":0,"needsYou":0,"openPullRequests":0,"readyPullRequests":0,"activeMissions":0},
     "needsYou":{"total":0,"items":[]},"working":{"total":0,"items":[]},"pullRequests":{"total":0,"items":[]},
     "missions":{"total":0,"items":[]},"scheduled":{"total":0,"items":[]},"tracked":[],"recent":{"total":0,"items":[]}}}
    """#.utf8)))
    guard case let .dashboard(dashboard) = update else { Issue.record("expected dashboard"); return }
    #expect(dashboard.projectId == "p1")
}

@Test func dashboardMissionDecodesTasksByStatus() throws {
    let mission = try JSONDecoder().decode(DashboardMission.self, from: Data(#"""
    {"id":"m1","title":"API v2","tasksDone":9,"tasksInReview":2,"tasksInProgress":3,"tasksBlocked":1,"tasksTotal":18,
     "working":1,"needsYou":0}
    """#.utf8))
    #expect(mission.tasksDone == 9)
    #expect(mission.tasksInReview == 2)
    #expect(mission.tasksInProgress == 3)
    #expect(mission.tasksBlocked == 1)
    #expect(mission.tasksToDo == 3)
    #expect(try JSONDecoder().decode(DashboardMission.self, from: JSONEncoder().encode(mission)) == mission)
    #expect(DashboardMission(id: "x", title: "X", tasksDone: 5, tasksBlocked: 2, tasksTotal: 4).tasksToDo == 0)
}

@Test func reviewRequestRoundTripsMarks() throws {
    let request = ReviewRequest(marks: [.init(sessionId: "s", outcomeAt: 12)])
    #expect(try JSONDecoder().decode(ReviewRequest.self, from: JSONEncoder().encode(request)) == request)
    #expect(ReviewRequest.maxMarks == 1000)
}

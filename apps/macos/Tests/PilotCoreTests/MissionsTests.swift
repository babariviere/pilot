import Foundation
import Testing
@testable import PilotCore

@Test func taskResourcesDecodeAndWritesCarryTaskId() throws {
    let resource = try JSONDecoder().decode(MissionResource.self, from: Data(#"{"id":"r","taskId":"t","url":"https://github.com/o/r/pull/42","kind":"github.pr","externalId":"o/r#42","createdAt":1}"#.utf8))
    #expect(resource.taskId == "t")
    #expect(resource.badgeTitle == "PR #42")
    let encoded = try JSONEncoder().encode(MissionResourceWrite(url: resource.url, taskId: "t"))
    #expect(String(decoding: encoded, as: UTF8.self).contains(#""taskId":"t""#))
}

@Test func taskResourceDecodesPullRequestState() throws {
    let resource = try JSONDecoder().decode(MissionResource.self, from: Data(#"{"id":"r","taskId":"t","url":"https://github.com/o/r/pull/42","kind":"github.pr","externalId":"o/r#42","createdAt":1,"pullRequest":{"number":42,"url":"https://github.com/o/r/pull/42","title":"PR","state":"merged","checkedAt":2,"mergedAt":2}}"#.utf8))
    #expect(resource.pullRequest?.state == .merged)
    #expect(resource.badgeTitle == "Merged #42")
}

@Test func missionDetailDecodesAndToleratesNewerValues() throws {
    let detail = try JSONDecoder().decode(MissionDetail.self, from: Data(#"""
    {
      "mission": {"id":"m1","projectId":"p1","title":"API v2","goal":"Redesign the API","status":"active",
                  "coordinatorSessionId":"s1","briefRevision":3,"createdAt":1,"updatedAt":2},
      "brief": {"missionId":"m1","revision":3,"markdown":"# Brief","authorSessionId":"s2","createdAt":2},
      "decisions": [{"id":"d1","text":"IDs are opaque strings","createdAt":1,"updatedAt":1}],
      "comments": [{"id":"c1","text":"Cursor or offset?","anchor":"pagination","createdAt":1}],
      "tasks": [
        {"id":"t2","number":2,"title":"Auth","status":"in_progress","order":2,"sessionId":"s2","createdAt":1,"updatedAt":1},
        {"id":"t1","number":1,"title":"Inventory","status":"done","order":1,"createdAt":1,"updatedAt":1},
        {"id":"t3","number":3,"title":"Legacy","status":"dropped","order":3,"createdAt":1,"updatedAt":1},
        {"id":"t4","number":4,"title":"Future","status":"someday","order":4,"createdAt":1,"updatedAt":1}
      ],
      "artifacts": [{"artifactId":"a1","sessionId":"s1","title":"Resource map","kind":"html","linkedAt":1}],
      "resources": [{"id":"r1","url":"https://linear.app/x/issue/ENG-1","kind":"linear.issue","externalId":"ENG-1","createdAt":1},
                    {"id":"r2","url":"https://example.com","kind":"notion.page","createdAt":1}],
      "events": [{"id":7,"kind":"update","text":"Halfway","health":"at_risk","at":3},
                 {"id":6,"kind":"brand_new","text":"?","at":2}]
    }
    """#.utf8))
    #expect(detail.mission.coordinatorSessionId == "s1")
    #expect(!detail.mission.isAutopilot)
    #expect(detail.decisions[0].isUserDecision)
    #expect(detail.comments[0].isOpen)
    #expect(detail.orderedTasks.map(\.number) == [1, 2, 3, 4])
    #expect(detail.tasks[3].status == .todo, "unknown task statuses fall back instead of failing the payload")
    #expect(detail.progress.done == 1)
    #expect(detail.progress.total == 3, "dropped tasks do not count")
    #expect(detail.resources[0].displayTitle == "ENG-1")
    #expect(detail.resources[1].kind == .url)
    #expect(detail.events[0].health == .atRisk)
    #expect(detail.events[1].kind == .update)
}

@Test func taskStatusesRoundTripWithWireNames() throws {
    let encoded = try JSONEncoder().encode(MissionTaskWrite(status: .inReview))
    #expect(String(decoding: encoded, as: UTF8.self).contains(#""in_review""#))
    #expect(MissionTaskStatus.done.isClosed)
    #expect(MissionTaskStatus.dropped.isClosed)
    #expect(!MissionTaskStatus.blocked.isClosed)
}

@Test func sessionSummaryCarriesOptionalMission() throws {
    let plain = try JSONDecoder().decode(SessionSummary.self, from: Data("""
    {"id":"s1","title":"Chat","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"idle"}
    """.utf8))
    #expect(plain.missionId == nil)
    let member = try JSONDecoder().decode(SessionSummary.self, from: Data("""
    {"id":"s1","title":"Chat","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"idle","missionId":"m1"}
    """.utf8))
    #expect(member.missionId == "m1")
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(member)) == member)
}

private func json(_ value: some Encodable) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
}

@Test func nullableUpdatesSendExplicitNullAndOmitUnsetFields() throws {
    let release = try json(MissionTaskWrite(sessionId: .clear))
    #expect(release.keys.sorted() == ["sessionId"])
    #expect(release["sessionId"] is NSNull, "releasing sends null, not an omitted key")
    #expect(try json(MissionTaskWrite(sessionId: .set("s1")))["sessionId"] as? String == "s1")
    #expect(try json(MissionTaskWrite(title: "Auth")).keys.sorted() == ["title"])

    let handBack = try json(UpdateMissionRequest(coordinatorSessionId: .clear))
    #expect(handBack.keys.sorted() == ["coordinatorSessionId"])
    #expect(handBack["coordinatorSessionId"] is NSNull)
    let done = try json(UpdateMissionRequest(status: .done))
    #expect(done.keys.sorted() == ["status"])
    #expect(done["status"] as? String == "done")

    let create = try json(CreateMissionRequest(projectId: "p1", title: "T", goal: "", fromSessionId: "s1",
                                               coordinator: false, draft: true))
    #expect(create["draft"] as? Bool == true)
    #expect(create["coordinator"] as? Bool == false)
    #expect(try json(MissionEventWrite(text: "Halfway", kind: .handoff, health: .atRisk))["health"] as? String == "at_risk")
}

@Test func serverUpdateDecodesMissionsAndMissionDetail() throws {
    let list = try ServerUpdate.decode(Data(#"""
    {"type":"missions","missions":[{"id":"m1","projectId":"p1","title":"API","goal":"g","status":"done",
     "briefRevision":0,"createdAt":1,"updatedAt":1}]}
    """#.utf8))
    guard case let .missions(missions)? = list else { Issue.record("expected missions"); return }
    #expect(missions.map(\.id) == ["m1"])
    #expect(missions[0].status == .done)

    let detail = try ServerUpdate.decode(Data(#"""
    {"type":"mission","mission":{"mission":{"id":"m1","projectId":"p1","title":"API","goal":"g","status":"active",
     "briefRevision":2,"createdAt":1,"updatedAt":1},"decisions":[],"comments":[],"tasks":[],"artifacts":[],
     "resources":[],"events":[]}}
    """#.utf8))
    guard case let .mission(value)? = detail else { Issue.record("expected mission"); return }
    #expect(value.mission.briefRevision == 2)
    #expect(value.brief == nil)
}

private func session(_ id: String, mission: String? = "m1", outcome: SessionOutcome? = .done, state: String = "idle",
                     archived: Bool = false, activity: Double = 1, pinned: Bool = false,
                     pullRequest: SessionPullRequest? = nil) -> SessionSummary {
    SessionSummary(id: id, title: id, cwd: "/tmp", projectId: "p1", createdAt: activity, updatedAt: activity, state: state,
                   outcome: outcome, outcomeAt: outcome == nil ? nil : activity, pullRequest: pullRequest,
                   archivedAt: archived ? 1 : nil, pinned: pinned, missionId: mission)
}

private func comment(_ id: String, author: String?, target: String? = nil, resolved: Bool = false) throws -> MissionComment {
    var object: [String: Any] = ["id": id, "text": "?", "createdAt": 1]
    if let author { object["authorSessionId"] = author }
    if let target { object["targetSessionId"] = target }
    if resolved { object["resolvedAt"] = 2 }
    return try JSONDecoder().decode(MissionComment.self, from: JSONSerialization.data(withJSONObject: object))
}

private func detail(_ mission: Mission, tasks: [MissionTask] = [], comments: [MissionComment] = []) -> MissionDetail {
    MissionDetail(mission: mission, brief: nil, decisions: [], comments: comments, tasks: tasks, artifacts: [],
                  resources: [], events: [])
}

@Test func needsYouCountsUnreadChatsBlockedTasksAndUnaddressedAgentComments() throws {
    let mission = Mission(id: "m1", projectId: "p1", title: "API", goal: "g", createdAt: 1, updatedAt: 1)
    let members = [
        session("unread-done"), session("unread-failed", outcome: .failed), session("read"),
        session("stopped", outcome: .stopped), session("working", state: "working"),
        session("archived", archived: true), session("other", mission: "m2"),
    ]
    let unread: Set<String> = ["unread-done", "unread-failed", "stopped", "working", "archived", "other"]
    let comments = [try comment("agent", author: "s1"), try comment("mine", author: nil),
                    try comment("addressed", author: "s1", target: "s2"), try comment("resolved", author: "s1", resolved: true)]
    let tasks = [MissionTask(id: "t1", number: 1, title: "Blocked", status: .blocked), MissionTask(id: "t2", number: 2, title: "Todo")]

    let withoutDetail = MissionNeedsYou.items(mission: mission, detail: nil, members: members) { unread.contains($0.id) }
    #expect(withoutDetail.map(\.id) == ["chat-unread-done", "chat-unread-failed"])

    let items = MissionNeedsYou.items(mission: mission, detail: detail(mission, tasks: tasks, comments: comments),
                                      members: members) { unread.contains($0.id) }
    #expect(items.map(\.id) == ["chat-unread-done", "chat-unread-failed", "task-t1", "comment-agent"])

    let coordinated = Mission(id: "m1", projectId: "p1", title: "API", goal: "g", coordinatorSessionId: "s1",
                              createdAt: 1, updatedAt: 1)
    let routed = MissionNeedsYou.items(mission: coordinated, detail: detail(coordinated, tasks: tasks, comments: comments),
                                       members: members) { unread.contains($0.id) }
    #expect(!routed.contains { $0.id == "comment-agent" }, "the coordinator receives unaddressed comments")
}

@Test func taskGroupsFollowWorkflowOrderAndTaskOrder() {
    let tasks = [
        MissionTask(id: "a", number: 1, title: "a", status: .done, order: 1),
        MissionTask(id: "b", number: 2, title: "b", status: .todo, order: 3),
        MissionTask(id: "c", number: 3, title: "c", status: .todo, order: 2),
        MissionTask(id: "d", number: 4, title: "d", status: .inProgress, order: 9),
        MissionTask(id: "e", number: 5, title: "e", status: .blocked, order: 0),
    ]
    let groups = MissionTaskOrdering.groups(tasks)
    #expect(groups.map(\.status) == [.inProgress, .blocked, .todo, .done])
    #expect(groups[2].tasks.map(\.id) == ["c", "b"])
    #expect(MissionTaskOrdering.nextOrder(after: tasks) == 10)
}

@Test func movingTasksUsesMidpointsAndRenumbersTies() {
    let spaced = [MissionTask(id: "a", number: 1, title: "a", order: 1), MissionTask(id: "b", number: 2, title: "b", order: 2),
                  MissionTask(id: "c", number: 3, title: "c", order: 3)]
    #expect(MissionTaskOrdering.move("c", by: -1, in: spaced) == [.init(taskId: "c", order: 1.5)])
    #expect(MissionTaskOrdering.move("a", by: 1, in: spaced) == [.init(taskId: "a", order: 2.5)])
    #expect(MissionTaskOrdering.move("b", by: -1, in: spaced) == [.init(taskId: "b", order: 0)])
    #expect(MissionTaskOrdering.move("b", by: 1, in: spaced) == [.init(taskId: "b", order: 4)])
    #expect(MissionTaskOrdering.move("a", by: -1, in: spaced).isEmpty)
    #expect(MissionTaskOrdering.move("missing", by: 1, in: spaced).isEmpty)

    let tied = [MissionTask(id: "a", number: 1, title: "a"), MissionTask(id: "b", number: 2, title: "b"),
                MissionTask(id: "c", number: 3, title: "c")]
    let updates = MissionTaskOrdering.move("c", by: -1, in: tied)
    let reordered = MissionTaskOrdering.sorted(tied.map { task in
        MissionTask(id: task.id, number: task.number, title: task.title,
                    order: updates.first { $0.taskId == task.id }?.order ?? task.order)
    })
    #expect(reordered.map(\.id) == ["a", "c", "b"])
}

@Test func missionMembersListTheCoordinatorBeforePinsPRStateAndActivity() {
    let mission = Mission(id: "m1", projectId: "p1", title: "API", goal: "g", coordinatorSessionId: "old",
                          createdAt: 1, updatedAt: 1)
    let merged = SessionPullRequest(number: 1, url: "https://github.com/example/repo/pull/1",
                                   title: "Merged", state: .merged, checkedAt: 1)
    let sessions = [session("new", activity: 3), session("old", activity: 1, pullRequest: merged), session("mid", activity: 2),
                    session("pin-old", activity: 1, pinned: true), session("pin-new", activity: 4, pinned: true),
                    session("elsewhere", mission: "m2", activity: 9, pinned: true)]
    #expect(MissionMembers.members(of: mission, in: sessions).map(\.id) == ["old", "pin-new", "pin-old", "new", "mid"])
    #expect(MissionMembers.members(of: mission, in: Array(sessions.reversed())).map(\.id) == ["old", "pin-new", "pin-old", "new", "mid"])
    #expect(MissionMembers.members(of: mission, in: [sessions[1]]).map(\.id) == ["old"])
}

@Test func missionMembersWithoutAnAvailableCoordinatorUseSessionOrder() {
    let sessions = [session("a", activity: 2), session("b", activity: 2), session("pin", activity: 1, pinned: true),
                    session("other", mission: "m2"), session("solo", mission: nil)]
    for coordinator in [nil, "missing", "other", "solo"] as [String?] {
        let mission = Mission(id: "m1", projectId: "p1", title: "API", goal: "g", coordinatorSessionId: coordinator,
                              createdAt: 1, updatedAt: 1)
        #expect(MissionMembers.members(of: mission, in: sessions).map(\.id) == ["pin", "a", "b"])
        #expect(MissionMembers.members(of: mission, in: []).isEmpty)
    }
}

@Test func missionMembersRespectFiltersAndCoordinatorChanges() {
    let sessions = [session("archived", archived: true), session("new", activity: 3),
                    session("pin", activity: 2, pinned: true)]
    let mission = Mission(id: "m1", projectId: "p1", title: "API", goal: "g", coordinatorSessionId: "archived",
                          createdAt: 1, updatedAt: 1)
    #expect(MissionMembers.members(of: mission, in: sessions).map(\.id) == ["archived", "pin", "new"])
    #expect(MissionMembers.members(of: mission, in: sessions.filter { !$0.isArchived }).map(\.id) == ["pin", "new"])
    let reassigned = Mission(id: "m1", projectId: "p1", title: "API", goal: "g", coordinatorSessionId: "new",
                             createdAt: 1, updatedAt: 1)
    #expect(MissionMembers.members(of: reassigned, in: sessions).map(\.id) == ["new", "pin", "archived"])
}

@Test func missionsListNewestFirst() {
    let missions = [Mission(id: "x", projectId: "p", title: "x", goal: "", createdAt: 1, updatedAt: 1),
                    Mission(id: "y", projectId: "p", title: "y", goal: "", createdAt: 2, updatedAt: 2)]
    #expect(missions.sidebarOrder.map(\.id) == ["y", "x"])
}

@Test func taskOwnerLabelsDoNotRepeatTheTaskTitle() {
    let task = MissionTask(id: "t", number: 3, title: "Cursor pagination")
    #expect(MissionTaskOwnerLabel.text(task: task, chatTitle: "cursor pagination ") == "Chat")
    #expect(MissionTaskOwnerLabel.text(task: task, chatTitle: "Plan API v2") == "Plan API v2")
    #expect(MissionTaskOwnerLabel.text(task: task, chatTitle: nil) == "Chat")
    #expect(MissionTaskOwnerLabel.help(chatTitle: "Cursor pagination") == "Open the chat “Cursor pagination”")
}

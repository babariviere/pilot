import Foundation
import Testing
@testable import PilotCore

private func linear(_ id: String, _ issue: String, task: String? = nil, role: MissionLinearRole? = nil,
                    workspace: String = "acme", title: String? = nil, sync: MissionLinearSync? = nil,
                    at: Double = 1) -> MissionResource {
    MissionResource(id: id, taskId: task, pullRequest: nil, url: "https://linear.app/\(workspace)/issue/\(issue)/slug",
                    title: title, kind: .linearIssue, externalId: issue, addedBySessionId: nil, createdAt: at,
                    linearRole: role, linearKey: "\(workspace)/\(issue)", linearSync: sync)
}

private func task(_ id: String, _ number: Int, _ status: MissionTaskStatus = .todo) -> MissionTask {
    MissionTask(id: id, number: number, title: "Task \(number)", status: status, order: Double(number))
}

private func sync(_ fields: [String: Any]) throws -> MissionLinearSync {
    var json = fields
    json["updatedAt"] = json["updatedAt"] ?? 1
    return try JSONDecoder().decode(MissionLinearSync.self, from: JSONSerialization.data(withJSONObject: json))
}

@Test func linearKeysMirrorTheDaemonsCanonicalForm() {
    #expect(MissionLinearKey.key(url: "https://linear.app/Acme/issue/eng-12/some-title?x=1#y") == "acme/ENG-12")
    #expect(MissionLinearKey.key(url: " http://LINEAR.app/acme/issue/ENG-3 ") == "acme/ENG-3")
    // Not an issue, another host, encoded or zero-padded identifiers: no lifecycle authority.
    #expect(MissionLinearKey.key(url: "https://linear.app/acme/project/roadmap-1a2b3c4d") == nil)
    #expect(MissionLinearKey.key(url: "https://example.com/acme/issue/ENG-1") == nil)
    #expect(MissionLinearKey.key(url: "https://linear.app/acme/issue/ENG%2D1") == nil)
    #expect(MissionLinearKey.key(url: "https://linear.app/acme/issue/ENG-01") == nil)
    #expect(MissionLinearKey.key(url: "https://linear.app/acme/issue/ENG-0") == nil)
    #expect(MissionLinearKey.key(url: "not a url") == nil)
}

@Test func olderLinksAndOtherKindsAreReferences() {
    var legacy = linear("r", "ENG-1")
    legacy.linearRole = nil
    #expect(legacy.effectiveLinearRole == .reference)
    let pr = MissionResource(id: "p", taskId: nil, pullRequest: nil, url: "https://github.com/o/r/pull/1", title: nil,
                             kind: .githubPullRequest, externalId: "o/r#1", addedBySessionId: nil, createdAt: 1,
                             linearRole: .managed)
    #expect(pr.effectiveLinearRole == .reference)
    // Without explicit roles there is nothing to manage.
    #expect(MissionTickets(resources: [legacy, linear("t", "ENG-1", task: "a")], tasks: [task("a", 1)]).isEmpty)
}

@Test func ticketsGroupContributionsAndKeepReferencesSeparate() throws {
    let tasks = [task("a", 1, .done), task("b", 2, .inProgress), task("c", 3), task("d", 4, .dropped)]
    let tickets = MissionTickets(resources: [
        linear("m", "ENG-1", role: .managed, title: "Ship tickets"),
        linear("ca", "ENG-1", task: "a", role: .contribution),
        linear("cb", "ENG-1", task: "b", role: .contribution),
        linear("cd", "ENG-1", task: "d", role: .contribution),
        // A reference never counts, and a contributor is not listed again as a reference.
        linear("rc", "ENG-1", task: "c", role: .reference),
        linear("ra", "ENG-1", task: "a", role: .reference, workspace: "acme"),
        // Same identifier in another workspace is another ticket, and unmanaged.
        linear("x", "ENG-1", task: "b", role: .reference, workspace: "other"),
    ], tasks: tasks)
    let ticket = try #require(tickets.tickets.first)
    #expect(tickets.count == 1)
    #expect(ticket.identifier == "ENG-1")
    #expect(ticket.rowTitle == "Ship tickets")
    #expect(ticket.contributions.map(\.task.number) == [1, 2, 4])
    #expect(ticket.references.map(\.task.number) == [3])
    #expect(ticket.done == 1)
    #expect(ticket.dropped == 1)
    // Dropped work stays in the total: the ticket is not delivered while it is held.
    #expect(ticket.progressLine == "1 of 3 tasks done · 1 dropped")
    #expect(ticket.holdsForDropped)
    #expect(ticket.droppedHelp == "A dropped task keeps this ticket open until you exclude it.")
    #expect(ticket.taskCountTitle == "3 tasks")
}

@Test func ticketProgressWording() {
    let empty = MissionTickets(resources: [linear("m", "ENG-1", role: .managed)], tasks: [])
    #expect(empty.tickets.first?.progressLine == "No contributing tasks yet")
    #expect(empty.tickets.first?.rowTitle == "Slug")
    let one = MissionTickets(resources: [linear("m", "ENG-1", role: .managed),
                                         linear("c", "ENG-1", task: "a", role: .contribution)],
                             tasks: [task("a", 1, .done)])
    #expect(one.tickets.first?.progressLine == "1 of 1 task done")
    #expect(one.tickets.first?.holdsForDropped == false)
    #expect(one.tickets.first?.droppedHelp == nil)
}

@Test func sharedTasksNameTheOtherTicketsTheyCountToward() {
    let tickets = MissionTickets(resources: [
        linear("m1", "ENG-1", role: .managed, at: 1),
        linear("m2", "ENG-2", role: .managed, at: 2),
        linear("c1", "ENG-1", task: "a", role: .contribution),
        linear("c2", "ENG-2", task: "a", role: .contribution),
        linear("c3", "ENG-2", task: "b", role: .contribution),
    ], tasks: [task("a", 1, .dropped), task("b", 2)])
    #expect(tickets.tickets.map(\.identifier) == ["ENG-1", "ENG-2"])
    #expect(tickets.tickets[0].contributions.first?.alsoCountsToward == ["ENG-2"])
    #expect(tickets.tickets[1].contributions.map(\.alsoCountsToward) == [["ENG-1"], []])
    #expect(tickets.managedIdentifier(url: "https://linear.app/acme/issue/eng-2") == "ENG-2")
    #expect(tickets.managedIdentifier(url: "https://linear.app/acme/issue/ENG-3") == nil)
    #expect(tickets.ticket(for: linear("q", "ENG-2", task: "b"))?.id == "m2")
}

@Test func candidatesSkipContributorsAndDroppedTasksAndUpgradeReferences() throws {
    let tasks = [task("a", 1), task("b", 2), task("c", 3, .dropped), task("d", 4, .done)]
    let tickets = MissionTickets(resources: [
        linear("m", "ENG-1", role: .managed),
        linear("ca", "ENG-1", task: "a", role: .contribution),
        linear("rb", "ENG-1", task: "b"),
    ], tasks: tasks)
    let ticket = try #require(tickets.tickets.first)
    let candidates = tickets.candidates(for: ticket, tasks: tasks)
    #expect(candidates.map(\.task.number) == [2, 4])
    #expect(candidates.map(\.referenceId) == ["rb", nil])
}

@Test func linksListLeavesManagedTicketsToTheTicketsSection() {
    let resources = [
        linear("m", "ENG-1", role: .managed),
        linear("c", "ENG-1", task: "a", role: .contribution),
        linear("r", "ENG-1", task: "b", role: .reference),
        linear("other", "ENG-2"),
        MissionResource(id: "u", taskId: nil, pullRequest: nil, url: "https://example.com", title: nil, kind: .url,
                        externalId: nil, addedBySessionId: nil, createdAt: 1),
    ]
    #expect(MissionTickets.listedLinks(resources).map(\.id) == ["other", "u"])
    // Nothing managed: the list is untouched.
    #expect(MissionTickets.listedLinks(Array(resources.suffix(2))).map(\.id) == ["other", "u"])
    // A task's contribution without a mission manager (inconsistent data) is still listed rather than hidden.
    #expect(MissionTickets.listedLinks([resources[1]]).map(\.id) == ["c"])
}

private func line(_ fields: [String: Any]) throws -> MissionTicketSyncLine? {
    let value = try sync(fields)
    return MissionTicketSyncLine(value)
}

@Test func syncLinesSayWhatLinearUpdatesAreDoing() throws {
    #expect(MissionTicketSyncLine(nil) == nil)
    let idle = try line(["state": "idle"])
    #expect(idle == nil)

    let syncedLine = try line(["state": "synced", "target": "inReview", "observedStateName": "In Review"])
    let synced = try #require(syncedLine)
    #expect(synced.text == "In Review in Linear")
    #expect(synced.tone == .quiet)
    #expect(synced.action == nil)
    #expect(synced.canPause)

    let pendingLine = try line(["state": "pending", "target": "merged", "retryAt": 5000, "error": "Timed out\nstack"])
    let pending = try #require(pendingLine)
    #expect(pending.text == "Moving to Merged in Linear")
    #expect(pending.retryAt == 5000)
    #expect(pending.help == "Last attempt failed: Timed out")

    let pausedLine = try line(["state": "paused",
                               "reason": "The Linear status changed outside synchronization. Review the ticket, then resume."])
    let paused = try #require(pausedLine)
    #expect(paused.text == "Linear updates paused. The Linear status changed outside synchronization.")
    #expect(paused.help.hasPrefix("The Linear status changed outside synchronization. Review the ticket"))
    #expect(paused.tone == .attention)
    #expect(paused.action == .resume)
    #expect(!paused.canPause)

    let failedLine = try line(["state": "error", "error": "No Merged mapping for team ENG"])
    let failed = try #require(failedLine)
    #expect(failed.text == "Couldn't update Linear: No Merged mapping for team ENG")
    #expect(failed.tone == .problem)
    #expect(failed.action == .retry)
    #expect(failed.action?.title == "Retry")

    let canceledLine = try line(["state": "terminal", "reason": "canceled"])
    let canceled = try #require(canceledLine)
    #expect(canceled.text == "Canceled in Linear")
    #expect(canceled.help.hasPrefix("Unfinished contributing tasks were dropped"))
    #expect(canceled.action == nil)
    #expect(!canceled.canPause)
    let deployedLine = try line(["state": "terminal", "reason": "deployed", "observedStateName": "Released"])
    let deployed = try #require(deployedLine)
    #expect(deployed.text == "Released in Linear")
    #expect(deployed.help == "Pilot no longer updates this ticket.")
    // An unknown state from a newer daemon reads as paused, never as up to date.
    let future = try line(["state": "future"])
    #expect(future?.tone == .attention)
}

@Test func pausedAndFailedTicketsNeedTheUser() throws {
    func managed(_ id: String, _ issue: String, _ state: String) -> String {
        #"{"id":"\#(id)","url":"https://linear.app/acme/issue/\#(issue)","kind":"linear.issue","externalId":"\#(issue)","linearRole":"managed","linearKey":"acme/\#(issue)","linearSync":{"state":"\#(state)","error":"No Merged mapping","updatedAt":1},"createdAt":1}"#
    }
    let json = """
    {"mission":{"id":"m","projectId":"p","title":"M","goal":"g","status":"active","briefRevision":1,"createdAt":1,"updatedAt":1},
     "decisions":[],"comments":[],"tasks":[],"artifacts":[],"events":[],
     "resources":[\(managed("a", "ENG-1", "paused")),\(managed("b", "ENG-2", "error")),\(managed("c", "ENG-3", "synced"))]}
    """
    let detail = try JSONDecoder().decode(MissionDetail.self, from: Data(json.utf8))
    let items = MissionNeedsYou.items(mission: detail.mission, detail: detail, members: [], isUnread: { _ in false })
    #expect(items.map(\.id) == ["linear-a", "linear-b"])
    let failed = items[1].needsYouLabel(now: Date(timeIntervalSince1970: 0))
    #expect(failed.contains("ENG-2 · Couldn't update Linear: No Merged mapping"))
}

@Test func attachChoicesFollowScopeAndManagement() {
    let managed = [linear("m", "ENG-1", role: .managed)]
    let url = "https://linear.app/acme/issue/ENG-1/x"
    #expect(MissionLinearAttachChoice.choice(url: url, taskId: nil, resources: []) == .manage)
    #expect(MissionLinearAttachChoice.choice(url: url, taskId: nil, resources: []).defaultOn)
    // Already managed here: nothing to choose at mission scope.
    #expect(MissionLinearAttachChoice.choice(url: url, taskId: nil, resources: managed) == .none)
    #expect(MissionLinearAttachChoice.choice(url: url, taskId: "a", resources: managed) == .contribute(identifier: "ENG-1"))
    #expect(!MissionLinearAttachChoice.contribute(identifier: "ENG-1").defaultOn)
    // A task link to an unmanaged ticket is a reference.
    #expect(MissionLinearAttachChoice.choice(url: url, taskId: "a", resources: []) == .none)
    #expect(MissionLinearAttachChoice.choice(url: "https://github.com/o/r/pull/1", taskId: nil, resources: []) == .none)
}

@Test func attachPlansUpgradeExistingLinksExplicitly() {
    let url = "https://linear.app/acme/issue/ENG-1/x"
    let resources = [linear("m", "ENG-1", role: .managed), linear("r", "ENG-1", task: "a")]
    #expect(MissionLinearAttachPlan.plan(url: url, taskId: "a", role: .contribution, resources: resources)
        == .update(resourceId: "r", role: .contribution))
    #expect(MissionLinearAttachPlan.plan(url: url, taskId: nil, role: .managed, resources: resources) == .existing)
    #expect(MissionLinearAttachPlan.plan(url: url, taskId: "b", role: .contribution, resources: resources)
        == .add(role: .contribution))
    // Without a chosen role an existing link is left alone.
    #expect(MissionLinearAttachPlan.plan(url: url, taskId: "a", role: nil, resources: resources) == .add(role: nil))
}

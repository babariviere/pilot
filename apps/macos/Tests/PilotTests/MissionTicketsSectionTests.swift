import Foundation
import Testing
@testable import Pilot
@testable import PilotCore

private func detail(resources: String, tasks: String) throws -> MissionDetail {
    let json = """
    {"mission":{"id":"m","projectId":"p","title":"M","goal":"g","status":"active","briefRevision":1,"createdAt":1,"updatedAt":1},
     "decisions":[],"comments":[],"tasks":[\(tasks)],"artifacts":[],"resources":[\(resources)],"events":[]}
    """
    return try JSONDecoder().decode(MissionDetail.self, from: Data(json.utf8))
}

private let managed = #"{"id":"m1","url":"https://linear.app/acme/issue/ENG-1/x","kind":"linear.issue","externalId":"ENG-1","linearRole":"managed","linearKey":"acme/ENG-1","createdAt":1}"#
private let contribution = #"{"id":"c1","taskId":"t1","url":"https://linear.app/acme/issue/ENG-1/x","kind":"linear.issue","externalId":"ENG-1","linearRole":"contribution","linearKey":"acme/ENG-1","createdAt":2}"#
private let reference = #"{"id":"r1","url":"https://linear.app/acme/issue/ENG-2/y","kind":"linear.issue","externalId":"ENG-2","linearRole":"reference","linearKey":"acme/ENG-2","createdAt":3}"#
private let task = #"{"id":"t1","number":4,"title":"T","status":"in_progress","order":1,"createdAt":1,"updatedAt":1}"#

@Test @MainActor func ticketsAreRebuiltOnlyWhenLinksOrTasksChange() throws {
    let cache = MissionTicketsCache()
    let first = try detail(resources: "\(managed),\(contribution)", tasks: task)
    #expect(cache.tickets(for: first).tickets.first?.progressLine == "0 of 1 task done")
    _ = cache.tickets(for: try detail(resources: "\(managed),\(contribution)", tasks: task))
    #expect(cache.builds == 1)
    let finished = try detail(resources: "\(managed),\(contribution)",
                              tasks: task.replacingOccurrences(of: "in_progress", with: "done"))
    #expect(cache.tickets(for: finished).tickets.first?.progressLine == "1 of 1 task done")
    #expect(cache.builds == 2)
}

@Test @MainActor func linksListLeavesManagedTicketsToTheirSection() throws {
    let cache = MissionLinkGroupsCache()
    let groups = cache.groups(for: try detail(resources: "\(managed),\(contribution),\(reference)", tasks: task),
                              sessions: [])
    // Only the reference stays among Links, still found by its mission-level copy.
    #expect(groups.linear.map(\.id) == ["r1"])
    #expect(groups.linear.first?.missionResourceId == "r1")
}


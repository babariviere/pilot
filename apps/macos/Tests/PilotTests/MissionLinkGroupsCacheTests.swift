import Foundation
import Testing
@testable import Pilot
@testable import PilotCore

private func detail(resources: String = "", tasks: String = "") throws -> MissionDetail {
    let json = """
    {"mission":{"id":"m","projectId":"p","title":"M","goal":"g","status":"active","briefRevision":1,"createdAt":1,"updatedAt":1},
     "decisions":[],"comments":[],"tasks":[\(tasks)],"artifacts":[],"resources":[\(resources)],"events":[]}
    """
    return try JSONDecoder().decode(MissionDetail.self, from: Data(json.utf8))
}

private let linear = #"{"id":"r1","url":"https://linear.app/a/issue/ENG-1","kind":"linear.issue","externalId":"ENG-1","createdAt":1}"#
private let savedPR = #"{"id":"r2","taskId":"t1","url":"https://github.com/o/r/pull/2","kind":"github.pr","pullRequest":{"number":2,"url":"https://github.com/o/r/pull/2","title":"Two","state":"open","checkedAt":1},"createdAt":2}"#
private let unknownPR = #"{"id":"r3","url":"https://github.com/o/r/pull/3","kind":"github.pr","externalId":"o/r#3","createdAt":3}"#
private let task = #"{"id":"t1","number":4,"title":"T","status":"todo","order":1,"createdAt":1,"updatedAt":1}"#

private func session(_ id: String, pullRequest: SessionPullRequest?) -> SessionSummary {
    SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle", pullRequest: pullRequest)
}

@Test @MainActor func groupsAreRebuiltOnlyWhenLinksOrTaskNumbersChange() throws {
    let cache = MissionLinkGroupsCache()
    var read = 0
    let first = try detail(resources: "\(linear),\(savedPR)", tasks: task)
    func groups(_ detail: MissionDetail) -> MissionLinkGroups {
        cache.groups(for: detail, sessions: { read += 1; return [] }())
    }
    #expect(groups(first).linear.count == 1)
    #expect(groups(first).open.first?.taskNumber == 4)
    #expect(cache.builds == 1)
    // Task changes that do not touch numbers, and a fresh decode of the same detail, do not rebuild.
    let renamed = try detail(resources: "\(linear),\(savedPR)", tasks: task.replacingOccurrences(of: #""title":"T""#, with: #""title":"Renamed""#))
    _ = groups(renamed)
    _ = groups(try detail(resources: "\(linear),\(savedPR)", tasks: task))
    #expect(cache.builds == 1)
    // Every link has saved state, so chats' reports are never even read.
    #expect(read == 0)
    _ = groups(try detail(resources: linear, tasks: task))
    #expect(cache.builds == 2)
}

@Test @MainActor func chatReportsAreOnlyReadForLinksWithoutSavedState() throws {
    let cache = MissionLinkGroupsCache()
    let withUnknown = try detail(resources: "\(linear),\(unknownPR)")
    var reads = 0
    let report = SessionPullRequest(number: 3, url: "https://github.com/o/r/pull/3", title: "Three", state: .merged,
                                    checkedAt: 5, mergedAt: 4)
    let before = cache.groups(for: withUnknown, sessions: { reads += 1; return [session("a", pullRequest: nil)] }())
    #expect(before.other.map(\.id) == ["r3"])
    #expect(reads == 1)
    // Same links, still nothing reported: no rebuild.
    _ = cache.groups(for: withUnknown, sessions: [session("a", pullRequest: nil)])
    #expect(cache.builds == 1)
    // A chat reports the PR as merged: the row moves.
    let after = cache.groups(for: withUnknown, sessions: [session("a", pullRequest: report)])
    #expect(after.merged.map(\.id) == ["r3"])
    #expect(cache.builds == 2)
    _ = cache.groups(for: withUnknown, sessions: [session("a", pullRequest: report)])
    #expect(cache.builds == 2)

    let resolved = MissionLinkGroupsCache()
    var untouched = 0
    _ = resolved.groups(for: try detail(resources: "\(linear),\(savedPR)"), sessions: { untouched += 1; return [] }())
    #expect(untouched == 0)
}

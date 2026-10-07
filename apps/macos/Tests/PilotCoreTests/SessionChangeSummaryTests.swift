import Foundation
import Testing
@testable import PilotCore

@Test func changeSummaryDecodesWithAndWithoutBranch() throws {
    let summary = try JSONDecoder().decode(SessionChangeSummary.self, from: Data(
        #"{"base":"origin/main (abcd1234)","branch":"pilot/task","fileCount":5,"additions":13,"deletions":2}"#.utf8
    ))
    #expect(summary.branch == "pilot/task")
    #expect(summary.fileCountLabel == "5 files")
    #expect(summary.additions == 13)
    #expect(summary.deletions == 2)
    #expect(summary.lineStatLabel == "13 lines added, 2 lines deleted")
    #expect(summary.helpText.contains("13 lines added, 2 lines deleted"))
    #expect(summary.helpText.contains("since origin/main (abcd1234)"))
    #expect(summary.helpText.contains("committed, uncommitted and untracked"))
    #expect(try JSONDecoder().decode(SessionChangeSummary.self, from: JSONEncoder().encode(summary)) == summary)
    let detached = try JSONDecoder().decode(SessionChangeSummary.self, from: Data(
        #"{"base":"HEAD","fileCount":0}"#.utf8
    ))
    #expect(detached.branch == nil)
    #expect(detached.fileCountLabel == "0 files")
    #expect(detached.lineStatLabel == nil) // Older daemon: unknown, not zero.
    #expect(SessionChangeSummary(base: "HEAD", fileCount: 1).fileCountLabel == "1 file")
}

@Test func changeSummaryKeepsZeroTotalsVisibleAndRoundTrips() throws {
    let zero = SessionChangeSummary(base: "HEAD", fileCount: 0, additions: 0, deletions: 0)
    #expect(zero.lineStatLabel == "0 lines added, 0 lines deleted")
    #expect(try JSONDecoder().decode(SessionChangeSummary.self, from: JSONEncoder().encode(zero)) == zero)
    #expect(SessionChangeSummary(base: "HEAD", fileCount: 1, additions: 3).lineStatLabel == nil)
}

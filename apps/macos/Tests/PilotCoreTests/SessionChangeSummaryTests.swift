import Foundation
import Testing
@testable import PilotCore

@Test func changeSummaryDecodesWithAndWithoutBranch() throws {
    let summary = try JSONDecoder().decode(SessionChangeSummary.self, from: Data(
        #"{"base":"origin/main (abcd1234)","branch":"pilot/task","fileCount":5}"#.utf8
    ))
    #expect(summary.branch == "pilot/task")
    #expect(summary.fileCountLabel == "5 files")
    #expect(summary.helpText.contains("since origin/main (abcd1234)"))
    #expect(summary.helpText.contains("committed, uncommitted and untracked"))
    #expect(try JSONDecoder().decode(SessionChangeSummary.self, from: JSONEncoder().encode(summary)) == summary)
    let detached = try JSONDecoder().decode(SessionChangeSummary.self, from: Data(
        #"{"base":"HEAD","fileCount":0}"#.utf8
    ))
    #expect(detached.branch == nil)
    #expect(detached.fileCountLabel == "0 files")
    #expect(SessionChangeSummary(base: "HEAD", fileCount: 1).fileCountLabel == "1 file")
}

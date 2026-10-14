import Foundation
import Testing
@testable import PilotCore

private func token(_ text: String, at location: Int? = nil) -> String? {
    let caret = location ?? (text as NSString).length
    return SlashCommands.range(in: text, selection: NSRange(location: caret, length: 0))
        .map { (text as NSString).substring(with: $0) }
}

@Test func slashTokenOnlyAtTheStartOfTheMessageBeforeWhitespace() {
    #expect(token("/") == "/")
    #expect(token("/comp") == "/comp")
    #expect(token("/skill:com") == "/skill:com")
    #expect(token("/compact keep") == nil)
    #expect(token("hello /comp") == nil)
    #expect(token(" /comp") == nil)
    #expect(token("") == nil)
    #expect(token("/compact", at: 4) == nil, "inside a token")
    #expect(token("/comp more", at: 5) == "/comp", "before trailing text")
}

@Test func slashMatchesPreferPrefixesIncludingBareSkillNames() {
    let commands = SlashCommands.all([
        SessionCommand(name: "review", source: .prompt),
        SessionCommand(name: "skill:commit", source: .skill),
        SessionCommand(name: "skill:recompile", source: .skill),
        SessionCommand(name: "compact", source: .prompt, description: "shadowed"),
        SessionCommand(name: "jobs", source: .prompt, description: "shadowed"),
    ])
    #expect(commands.map(\.name) == ["compact", "jobs", "review", "skill:commit", "skill:recompile"])
    #expect(commands.first?.kind == .builtin)
    #expect(SlashCommands.matches("com", in: commands).map(\.name) == ["compact", "skill:commit", "skill:recompile"])
    #expect(SlashCommands.matches("skill:", in: commands).map(\.name) == ["skill:commit", "skill:recompile"])
    #expect(SlashCommands.matches("REV", in: commands).map(\.name) == ["review"])
    #expect(SlashCommands.matches("", in: commands).count == 5)
    #expect(SlashCommands.matches("jo", in: commands) == [SlashCommands.jobs])
    #expect(SlashCommands.matches("zzz", in: commands).isEmpty)
}

@Test func jobsCommandRecognizesOnlyItsOwnToken() {
    #expect(SlashCommands.jobsArguments("/jobs") == "")
    #expect(SlashCommands.jobsArguments("  /jobs\n ") == "")
    #expect(SlashCommands.jobsArguments("/jobs stop") == "stop")
    #expect(SlashCommands.jobsArguments("/jobs-other") == nil)
    #expect(SlashCommands.jobsArguments("please /jobs") == nil)
    #expect(SlashCommands.jobsArguments("/skill:jobs") == nil)
}

@Test func jobsResponseMirrorsTheProtocolAndElapsedTimeIsSnapshotBased() throws {
    let data = Data(#"{"jobs":[{"id":"tests","name":"Test suite","state":"running","startedAt":1000,"outputPath":"/tmp/tests.log"}]}"#.utf8)
    let response = try JSONDecoder().decode(SessionJobsResponse.self, from: data)
    let job = try #require(response.jobs.first)
    #expect(job == SessionJob(id: "tests", name: "Test suite", startedAt: 1000, outputPath: "/tmp/tests.log"))
    #expect(job.elapsed(at: 0) == "0s")
    #expect(job.elapsed(at: 60000) == "59s")
    #expect(job.elapsed(at: 61000) == "1m 0s")
    #expect(job.elapsed(at: 3662000) == "1h 1m")
    #expect(try JSONDecoder().decode(SessionJobsResponse.self, from: Data(#"{"jobs":[]}"#.utf8)).jobs.isEmpty)
}

@Test func sessionSummaryAcceptsLiveJobsAndOlderDaemons() throws {
    let job = SessionJob(id: "tests", name: "Tests", startedAt: 1000, outputPath: "/tmp/tests.log")
    let summary = SessionSummary(id: "chat", title: "Chat", cwd: "/tmp", createdAt: 0, updatedAt: 0,
                                 state: "idle", runningJobs: [job])
    let encoded = try JSONEncoder().encode(summary)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: encoded).runningJobs == [job])
    let old = Data(#"{"id":"chat","title":"Chat","cwd":"/tmp","createdAt":0,"updatedAt":0,"state":"parked"}"#.utf8)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: old).runningJobs == nil)
}

@Test func compactInstructionsRecognizeOnlyTheCompactCommand() {
    #expect(SlashCommands.compactInstructions("/compact") == "")
    #expect(SlashCommands.compactInstructions("  /compact  ") == "")
    #expect(SlashCommands.compactInstructions("/compact keep the API notes\nand tests") == "keep the API notes\nand tests")
    #expect(SlashCommands.compactInstructions("/compacting") == nil)
    #expect(SlashCommands.compactInstructions("please /compact") == nil)
    #expect(SlashCommands.compactInstructions("/skill:compact") == nil)
}

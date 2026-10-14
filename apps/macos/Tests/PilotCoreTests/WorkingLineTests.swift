import Foundation
import Testing
@testable import PilotCore

private func job(_ id: String, _ name: String, startedAt: Double) -> SessionJob {
    SessionJob(id: id, name: name, startedAt: startedAt, outputPath: "/tmp/\(id).log")
}

@Test func workingLineCountsJobsWhileTheAgentRuns() {
    let jobs = [job("a", "Tests", startedAt: 0), job("b", "Build", startedAt: 0)]
    #expect(WorkingLine(agentWorking: true, jobs: [], now: 0).text == "Working…")
    #expect(WorkingLine(agentWorking: true, jobs: [jobs[0]], now: 0).text == "Working… · 1 job")
    let both = WorkingLine(agentWorking: true, jobs: jobs, now: 0)
    #expect(both.text == "Working… · 2 jobs")
    #expect(both.accessibilityLabel == "Working…, 2 background jobs running")
    #expect(!both.waitingOnJobs)
    // Retries and compaction keep their wording, idle or not.
    #expect(WorkingLine(retry: "Rate limited", agentWorking: false, jobs: jobs, now: 0).text
        == "Retrying: Rate limited · 2 jobs")
    #expect(WorkingLine(compacting: true, agentWorking: false, jobs: [], now: 0).text == "Compacting context…")
}

@Test func workingLineNamesTheLongestJobWhileOnlyJobsRun() {
    let now = 10_000_000.0
    let jobs = [job("b", "Build", startedAt: now - 90_000), job("t", "Tests", startedAt: now - 4 * 60_000 - 5_000)]
    let line = WorkingLine(agentWorking: false, jobs: jobs, now: now)
    #expect(line.lead == "Waiting on 2 jobs ·")
    #expect(line.jobName == "Tests")
    #expect(line.elapsed == "4m")
    #expect(line.text == "Waiting on 2 jobs · Tests 4m")
    #expect(line.waitingOnJobs)
    #expect(line.accessibilityLabel == "Waiting on 2 background jobs. Longest: Tests, running for 4 minutes")
    let one = WorkingLine(agentWorking: false, jobs: [jobs[0]], now: now)
    #expect(one.text == "Waiting on 1 job · Build 1m")
    #expect(one.accessibilityLabel == "Waiting on 1 background job: Build, running for 1 minute")
    // Idle without jobs is the plain working line (a job's follow-up turn is about to start).
    #expect(WorkingLine(agentWorking: false, jobs: [], now: now).text == "Working…")
}

@Test func compactElapsedTimesStayShort() {
    #expect(WorkingLine.compactElapsed(milliseconds: -5) == "0s")
    #expect(WorkingLine.compactElapsed(milliseconds: 59_999) == "59s")
    #expect(WorkingLine.compactElapsed(milliseconds: 60_000) == "1m")
    #expect(WorkingLine.compactElapsed(milliseconds: 3_599_000) == "59m")
    #expect(WorkingLine.compactElapsed(milliseconds: 3_600_000) == "1h")
    #expect(WorkingLine.compactElapsed(milliseconds: 3_900_000) == "1h 5m")
    #expect(WorkingLine.nextElapsedChange(after: 1500, startedAt: 0) == 2000)
    #expect(WorkingLine.nextElapsedChange(after: 59_500, startedAt: 0) == 60_000)
    #expect(WorkingLine.nextElapsedChange(after: 60_000, startedAt: 0) == 120_000)
    #expect(WorkingLine.nextElapsedChange(after: 0, startedAt: 5_000) == 6_000)
}

@Test func onlyIdleAgentsWithRunningJobsWaitOnJobs() {
    let tests = job("t", "Tests", startedAt: 1)
    func chat(_ id: String, state: String, working: Bool?, jobs: [SessionJob]?, mission: String? = "m") -> SessionSummary {
        SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: 1, state: state, missionId: mission,
                       runningJobs: jobs, working: working)
    }
    let waiting = chat("waiting", state: "idle", working: true, jobs: [tests])
    let running = chat("running", state: "working", working: true, jobs: [tests])
    let followUp = chat("follow-up", state: "idle", working: true, jobs: nil)
    #expect(waiting.isWaitingOnJobs)
    #expect(!running.isWaitingOnJobs)
    #expect(!followUp.isWaitingOnJobs)
    var paused = waiting
    paused.sleepPaused = true
    #expect(!paused.isWaitingOnJobs)
    let mission = Mission(id: "m", projectId: "p", title: "API", goal: "g", createdAt: 1, updatedAt: 1)
    #expect(MissionSidebarSummary.waitingOnJobs(mission: mission, members: [waiting]))
    #expect(!MissionSidebarSummary.waitingOnJobs(mission: mission, members: [waiting, running]))
    #expect(!MissionSidebarSummary.waitingOnJobs(mission: mission, members: []))
}

import Testing
@testable import Pilot
@testable import PilotCore

private func summary(_ id: String, status: MissionStatus = .active, count: Int = 0) -> Mission {
    Mission(id: id, projectId: "p", title: id, goal: "g", status: status, createdAt: 1, updatedAt: 1,
            needsYouCount: count)
}

private func detail(_ mission: Mission) -> MissionDetail {
    MissionDetail(mission: mission, brief: nil, decisions: [], decisionProposals: [], comments: [], tasks: [], artifacts: [],
                  resources: [], events: [])
}

@Test @MainActor func missionSummariesDoNotRetainAnyFullDetails() {
    let client = PilotClient()
    let first = summary("one", count: 2)
    let second = summary("two", count: 4)
    client.handle(.missions([first, second]))
    // Unsolicited detail is ignored, proving the summaries did not retain these missions.
    client.handle(.mission(detail(first)))
    client.handle(.mission(detail(second)))
    #expect(client.missionDetails.isEmpty)
    #expect(client.mission("one")?.needsYouCount == 2)
    #expect(client.mission("two")?.needsYouCount == 4)
    client.handle(.missions([summary("one", count: 0), second]))
    #expect(client.mission("one")?.needsYouCount == 0)
    #expect(client.missionDetails.isEmpty)
}

@Test @MainActor func missionDetailIsRetainedOnlyWhileViewsNeedIt() {
    let client = PilotClient()
    let mission = summary("one", count: 2)
    client.handle(.missions([mission]))
    client.retainMission(mission.id)
    client.retainMission(mission.id)
    client.handle(.mission(detail(mission)))
    #expect(client.missionDetails[mission.id] != nil)
    client.releaseMission(mission.id)
    // Summary updates, even status changes, must not alter a view's reference count.
    client.handle(.missions([summary("one", status: .done)]))
    #expect(client.missionDetails[mission.id] != nil)
    client.releaseMission(mission.id)
    #expect(client.missionDetails.isEmpty)
    client.handle(.mission(detail(mission)))
    #expect(client.missionDetails.isEmpty)
    client.handle(.missions([mission]))
    client.handle(.mission(detail(mission)))
    #expect(client.missionDetails.isEmpty)
}

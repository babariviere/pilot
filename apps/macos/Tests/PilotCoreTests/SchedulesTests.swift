import Foundation
import Testing
@testable import PilotCore

@Test func scheduleTargetsRoundTripWithFullSpawnAndFollowUp() throws {
    let spawn = SpawnRequest(
        projectId: "p", message: "Do work", title: "Work", model: "provider/model", thinking: "high",
        baseBranch: "release", mode: .ask, missionId: "m"
    )
    let targets: [ScheduleTarget] = [.chat(spawn), .message(sessionId: "s", message: "Continue")]
    for target in targets {
        let request = ScheduleRequest(trigger: .onBack, target: target)
        let encoded = try JSONEncoder().encode(request)
        let decoded = try JSONDecoder().decode(ScheduleRequest.self, from: encoded)
        switch decoded.target {
        case let .chat(value):
            #expect(value.missionId == "m")
            #expect(value.projectId == "p")
            #expect(value.mode == .ask)
            #expect(value.baseBranch == "release")
            #expect(value.model == "provider/model")
            #expect(value.thinking == "high")
        case let .message(sessionId, message):
            #expect(sessionId == "s")
            #expect(message == "Continue")
        }
        #expect(decoded.trigger == .onBack)
    }
    let patch = SchedulePatch(trigger: .at, at: 2000, expectedRevision: 2)
    let decoded = try JSONDecoder().decode(SchedulePatch.self, from: JSONEncoder().encode(patch))
    #expect(decoded.at == 2000)
    #expect(decoded.expectedRevision == 2)
}

@Test func scheduleWebSocketDecodesStatesAndWakeLatch() throws {
    let json = #"""
    {"type":"schedules","schedules":[
      {"id":"x","revision":2,"title":"Plan","projectId":"p","trigger":"on_back",
       "target":{"kind":"chat","spawn":{"projectId":"p","message":"Work","mode":"build","workspace":"clone"}},
       "state":"pending","createdAt":1000,"updatedAt":2000,"wakeObserved":true},
      {"id":"y","revision":3,"title":"Continue","trigger":"on_wake","target":{"kind":"message","sessionId":"s","message":"Continue"},
       "state":"failed","createdAt":1000,"updatedAt":3000,"claimedAt":2500,"error":"Target chat was deleted","sessionId":"s"}
    ]}
    """#
    guard case let .schedules(items) = try ServerUpdate.decode(Data(json.utf8)) else {
        Issue.record("Expected schedules"); return
    }
    #expect(items.count == 2)
    #expect(items[0].wakeObserved == true)
    #expect(items[1].state == .failed)
    #expect(items[1].claimedAt == 2500)
    #expect(items[1].sessionId == "s")
    let roundTrip = try JSONDecoder().decode([ScheduledItem].self, from: JSONEncoder().encode(items))
    #expect(roundTrip[1].error == "Target chat was deleted")
    #expect(try JSONDecoder().decode(ScheduleTrigger.self, from: Data(#""on_online""#.utf8)) == .onOnline)
    #expect(try JSONDecoder().decode(DashboardScheduledTrigger.self, from: Data(#""on_wake""#.utf8)) == .onWake)
}

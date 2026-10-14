import Foundation
import Testing
@testable import PilotCore

@Test func scheduleTargetsRoundTripWithFullSpawnAndFollowUp() throws {
    let spawn = SpawnRequest(
        projectId: "p", message: "Do work", title: "Work", model: "provider/model", thinking: "high",
        baseBranch: "release", mode: .ask, missionId: "m"
    )
    let targets: [ScheduleTarget] = [.chat(spawn, trackedItemId: "ticket"), .message(sessionId: "s", message: "Continue")]
    for target in targets {
        let request = ScheduleRequest(trigger: .onBack, target: target)
        let encoded = try JSONEncoder().encode(request)
        let decoded = try JSONDecoder().decode(ScheduleRequest.self, from: encoded)
        switch decoded.target {
        case let .chat(value, trackedItemId):
            #expect(trackedItemId == "ticket")
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

@Test func scheduleWebSocketDecodesStatesAndSleepWakeLatches() throws {
    let json = #"""
    {"type":"schedules","schedules":[
      {"id":"x","revision":2,"title":"Plan","projectId":"p","trigger":"on_back",
       "target":{"kind":"chat","spawn":{"projectId":"p","message":"Work","mode":"build","workspace":"clone"}},
       "state":"pending","createdAt":1000,"updatedAt":2000,"wakeObserved":true,"sleepObserved":true},
      {"id":"y","revision":3,"title":"Continue","trigger":"on_wake","target":{"kind":"message","sessionId":"s","message":"Continue"},
       "state":"failed","createdAt":1000,"updatedAt":3000,"claimedAt":2500,"error":"Target chat was deleted","sessionId":"s"}
    ]}
    """#
    guard case let .schedules(items) = try ServerUpdate.decode(Data(json.utf8)) else {
        Issue.record("Expected schedules"); return
    }
    #expect(items.count == 2)
    #expect(items[0].wakeObserved == true)
    #expect(items[0].sleepObserved == true)
    #expect(items[1].sleepObserved == nil)
    guard case let .chat(_, trackedItemId) = items[0].target else {
        Issue.record("Expected chat target"); return
    }
    #expect(trackedItemId == nil)
    let legacyTarget = try JSONSerialization.jsonObject(with: JSONEncoder().encode(items[0].target)) as? [String: Any]
    #expect(legacyTarget?["trackedItemId"] == nil)
    #expect(items[1].state == .failed)
    #expect(items[1].claimedAt == 2500)
    #expect(items[1].sessionId == "s")
    let roundTrip = try JSONDecoder().decode([ScheduledItem].self, from: JSONEncoder().encode(items))
    #expect(roundTrip[0].sleepObserved == true)
    #expect(roundTrip[1].error == "Target chat was deleted")
    #expect(try JSONDecoder().decode(ScheduleTrigger.self, from: Data(#""on_online""#.utf8)) == .onOnline)
    #expect(try JSONDecoder().decode(DashboardScheduledTrigger.self, from: Data(#""on_wake""#.utf8)) == .onWake)
}

@Test func legacyNetworkSchedulesDecodeAsCancelledWithoutConversion() throws {
    #expect(try JSONDecoder().decode(DashboardScheduledTrigger.self, from: Data(#""future_trigger""#.utf8)) == .onBack)
    for trigger in ["on_join_network", "on_leave_network", "removed"] {
        for state in ["pending", "dispatching", "failed", "fired", "cancelled"] {
            let record: [String: Any] = [
                "id": "legacy", "revision": 1, "title": "Work", "projectId": "p",
                "trigger": trigger, "networkNames": ["Example"], "state": state,
                "createdAt": 1000, "updatedAt": 1000,
                "target": ["kind": "message", "sessionId": "s", "message": "Continue"],
            ]
            let data = try JSONSerialization.data(withJSONObject: record)
            let item = try JSONDecoder().decode(ScheduledItem.self, from: data)
            #expect(item.trigger == .removed)
            #expect(item.state == .cancelled)
            #expect(item.error == "Wi-Fi triggers were removed")
            guard case let .message(sessionId, message) = item.target else {
                Issue.record("Expected preserved message target"); return
            }
            #expect(sessionId == "s" && message == "Continue")
            let encoded = try JSONEncoder().encode(item)
            let roundTrip = try JSONDecoder().decode(ScheduledItem.self, from: encoded)
            #expect(roundTrip.trigger == .removed && roundTrip.state == .cancelled)
            let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
            #expect(object?["networkNames"] == nil)
            let update = try JSONSerialization.data(withJSONObject: ["type": "schedules", "schedules": [record]])
            guard case let .schedules(items) = try ServerUpdate.decode(update) else {
                Issue.record("Expected legacy schedules update"); return
            }
            #expect(items.count == 1 && items[0].state == .cancelled)
        }
        let dashboard = try JSONDecoder().decode(DashboardScheduledItem.self, from: JSONSerialization.data(withJSONObject: [
            "id": "legacy", "title": "Work", "kind": "chat", "trigger": trigger,
            "networkNames": ["Example"], "state": "pending",
        ]))
        #expect(dashboard.trigger == .removed)
        #expect(dashboard.state == .cancelled)
        #expect(dashboard.error == "Wi-Fi triggers were removed")
    }
}

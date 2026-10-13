import Foundation
import Testing
@testable import PilotCore

@Test func trackingDecodesLegacyProjectsAndConfiguration() throws {
    let old = try JSONDecoder().decode(Project.self, from: Data(#"{"id":"p","name":"Repo","path":"/repo","createdAt":1}"#.utf8))
    #expect(old.tracking == nil)
    let request = ProjectRequest(tracking: .init(slackChannels: ["C1", "bugs"], linearTeam: "ENG"))
    let json = try JSONValue.decode(JSONEncoder().encode(request))
    #expect(json["tracking"]?["slackChannels"]?.array?.count == 2)
    #expect(json["tracking"]?["linearTeam"]?.string == "ENG")
    #expect(json["tracking"]?["mcp"] == nil)
    let legacy = try JSONDecoder().decode(Project.self, from: Data(#"""
    {"id":"p","name":"Repo","path":"/repo","createdAt":1,
     "tracking":{"slackChannels":["C1"],"linearTeam":"ENG",
                 "mcp":{"linear":{"server":"alternative","tools":{"issues":"old_issues"}}}}}
    """#.utf8))
    #expect(legacy.tracking?.linearTeam == "ENG")
    #expect(try JSONValue.decode(JSONEncoder().encode(legacy))["tracking"]?["mcp"] == nil)
}

@Test func trackingDecodesItemsStatusAndWebSocketChanges() throws {
    let json = Data(#"""
    {"items":[{"id":"i","projectId":"p","kind":"linear","externalId":"ENG-1","title":"Bug","url":"https://example.com",
      "status":"Todo","metadata":{"priority":2,"assignee":null,"nested":{"ok":true}},"dismissed":true,"sessionId":"s",
      "missionId":"m","createdAt":1,"updatedAt":2}],"total":1}
    """#.utf8)
    let list = try JSONDecoder().decode(TrackedItemList.self, from: json)
    #expect(list.items[0].metadata["priority"] == .number(2))
    #expect(list.items[0].dismissed)
    #expect(list.items[0].missionId == "m")
    let source = Data(#"""
    {"type":"sources","sources":[{"id":"p:linear","projectId":"p","kind":"linear","label":"Linear","configured":true,
      "status":"sign_in_required","signInCommand":"pi mcp login linear"}]}
    """#.utf8)
    guard case let .sources(sources) = try ServerUpdate.decode(source) else { Issue.record("Expected sources"); return }
    #expect(sources[0].status == .signInRequired)
    #expect(sources[0].signInCommand == "pi mcp login linear")
    guard case let .trackedChanged(projectId) = try ServerUpdate.decode(Data(#"{"type":"tracked.changed","projectId":"p"}"#.utf8))
    else { Issue.record("Expected invalidation"); return }
    #expect(projectId == "p")
    #expect(try JSONDecoder().decode(DashboardSourceStatus.self, from: Data(#""idle""#.utf8)) == .idle)
    #expect(try JSONDecoder().decode(DashboardSourceStatus.self, from: Data(#""not_configured""#.utf8)) == .notConfigured)
}

@Test func trackedPatchDistinguishesMissingLinksFromClearedLinks() throws {
    let patch = TrackedItemPatch(dismissed: true, clearSession: true)
    let json = try JSONValue.decode(JSONEncoder().encode(patch))
    #expect(json["sessionId"] == .null)
    #expect(json["missionId"] == nil)
    #expect(json["dismissed"] == .bool(true))
}

@Test func linearCycleSummaryAndTransientPrefillDecode() throws {
    let json = Data(#"""
    {"source":"linear","label":"Linear","status":"ok","total":2,"items":[],
     "linear":{"cycleStatus":"current","currentCycle":{"id":"c1","name":"October","number":12,
       "startsAt":"2026-10-05T00:00:00Z","endsAt":"2026-10-19T00:00:00Z",
       "progress":0.5,"total":2,"done":1,"inProgress":1,"todo":0}}}
    """#.utf8)
    let source = try JSONDecoder().decode(DashboardTrackedSource.self, from: json)
    #expect(source.linear?.currentCycle?.id == "c1")
    #expect(source.linear?.currentCycle?.progress == 0.5)
    #expect(source.linear?.currentCycle?.total == 2)
    let fallback = try JSONDecoder().decode(LinearSourceSummary.self, from: Data(#"""
    {"cycleStatus":"no_active_cycle","statusMessage":"Showing your open issues."}
    """#.utf8))
    #expect(fallback.cycleStatus == .noActiveCycle)
    #expect(fallback.currentCycle == nil)
    let prefill = try JSONDecoder().decode(TrackedItemPrefill.self, from: Data(#"""
    {"itemId":"i","identifier":"ENG-1","title":"Bug","url":"https://example.com",
     "description":"External text","gitBranchName":"eng-1-bug","prompt":"Quoted external text"}
    """#.utf8))
    #expect(prefill.gitBranchName == "eng-1-bug")
    #expect(prefill.description == "External text")
}

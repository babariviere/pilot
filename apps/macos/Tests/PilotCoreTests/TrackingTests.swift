import Foundation
import Testing
@testable import PilotCore

@Test func slackTriageDecodesAndEncodesExplicitOverrides() throws {
    let config = ProjectTrackingConfig(slackLabels: [.init(name: "Client", description: "App support", hideFromInbox: true)])
    let roundtrip = try JSONDecoder().decode(ProjectTrackingConfig.self, from: JSONEncoder().encode(config))
    #expect(roundtrip.slackLabels?.first?.hideFromInbox == true)
    let triage = try JSONDecoder().decode(SlackTriage.self, from: Data(#"""
    {"type":"question","label":null,"severity":"low","status":"done",
     "overrides":{"type":"question","label":null,"severity":"low","status":"done"}}
    """#.utf8))
    #expect(triage.type == .question)
    #expect(triage.status == .done)
    #expect(triage.overrides.clearLabel)
    let patch = TrackedItemPatch(slack: .init(type: .request, status: .inProgress, clearLabel: true))
    let json = try JSONValue.decode(JSONEncoder().encode(patch))
    #expect(json["slack"]?["type"]?.string == "request")
    #expect(json["slack"]?["status"]?.string == "in_progress")
    #expect(json["slack"]?["label"] == .null)
    let omitted = try JSONValue.decode(JSONEncoder().encode(TrackedItemPatch(slack: .init(severity: .critical))))
    #expect(omitted["slack"]?["label"] == nil)
    let correction = try JSONDecoder().decode(SlackCorrection.self, from: Data(#"""
    {"itemId":"item","summary":"Export help","correctedAt":123,"values":{"type":"question","label":null}}
    """#.utf8))
    #expect(correction.values.clearLabel)
    let row = DashboardTrackedItem(id: "item", title: "Export help", slack: triage)
    let decodedRow = try JSONDecoder().decode(DashboardTrackedItem.self, from: JSONEncoder().encode(row))
    #expect(TrackedItem(dashboard: decodedRow, projectId: "p", kind: .slack).slack == triage)
}

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
      "status":"sign_in_required","signInCommand":"pi mcp login linear",
      "signIn":{"kind":"linear","state":"waiting","again":true,"startedAt":1,"expiresAt":300001}}]}
    """#.utf8)
    guard case let .sources(sources) = try ServerUpdate.decode(source) else { Issue.record("Expected sources"); return }
    #expect(sources[0].status == .signInRequired)
    #expect(sources[0].signInCommand == "pi mcp login linear")
    #expect(sources[0].signIn == SourceSignIn(kind: .linear, state: .waiting, again: true, startedAt: 1,
                                              expiresAt: 300_001))
    let failed = try JSONDecoder().decode(SourceSignIn.self, from: Data(#"""
    {"kind":"slack","state":"future_state","startedAt":1,"expiresAt":2,"finishedAt":2,"error":"Sign-in timed out."}
    """#.utf8))
    #expect(failed.state == .failed)
    #expect(String(decoding: try JSONEncoder().encode(SourceSignInRequest(again: true)), as: UTF8.self)
        == #"{"again":true}"#)
    guard case let .trackedChanged(projectId) = try ServerUpdate.decode(Data(#"{"type":"tracked.changed","projectId":"p"}"#.utf8))
    else { Issue.record("Expected invalidation"); return }
    #expect(projectId == "p")
    #expect(try JSONDecoder().decode(DashboardSourceStatus.self, from: Data(#""idle""#.utf8)) == .idle)
    #expect(try JSONDecoder().decode(DashboardSourceStatus.self, from: Data(#""not_configured""#.utf8)) == .notConfigured)
}

@Test func trackingDecodesLinksChannelsAndLookups() throws {
    let item = try JSONDecoder().decode(TrackedItem.self, from: Data(#"""
    {"id":"i","projectId":"p","kind":"slack","externalId":"C1/1.000001","title":"Bug","url":"https://example.com",
     "status":"open","metadata":{},"dismissed":false,"sessionId":"s2","sessionIds":["s1","s2"],
     "createdAt":1,"updatedAt":2}
    """#.utf8))
    #expect(item.sessionIds == ["s1", "s2"])
    #expect(item.missionIds == nil)
    let source = try JSONDecoder().decode(TrackingSource.self, from: Data(#"""
    {"id":"p:slack","projectId":"p","kind":"slack","label":"Slack","configured":true,"status":"error",
     "channels":[{"id":"C1","name":"bugs","status":"ok","lastPulledAt":5},{"id":"C2","status":"sign_in_required"},
                 {"id":"C3","status":"future_state"}]}
    """#.utf8))
    #expect(source.channels?.map(\.status) == [.ok, .signInRequired, .error])
    #expect(source.channels?.first?.name == "bugs")
    let teams = try JSONDecoder().decode(TrackingLookup<LinearTeamOption>.self, from: Data(#"""
    {"status":"ok","items":[{"id":"t","name":"Platform","key":"PLT","parentId":"root"}],"more":true}
    """#.utf8))
    #expect(teams.items.first?.parentId == "root")
    #expect(teams.more == true)
    let channels = try JSONDecoder().decode(TrackingLookup<SlackChannelOption>.self, from: Data(#"""
    {"status":"sign_in_required","items":[],"error":"Sign in required","signInCommand":"pi mcp login slack"}
    """#.utf8))
    #expect(channels.status == .signInRequired)
    let option = try JSONDecoder().decode(SlackChannelOption.self, from: Data(#"{"id":"G1","name":"x","private":true}"#.utf8))
    #expect(option.isPrivate)
    let config = ProjectTrackingConfig(slackChannels: ["C1"], slackChannelNames: ["C1": "bugs"], linearTeam: "t",
                                       linearTeamName: "Platform")
    let json = try JSONValue.decode(JSONEncoder().encode(config))
    #expect(json["slackChannelNames"]?["C1"]?.string == "bugs")
    #expect(json["linearTeamName"]?.string == "Platform")
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
    let excerpt = try JSONDecoder().decode(SlackExcerpt.self, from: Data(#"""
    {"itemId":"i","author":"Sam","text":"Export fails…","truncated":true}
    """#.utf8))
    #expect(excerpt == SlackExcerpt(itemId: "i", author: "Sam", text: "Export fails…", truncated: true))
    #expect(try JSONDecoder().decode(SlackExcerpt.self, from: Data(#"{"itemId":"i","text":"","truncated":false}"#.utf8))
        .author == nil)
}

@Test func dashboardLinearGroupDecodesDoneAndConvertsRowsToItems() throws {
    let json = Data(#"""
    {"source":"linear","label":"Linear","status":"ok","total":3,
     "items":[{"id":"i1","title":"Open","url":"https://linear.app/a/issue/ENG-1","status":"In Progress",
               "updatedAt":20,"externalId":"uuid-1","metadata":{"identifier":"ENG-1","statusType":"started"},
               "sessionIds":["s1","s2"],"sessionId":"s2"}],
     "done":{"total":2,"items":[{"id":"i2","title":"Shipped","status":"Done","updatedAt":30}]}}
    """#.utf8)
    let source = try JSONDecoder().decode(DashboardTrackedSource.self, from: json)
    #expect(source.done?.total == 2)
    #expect(source.done?.hiddenCount == 1)
    let item = TrackedItem(dashboard: source.items[0], projectId: "p", kind: .linear)
    #expect(item.projectId == "p")
    #expect(item.kind == .linear)
    #expect(item.externalId == "uuid-1")
    #expect(item.metadata["identifier"] == .string("ENG-1"))
    #expect(item.sessionIds == ["s1", "s2"])
    #expect(!item.dismissed)
    let sparse = TrackedItem(dashboard: source.done!.items[0], projectId: "p", kind: .linear)
    #expect(sparse.externalId == "i2")
    #expect(sparse.url.isEmpty)
    #expect(sparse.updatedAt == 30)
    let slack = try JSONDecoder().decode(DashboardTrackedSource.self, from: Data(#"""
    {"source":"slack","label":"Slack","status":"ok","total":0,"items":[]}
    """#.utf8))
    #expect(slack.done == nil)
}

@Test func confirmedTrackedStartsAreExplicitAndErrorsDecodeInRowMetadata() throws {
    let linked = try JSONValue.decode(JSONEncoder().encode(TrackedItemPatch(missionId: "existing")))
    #expect(linked["start"] == nil)
    for patch in [TrackedItemPatch(sessionId: "chat", start: true), TrackedItemPatch(missionId: "mission", start: true)] {
        let json = try JSONValue.decode(JSONEncoder().encode(patch))
        #expect(json["start"] == .bool(true))
    }
    let item = try JSONDecoder().decode(TrackedItem.self, from: Data(#"""
    {"id":"i","projectId":"p","kind":"linear","externalId":"ENG-7","title":"Sample","url":"https://example.com",
     "status":"Todo","metadata":{"linearStart":{"outcome":"error","attemptedAt":1,
     "error":"Couldn't move ticket to In progress."}},"dismissed":false,"sessionId":"chat","createdAt":1,"updatedAt":2}
    """#.utf8))
    #expect(item.metadata["linearStart"]?["outcome"]?.string == "error")
    #expect(item.sessionId == "chat")
}

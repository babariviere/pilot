import Foundation
import PilotCore
import Testing

struct ControlChatProtocolTests {
    @Test func diagnosticBudgetsKeepReservationsSeparateFromLedgerCosts() throws {
        let source = """
        {"authorizations":[{"id":"a","scope":"Work","level":"implement","targets":[],"limits":{"followUps":2},"createdAt":1,"usage":{"followUps":0,"budgetUsd":0},"budget":{"reservedUsd":15,"releasedUsd":15},"spend":{"sessions":1,"observedSessions":1,"cost":{"estimateStatus":"catalog_estimate","estimatedUsdMicros":250000,"pricingRevision":"pi-ai@1.3.0","billedStatus":"unavailable","subscriptionCoverage":"unknown"},"coverage":"ledger_observed_partial"}}]}
        """
        let page = try JSONDecoder().decode(ControlAuthorizationsResponse.self, from: Data(source.utf8))
        let record = try #require(page.authorizations.first)
        #expect(record.limits.budgetUsd == nil)
        #expect(record.budget?.reservedUsd == 15)
        #expect(record.budget?.releasedUsd == 15)
        #expect(record.usage.budgetUsd == 0)
        #expect(record.spend?.cost.estimatedUsdMicros == 250000)
        #expect(record.spend?.cost.billedUsdMicros == nil)
        let provenance = try JSONDecoder().decode(ControlStartBudget.self, from: Data(#"{"authorizationId":"a"}"#.utf8))
        #expect(provenance.budgetUsd == nil)
        let roundTrip = try JSONDecoder().decode(ControlAuthorizationsResponse.self, from: JSONEncoder().encode(page))
        #expect(roundTrip == page)
    }
    @Test func authorizationRecordsRoundTripIncludingRevokedAndLegacyWatches() throws {
        for level in ControlAuthorizationLevel.allCases {
            let source = """
            {"authorizations":[{"id":"auth:1","userMessage":{"conversationId":"1","submissionId":10,"entryId":20,"requestId":"typed"},"scope":"Fix the failure","level":"\(level.rawValue)","targets":[{"kind":"task","id":"2","missionId":"m"}],"limits":{"followUps":2,"budgetUsd":3},"createdAt":1000,"expiresAt":2000,"revokedAt":1500,"usage":{"followUps":1,"budgetUsd":0.5}},{"id":"watch:w","watchId":"w","scope":"Saved note","level":"publish","targets":[{"kind":"chat","id":"c"}],"limits":{"followUps":2},"createdAt":1,"usage":{"followUps":0,"budgetUsd":0}}],"next":"watch:w"}
            """
            let page = try JSONDecoder().decode(ControlAuthorizationsResponse.self, from: Data(source.utf8))
            let record = try #require(page.authorizations.first)
            #expect(record.level == level)
            #expect(record.userMessage?.entryId == 20)
            #expect(record.limits.followUps == 2)
            #expect(record.usage.budgetUsd == 0.5)
            #expect(record.revokedAt == 1500)
            #expect(page.authorizations.last?.userMessage == nil)
            #expect(page.authorizations.last?.limits.budgetUsd == nil)
            let roundTrip = try JSONDecoder().decode(ControlAuthorizationsResponse.self, from: JSONEncoder().encode(page))
            #expect(roundTrip == page)
        }
        let revoked = try JSONDecoder().decode(RevokeControlAuthorizationResponse.self, from: Data(#"{"revoked":false}"#.utf8))
        #expect(!revoked.revoked)
        let audit = try JSONDecoder().decode(ControlAuditEntry.self, from: Data(#"{"seq":1,"operationId":"op","authorizationId":"auth:1","action":"send","phase":"requested","at":1,"caller":"c","args":{}}"#.utf8))
        #expect(audit.authorizationId == "auth:1")
    }
    @Test func watchNoticesRenderAsEventsAndControlInputStaysAutomatic() async throws {
        let source = #"{"type":"snapshot","entries":[{"id":1,"kind":"pi.user","origin":"watch","data":{"event":{"kind":"watch_notice","text":"1 event fired"}},"model":[{"role":"user","timestamp":1,"content":"Saved note and quoted event"}]},{"id":2,"kind":"pi.user","origin":"control","model":[{"role":"user","timestamp":2,"content":"Continue the work"}]}]}"#
        let result = try await TranscriptProcessor().apply([try JSONValue.decode(Data(source.utf8))])
        #expect(result.rows == [
            .event(ChatEvent(id: "1-0", kind: "watch_notice", text: "1 event fired", timestamp: 1, detail: "Saved note and quoted event")),
            .automatic(id: "2-0", text: "Continue the work", origin: .control, timestamp: 2),
        ])
    }

    @Test func watchKindsAndOptionalFieldsRoundTrip() throws {
        let decoder = JSONDecoder()
        for event in WatchEvent.allCases {
            let source = """
            {"watches":[{"id":"w","createdAt":1000,"event":"\(event.rawValue)","target":{"kind":"task","id":"7","missionId":"m"},"filter":{"outcome":"failed"},"mode":"persistent","note":"Continue","expiresAt":2000}],"next":"w"}
            """
            let page = try decoder.decode(WatchesResponse.self, from: Data(source.utf8))
            let watch = try #require(page.watches.first)
            #expect(watch.event == event)
            #expect(watch.target.missionId == "m")
            #expect(watch.filter?.outcome == .failed)
            #expect(watch.expiresAt == 2000)
            #expect(page.next == "w")
            let roundTrip = try decoder.decode(WatchesResponse.self, from: JSONEncoder().encode(page))
            #expect(roundTrip == page)
        }
        for kind in ["chat", "project", "mission", "pr", "chat_prs", "linear", "task"] {
            let target = try decoder.decode(WatchTarget.self, from: Data(#"{"kind":"\#(kind)","id":"x"}"#.utf8))
            #expect(target.kind.rawValue == kind)
            #expect(target.missionId == nil)
        }
        let minimal = try decoder.decode(Watch.self, from: Data(#"{"id":"w","createdAt":1,"event":"linear.done","target":{"kind":"linear","id":"ABC-1"},"mode":"once","note":"Continue"}"#.utf8))
        #expect(minimal.filter == nil)
        #expect(minimal.expiresAt == nil)
        let empty = try decoder.decode(WatchesResponse.self, from: Data(#"{"watches":[]}"#.utf8))
        #expect(empty.next == nil)
        #expect(empty.watches.isEmpty)
        let canceled = try decoder.decode(CancelWatchResponse.self, from: Data(#"{"removed":false}"#.utf8))
        #expect(!canceled.removed)
    }

    @Test func auditPreservesArbitraryArgumentsAndOutcomes() throws {
        let source = #"[{"seq":2,"operationId":"c:call","action":"memory_note","phase":"succeeded","at":1234,"caller":"c","args":{"projectId":"p","text":"Saved","replaces":[1]},"result":{"ok":true}},{"seq":1,"operationId":"c:call","action":"memory_note","phase":"requested","at":1233,"caller":"c","args":{}}]"#
        let page = try JSONDecoder().decode(ControlAuditResponse.self, from: Data(source.utf8))
        #expect(page.map(\.seq) == [2, 1])
        #expect(page[0].phase == .succeeded)
        #expect(page[0].args["replaces"]?.array?.first?.int == 1)
        #expect(page[0].result?["ok"]?.bool == true)
        #expect(page[1].result == nil)
        let roundTrip = try JSONDecoder().decode(ControlAuditResponse.self, from: JSONEncoder().encode(page))
        #expect(roundTrip == page)
    }

    @Test func controlAndModelSwitchUseExistingSessionFrames() throws {
        let source = #"{"type":"session","session":{"id":"control","title":"Control","cwd":"","mode":"ask","pinned":true,"control":true,"createdAt":1,"updatedAt":2,"state":"parked","model":"new/model","attempts":[{"id":"1"},{"id":"2","reason":"model","active":true}]}}"#
        guard case let .session(chat) = try ServerUpdate.decode(Data(source.utf8)) else {
            Issue.record("Missing control session"); return
        }
        #expect(chat.control == true)
        #expect(chat.projectId == nil)
        #expect(chat.attempts?.last?.reason == .model)
        let response = try JSONDecoder().decode(ChangeModelResponse.self, from: JSONEncoder().encode(chat))
        #expect(response.attempts?.last?.isActive == true)
        let old = #"{"id":"ordinary","title":"Old","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"parked"}"#
        let ordinary = try JSONDecoder().decode(ControlChatResponse.self, from: Data(old.utf8))
        #expect(ordinary.control == nil)
    }

    @Test func invalidationsAndNoticeSummaryDecode() throws {
        guard case .watchesChanged = try ServerUpdate.decode(Data(#"{"type":"watches.changed"}"#.utf8)) else {
            Issue.record("Missing watch invalidation"); return
        }
        guard case .controlAuditChanged = try ServerUpdate.decode(Data(#"{"type":"control-audit.changed"}"#.utf8)) else {
            Issue.record("Missing audit invalidation"); return
        }
        guard case .controlMemoryChanged = try ServerUpdate.decode(Data(#"{"type":"control-memory.changed"}"#.utf8)) else {
            Issue.record("Missing memory invalidation"); return
        }
        let summary = ChatEventSummary(json: try JSONValue.decode(Data(#"{"kind":"watch_notice","text":"1 event fired"}"#.utf8)))
        #expect(summary?.kind == "watch_notice")
        #expect(summary?.text == "1 event fired")
    }

    @Test func memoryPagesDecode() throws {
        let decoder = JSONDecoder()
        let view = try decoder.decode(ControlMemoryViewResponse.self, from: Data(#"{"lines":[{"id":0,"n":4,"text":"user: hi"},{"id":4,"n":1,"text":"","pending":true}]}"#.utf8))
        #expect(view.lines.map(\.id) == ["0+4", "4+1"])
        #expect(view.lines[0].end == 3)
        #expect(!view.lines[0].isPending)
        #expect(view.lines[1].isPending)

        let halves = try decoder.decode(ControlMemoryNodeResponse.self, from: Data(#"{"lines":[{"id":0,"n":2,"text":"a"},{"id":2,"n":2,"text":"b"}]}"#.utf8))
        #expect(halves.lines?.map(\.start) == [0, 2])
        #expect(halves.page == nil)
        let message = try decoder.decode(ControlMemoryNodeResponse.self, from: Data(#"{"message":{"id":3,"at":1000,"kind":"tool","text":"{\"name\":\"read\"}","name":"read"},"format":"json","next":12000}"#.utf8))
        let page = try #require(message.page)
        #expect(page.message.kind == .tool)
        #expect(page.message.name == "read")
        #expect(page.format == "json")
        #expect(page.next == 12000)
        #expect(message.lines == nil)

        let log = try decoder.decode(ControlMemoryMessagesResponse.self, from: Data(#"{"messages":[{"id":2,"at":5,"kind":"tool","text":"ok","name":"grep","input":"{\"q\":1}","clipped":true},{"id":1,"at":4,"kind":"event","text":"fired"}],"next":1}"#.utf8))
        #expect(log.messages.map(\.id) == [2, 1])
        #expect(log.messages[0].input == #"{"q":1}"#)
        #expect(log.messages[0].clipped == true)
        #expect(log.messages[1].name == nil)
        #expect(log.next == 1)
        let last = try decoder.decode(ControlMemoryMessagesResponse.self, from: Data(#"{"messages":[]}"#.utf8))
        #expect(last.next == nil)
        for kind in ControlMemoryKind.allCases {
            let entry = try decoder.decode(ControlMemoryLogEntry.self, from: Data(#"{"id":0,"at":1,"kind":"\#(kind.rawValue)","text":""}"#.utf8))
            #expect(entry.kind == kind)
        }

        let stats = try decoder.decode(ControlMemoryStats.self, from: Data(#"{"count":3,"pendingJobs":1,"failedJobs":0,"viewBytes":120,"merging":false,"dbBytes":4096,"oldestAt":10,"newestAt":20}"#.utf8))
        #expect(stats.count == 3)
        #expect(stats.oldestAt == 10)
        let empty = try decoder.decode(ControlMemoryStats.self, from: Data(#"{"count":0,"pendingJobs":0,"failedJobs":0,"viewBytes":0,"merging":true,"dbBytes":0}"#.utf8))
        #expect(empty.merging)
        #expect(empty.newestAt == nil)
        #expect(try decoder.decode(ControlMemoryStats.self, from: JSONEncoder().encode(stats)) == stats)
    }

    @Test func controlChatListsApartWithoutArchiveOrPinActions() throws {
        let source = #"{"id":"c","title":"Control","cwd":"","mode":"ask","pinned":true,"control":true,"createdAt":1,"updatedAt":5,"state":"parked","outcome":"done","outcomeAt":5}"#
        let control = try JSONDecoder().decode(SessionSummary.self, from: Data(source.utf8))
        #expect(control.isControl)
        #expect(!control.canArchive)
        #expect(!control.canChangePin)
        let pinned = SessionSummary(id: "p", title: "Pinned", cwd: "/tmp", projectId: "x", createdAt: 1, updatedAt: 4,
                                    state: "parked", mode: .ask, pinned: true)
        #expect(!pinned.isControl)
        #expect(pinned.canArchive)
        #expect(pinned.canChangePin)

        let groups = SidebarUrgency.groups([control, pinned], unread: { _ in true })
        #expect(groups.control == control)
        #expect(groups.pinned == [pinned])
        #expect(groups.needsYou.isEmpty)
        // Counts that must match pilotd's still include it by state.
        let counted = SidebarUrgency.groups([control, pinned], unread: { _ in true }, separatingPinned: false)
        #expect(counted.control == nil)
        #expect(counted.needsYou.map(\.id) == ["c", "p"])

        // Its scope, then its reason. No Ask source, project, PR or branch.
        let segments = RowLineSegments.session(control, projectName: "pilot", reason: "Read result", branch: "main")
        #expect(segments.map(\.kind) == [.text(ControlChatIdentity.scope), .reason("Read result")])
    }
}

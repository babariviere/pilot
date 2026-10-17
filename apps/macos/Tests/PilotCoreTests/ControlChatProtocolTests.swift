import Foundation
import PilotCore
import Testing

struct ControlChatProtocolTests {
    @Test func watchNoticesRenderAsEventsAndControlInputStaysAutomatic() async throws {
        let source = #"{"type":"snapshot","entries":[{"id":1,"kind":"pi.user","origin":"watch","data":{"event":{"kind":"watch_notice","text":"1 watch fired"}},"model":[{"role":"user","timestamp":1,"content":"Saved note and quoted event"}]},{"id":2,"kind":"pi.user","origin":"control","model":[{"role":"user","timestamp":2,"content":"Continue the work"}]}]}"#
        let result = try await TranscriptProcessor().apply([try JSONValue.decode(Data(source.utf8))])
        #expect(result.rows == [
            .event(ChatEvent(id: "1-0", kind: "watch_notice", text: "1 watch fired", timestamp: 1, detail: "Saved note and quoted event")),
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
        let summary = ChatEventSummary(json: try JSONValue.decode(Data(#"{"kind":"watch_notice","text":"Watch fired"}"#.utf8)))
        #expect(summary?.kind == "watch_notice")
        #expect(summary?.text == "Watch fired")
    }
}

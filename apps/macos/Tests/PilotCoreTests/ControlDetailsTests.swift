import Foundation
import PilotCore
import Testing

struct ControlDetailsTests {
    private func entry(_ seq: Int, _ operation: String, _ action: String, _ phase: ControlAuditEntry.Phase, at: Double,
                       args: String = "{}", result: String? = nil) throws -> ControlAuditEntry {
        let resultField = result.map { ",\"result\":" + $0 } ?? ""
        let json = #"{"seq":\#(seq),"operationId":"\#(operation)","action":"\#(action)","phase":"\#(phase.rawValue)","at":\#(at),"caller":"c","args":\#(args)"#
            + resultField + "}"
        return try JSONDecoder().decode(ControlAuditEntry.self, from: Data(json.utf8))
    }

    @Test func auditFoldsPhasesIntoOneOperationEachNewestFirst() throws {
        let entries = [
            try entry(5, "c:b", "memory_note", .failed, at: 50, args: #"{"projectId":"p","text":"Saved\n  note"}"#,
                      result: #"{"error":"Project removed"}"#),
            try entry(4, "c:a", "start", .succeeded, at: 40, args: #"{"projectId":"p","message":"Fix the sheet"}"#,
                      result: #"{"sessionId":"s1","chatUrl":"pilot://chat/s1"}"#),
            try entry(3, "c:b", "memory_note", .requested, at: 30, args: #"{"projectId":"p","text":"Saved\n  note"}"#),
            try entry(2, "c:c", "send", .requested, at: 20, args: #"{"sessionId":"s2","message":"Continue"}"#),
            // Its requested entry sits on the next page; the newer outcome still wins.
            try entry(1, "c:a", "start", .requested, at: 10, args: #"{"projectId":"p","message":"Fix the sheet"}"#),
        ]
        let operations = ControlAuditOperation.fold(entries)
        #expect(operations.map(\.operationId) == ["c:b", "c:a", "c:c"])
        #expect(operations[0].phase == .failed)
        #expect(operations[0].title == "Added a memory note")
        #expect(operations[0].detail == "Saved note")
        #expect(operations[0].error == "Project removed")
        #expect(operations[0].oldestSeq == 3)
        #expect(operations[1].phase == .succeeded)
        #expect(operations[1].chatId == "s1")
        #expect(operations[1].error == nil)
        #expect(operations[1].oldestSeq == 1)
        #expect(operations[2].phase == .requested)
        #expect(operations[2].chatId == "s2")
        #expect(operations[2].projectId == nil)
        #expect(ControlAuditOperation.title(for: "mission_attach") == "Added a chat to a mission")
        #expect(ControlAuditOperation.title(for: "future_action") == "Future action")
    }

    @Test func auditDetailIsClippedToOneLine() throws {
        let long = String(repeating: "word ", count: 100)
        let operation = try #require(ControlAuditOperation.fold([
            try entry(1, "c:x", "mission_create", .succeeded, at: 1, args: #"{"goal":"\#(long)"}"#,
                      result: #"{"missionId":"m"}"#),
        ]).first)
        let detail = try #require(operation.detail)
        #expect(detail.count <= ControlAuditOperation.detailLimit + 1)
        #expect(detail.hasSuffix("…"))
        #expect(operation.missionId == "m")
    }

    @Test func watchTriggersPreserveAcronymsAndProperNames() {
        #expect(WatchPresentation.trigger(.prReady) == "When PR is ready to merge")
        #expect(WatchPresentation.trigger(.prMerged) == "When PR merges")
        #expect(WatchPresentation.trigger(.prClosed) == "When PR closes")
        #expect(WatchPresentation.trigger(.linearDone) == "When Linear issue is done")
        #expect(WatchPresentation.trigger(.chatSettled) == "When chat settles")
        #expect(WatchPresentation.trigger(.chatFailed) == "When chat fails")
        #expect(WatchPresentation.trigger(.missionTaskDone) == "When task is done")
        #expect(WatchPresentation.trigger(.missionDone) == "When mission is done")
    }

    @Test func watchesReadAsWhenAndWhat() throws {
        let watch = try JSONDecoder().decode(Watch.self, from: Data(#"{"id":"w","createdAt":1,"event":"chat.settled","target":{"kind":"chat","id":"s"},"filter":{"outcome":"failed"},"mode":"once","note":"  Retry   it  "}"#.utf8))
        #expect(WatchPresentation.event(watch.event, filter: watch.filter) == "Chat fails")
        #expect(WatchPresentation.trigger(watch.event, filter: watch.filter) == "When chat fails")
        #expect(WatchPresentation.event(.chatSettled) == "Chat settles")
        #expect(WatchPresentation.mode(watch) == "Once")
        #expect(WatchPresentation.note(watch) == "Retry it")
        #expect(WatchPresentation.pullRequest("https://github.com/acme/app/pull/12") == "acme/app#12")
        #expect(WatchPresentation.pullRequest("not a url") == "not a url")

        let names = ["s": "Fix sheet", "p": "pilot", "m": "Launch"]
        func name(_ target: WatchTarget) -> String {
            WatchPresentation.target(target, chat: { names[$0] }, project: { names[$0] }, mission: { names[$0] })
        }
        func target(_ kind: String, _ id: String, mission: String? = nil) throws -> WatchTarget {
            let missionField = mission.map { #","missionId":"\#($0)""# } ?? ""
            return try JSONDecoder().decode(WatchTarget.self, from: Data(#"{"kind":"\#(kind)","id":"\#(id)"\#(missionField)}"#.utf8))
        }
        #expect(name(try target("chat", "s")) == "Fix sheet")
        #expect(name(try target("chat", "gone")) == "A chat")
        #expect(name(try target("chat_prs", "s")) == "PRs of Fix sheet")
        #expect(name(try target("project", "p")) == "Chats in pilot")
        #expect(name(try target("mission", "m")) == "Mission Launch")
        #expect(name(try target("pr", "https://github.com/acme/app/pull/3")) == "acme/app#3")
        #expect(name(try target("linear", "ABC-1")) == "ABC-1")
        #expect(name(try target("task", "t", mission: "m")) == "A task in Launch")
        #expect(name(try target("task", "t")) == "A mission task")
    }
}

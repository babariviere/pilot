import Foundation
import Testing
@testable import PilotCore

private func json(_ text: String) -> JSONValue {
    try! JSONValue.decode(Data(text.utf8))
}

@Test func githubAuditUsesBoundedReplacementWithoutChangingMessages() {
    var transcript = Transcript()
    transcript.apply(json(#"{"type":"snapshot","entries":[{"id":10,"kind":"pi.user","model":[{"role":"user","content":"Work"}]}],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{}}"#))
    let event = json(#"{"type":"github_actions_update","actions":[{"id":"call:0","summary":"gh pr ready","description":"marked PR #12 ready","target":"PR #12","at":1000,"exitCode":0},{"id":"call:1","summary":"gh pr edit","description":"edited PR #12","at":2000,"exitCode":1},{"id":"call:2","summary":"git push","description":"pushed branches","at":3000,"exitCode":null}]}"#)
    transcript.apply(event)
    transcript.apply(event)
    #expect(transcript.entries.count == 4)
    #expect(transcript.entries[1].activity?.contains("marked PR #12 ready") == true)
    #expect(transcript.entries[2].activity?.contains("attempted: edited PR #12 (failed, exit 1)") == true)
    #expect(transcript.entries[3].activity?.contains("exit status unknown") == true)
    #expect(transcript.rows.contains { if case let .notice(_, text) = $0 { return text.contains("marked PR #12 ready") }; return false })
    transcript.apply(json(#"{"type":"github_actions_update","actions":[]}"#))
    #expect(transcript.entries.count == 1)
    #expect(transcript.entries[0].messages[0].text == "Work")
}

@Test func githubAuditStaysBoundedAndDoesNotCopyHistoryForStreamingDeltas() {
    var transcript = Transcript()
    let messages = (1...2000).map { id in JSONValue.object([
        "id": .number(Double(id)), "kind": .string("pi.user"),
        "model": .array([.object(["role": .string("user"), "content": .string(String(repeating: "context ", count: 64))])]),
    ]) }
    transcript.apply(.object(["type": .string("snapshot"), "entries": .array(messages)]))
    let actions = (0..<300).map { id in JSONValue.object([
        "id": .string("call:\(id)"), "summary": .string("gh pr ready"),
        "description": .string("marked PR #\(id + 1) ready"), "at": .number(1000), "exitCode": .number(0),
    ]) }
    transcript.apply(.object(["type": .string("github_actions_update"), "actions": .array(actions)]))
    #expect(transcript.entries.count == 2200)
    #expect(transcript.entries[2000].activity?.contains("PR #101 ready") == true)
    let committed = transcript.committedRowRevision
    let buffer = transcript.entries.withUnsafeBufferPointer { $0.baseAddress }
    transcript.apply(json(#"{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":""}]}}"#))
    let delta = json(#"{"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":"a"}]}"#)
    for _ in 0..<1000 { transcript.apply(delta) }
    #expect(transcript.committedRowRevision == committed)
    #expect(transcript.entries.withUnsafeBufferPointer { $0.baseAddress } == buffer)
    #expect(transcript.streaming?.text.count == 1000)
    transcript.apply(.object(["type": .string("snapshot"), "entries": .array(messages)]))
    #expect(transcript.entries.count == 2200, "activity survives replacement snapshots without becoming paginated history")
}

@Test func streamsTextDeltasAndCommitsTheEntryOnce() {
    var transcript = Transcript()
    transcript.apply([
        json(#"{"type":"snapshot","entries":[],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{}}"#),
        json(#"{"type":"run_start","inputs":[]}"#),
        json(#"{"type":"message_start","message":{"role":"assistant","content":[]}}"#),
        json(#"{"type":"message_update","changes":[{"type":"text_start","contentIndex":0,"block":{"type":"text","text":""}}]}"#),
        json(#"{"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":"Hello"}]}"#),
        json(#"{"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":" world"}]}"#),
    ])
    #expect(transcript.working)
    #expect(transcript.streaming?.text == "Hello world")

    let entry = #"{"id":2,"conversationId":0,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"Hello world"}]}]}"#
    transcript.apply([
        json(#"{"type":"message_end","entry":\#(entry)}"#),
        json(#"{"type":"entry_appended","entry":\#(entry)}"#),
        json(#"{"type":"run_end","inputs":[]}"#),
    ])
    #expect(transcript.streaming == nil)
    #expect(transcript.entries.count == 1)
    #expect(!transcript.working)
}


@Test func tracksRunningCompactionsFromSnapshotsAndEvents() {
    var transcript = Transcript()
    transcript.apply(json(#"{"type":"snapshot","entries":[],"tools":[],"compactions":[{"taskId":4,"reason":"manual","blocking":false,"attempt":1}],"inbox":[],"agent":{},"usage":{}}"#))
    #expect(transcript.compacting)
    #expect(!transcript.working, "a manual compaction runs without a run")
    transcript.apply([
        json(#"{"type":"compaction_start","taskId":9,"reason":"threshold","blocking":true}"#),
        json(#"{"type":"compaction_end","taskId":4,"reason":"manual"}"#),
    ])
    #expect(transcript.compacting)
    transcript.apply(json(#"{"type":"compaction_end","taskId":9,"reason":"threshold"}"#))
    #expect(!transcript.compacting)
    #expect(TranscriptPresentation(transcript: transcript).compacting == false)
}

private func user(_ id: Int, _ text: String) -> String {
    #"{"id":\#(id),"kind":"pi.user","model":[{"role":"user","content":"\#(text)"}]}"#
}

private func compactedSnapshot(head: Int, marker: Int, after: [Int] = []) -> JSONValue {
    let kept = ([head] + after).map { user($0, "m\($0)") }
    let entries = [#"{"id":\#(marker),"kind":"pi.compaction","head":\#(head),"data":{"summary":"s"}}"#] + kept
    return json(#"{"type":"snapshot","entries":[\#(entries.joined(separator: ","))],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{}}"#)
}

private func page(before: Int, ids: [Int], more: Bool) -> JSONValue {
    let entries = ids.map { user($0, "m\($0)") }.joined(separator: ",")
    return Transcript.earlierEntries(before: before, page: json(#"{"entries":[\#(entries)],"more":\#(more)}"#))
}

@Test func onlyCompactedOrResetTranscriptsOfferEarlierMessages() {
    var transcript = Transcript()
    transcript.apply(json(#"{"type":"snapshot","entries":[\#(user(1, "a"))],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{}}"#))
    #expect(transcript.earlierCursor == nil)
    transcript.apply(compactedSnapshot(head: 6, marker: 9))
    #expect(transcript.earlierCursor == 6, "the cursor starts at the first kept entry")
    #expect(TranscriptPresentation(transcript: transcript).earlierCursor == 6)
}

@Test func earlierPagesPrependInOrderAndIgnoreStaleCursors() {
    var transcript = Transcript()
    transcript.apply(compactedSnapshot(head: 6, marker: 9, after: [10]))
    transcript.apply(page(before: 99, ids: [1], more: false))
    #expect(transcript.entries.map(\.id) == [6, 9, 10], "a page for another cursor is ignored")

    transcript.apply(page(before: 6, ids: [4, 5], more: true))
    #expect(transcript.entries.map(\.id) == [4, 5, 6, 9, 10])
    #expect(transcript.earlierCursor == 4)
    transcript.apply(page(before: 6, ids: [4, 5], more: true))
    #expect(transcript.entries.map(\.id) == [4, 5, 6, 9, 10], "a duplicate page is applied once")

    transcript.apply(page(before: 4, ids: [2, 3], more: false))
    #expect(transcript.entries.map(\.id) == [2, 3, 4, 5, 6, 9, 10])
    #expect(transcript.earlierCursor == nil, "the last page clears the cursor")
    #expect(transcript.rows.first?.id == "2-0", "earlier messages render before the kept ones")
}

@Test func processorPublishesEarlierPagesAndTheirCursor() async throws {
    let processor = TranscriptProcessor()
    let first = try await processor.apply([compactedSnapshot(head: 6, marker: 9)])
    #expect(first.earlierCursor == 6)
    let loaded = try await processor.apply([page(before: 6, ids: [5], more: false)])
    #expect(loaded.earlierCursor == nil)
    #expect(loaded.revision != first.revision)
    #expect(loaded.rows.first?.id == "5-0")
    let empty = try await processor.apply([page(before: 6, ids: [], more: false)])
    #expect(empty == loaded, "a stale page publishes nothing new")
}

@Test func emptyEarlierPageEndsPaging() {
    var transcript = Transcript()
    transcript.apply(compactedSnapshot(head: 6, marker: 9))
    transcript.apply(page(before: 6, ids: [], more: true))
    #expect(transcript.earlierCursor == nil)
}

@Test func replacementSnapshotsKeepEarlierPagesOnlyForTheSameHead() {
    var transcript = Transcript()
    transcript.apply(compactedSnapshot(head: 6, marker: 9))
    transcript.apply(page(before: 6, ids: [4, 5], more: true))
    transcript.apply(compactedSnapshot(head: 6, marker: 9, after: [10]))
    #expect(transcript.entries.map(\.id) == [4, 5, 6, 9, 10], "a reconnect keeps loaded pages")
    #expect(transcript.earlierCursor == 4)

    transcript.apply(compactedSnapshot(head: 10, marker: 11))
    #expect(transcript.entries.map(\.id) == [10, 11], "a new compaction starts paging again from its head")
    #expect(transcript.earlierCursor == 10)
}

@Test func tracksToolOutputWindowsAndResults() {
    var transcript = Transcript()
    transcript.apply([
        json(#"{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls"}}"#),
        json(#"{"type":"tool_execution_update","toolCallId":"c1","toolName":"bash","output":{"append":"abc"}}"#),
        json(#"{"type":"tool_execution_update","toolCallId":"c1","toolName":"bash","output":{"trimStart":1,"append":"d"}}"#),
    ])
    #expect(transcript.tools["c1"]?.output == "bcd")
    transcript.apply(json(#"{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","entry":{"id":5,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"ok"}],"isError":false}]}}"#))
    #expect(transcript.tools["c1"]?.status == "done")
    #expect(transcript.results["c1"]?.text == "ok")
}

@Test func userContentMayBeAPlainString() {
    let entry = Entry(json: json(#"{"id":1,"kind":"pi.user","model":[{"role":"user","content":"hi"}]}"#))
    #expect(entry?.messages.first?.text == "hi")
}

@Test func displaysAllQueuedMessagesAndReplacesThemAsTheyDrain() {
    var transcript = Transcript()
    transcript.apply(json(#"{"type":"queue_update","items":[{"id":10,"mode":"followUp","content":"Run tests\nReport failures"},{"id":11,"mode":"steer","content":[{"type":"text","text":"Check lint"},{"type":"image"}]}]}"#))
    #expect(transcript.queued == 2)
    #expect(transcript.queuedMessages.map(\.id) == [10, 11])
    #expect(transcript.queuedMessages.map(\.mode) == [.followUp, .steer])
    #expect(transcript.queuedMessages.map(\.text) == ["Run tests\nReport failures", "Check lint[image]"])

    // Content-free agent queue events must not race the separate content watch.
    transcript.apply(json(#"{"type":"inbox_update","items":[]}"#))
    #expect(transcript.queued == 2)
    transcript.apply(json(#"{"type":"queue_update","items":[{"id":11,"mode":"steer","content":"Check lint"}]}"#))
    #expect(transcript.queuedMessages.map(\.id) == [11])
    transcript.apply(json(#"{"type":"queue_update","items":[]}"#))
    #expect(transcript.queuedMessages.isEmpty)
    #expect(transcript.queued == 0)
}

@Test func queueSurvivesAgentSnapshotsAndRefreshesOnReconnect() {
    var transcript = Transcript()
    let queue = json(#"{"type":"queue_update","items":[{"id":10,"mode":"followUp","content":"Run tests"}]}"#)
    transcript.apply(queue)
    transcript.apply(json(#"{"type":"snapshot","entries":[],"tools":[],"inbox":[{"id":10,"mode":"followUp"}]}"#))
    #expect(transcript.queuedMessages.first?.text == "Run tests")

    var reconnected = Transcript()
    reconnected.apply([
        json(#"{"type":"snapshot","entries":[],"tools":[],"inbox":[{"id":10,"mode":"followUp"}]}"#),
        queue,
    ])
    #expect(reconnected.queuedMessages == transcript.queuedMessages)
    reconnected.apply([
        json(#"{"type":"snapshot","entries":[],"tools":[],"inbox":[]}"#),
        json(#"{"type":"queue_update","items":[]}"#),
    ])
    #expect(reconnected.queuedMessages.isEmpty)
}

@Test func editedQueueContentUpdatesWithoutChangingIdentityOrOrder() throws {
    var transcript = Transcript()
    transcript.apply(json(#"{"type":"queue_update","items":[{"id":10,"mode":"followUp","content":"Original"},{"id":11,"mode":"steer","content":"Unchanged"}]}"#))
    transcript.apply(json(#"{"type":"queue_update","items":[{"id":10,"mode":"followUp","content":"Edited\nDetails"},{"id":11,"mode":"steer","content":"Unchanged"}]}"#))
    #expect(transcript.queuedMessages.map(\.id) == [10, 11])
    #expect(transcript.queuedMessages.map(\.mode) == [.followUp, .steer])
    #expect(transcript.queuedMessages.map(\.text) == ["Edited\nDetails", "Unchanged"])
    #expect(transcript.queuedMessagesInDeliveryOrder.map(\.id) == [11, 10])
    #expect(transcript.entries.isEmpty)
    let request = EditQueuedMessageRequest(message: "Edited\nDetails")
    let encoded = try JSONValue.decode(JSONEncoder().encode(request))
    #expect(encoded == .object(["message": .string("Edited\nDetails")]))
    let switched = EditQueuedMessageRequest(message: "Edited", mode: .followUp)
    #expect(try JSONValue.decode(JSONEncoder().encode(switched))
        == .object(["message": .string("Edited"), "mode": .string("followUp")]))
}

@Test func queueDisplayPrioritizesSteeringAndPreservesOrderWithinEachMode() {
    var transcript = Transcript()
    transcript.apply(json(#"{"type":"queue_update","items":[{"id":10,"mode":"followUp","content":"First follow-up"},{"id":11,"mode":"steer","content":"First steering"},{"id":12,"mode":"followUp","content":"Second follow-up"},{"id":13,"mode":"steer","content":"Second steering"},{"id":14,"mode":"followUp","content":"Third follow-up"}]}"#))
    #expect(transcript.queuedMessagesInDeliveryOrder.map(\.id) == [11, 13, 10, 12, 14])
    #expect(transcript.queuedMessages.map(\.id) == [10, 11, 12, 13, 14])
    #expect(transcript.queued == 5)

    transcript.apply(json(#"{"type":"queue_update","items":[{"id":10,"mode":"followUp","content":"First follow-up"},{"id":12,"mode":"followUp","content":"Second follow-up"},{"id":14,"mode":"followUp","content":"Third follow-up"}]}"#))
    #expect(transcript.queuedMessagesInDeliveryOrder.map(\.id) == [10, 12, 14])
    transcript.apply(json(#"{"type":"queue_update","items":[]}"#))
    #expect(transcript.queuedMessagesInDeliveryOrder.isEmpty)
}

private func split(_ snapshot: JSONValue, tail: Int) -> [JSONValue] {
    guard case var .object(head) = snapshot, let entries = snapshot["entries"]?.array else { return [snapshot] }
    head["entries"] = .array(Array(entries.suffix(tail)))
    head["prefixPending"] = .bool(true)
    return [.object(head), .object(["type": .string("snapshot_prefix"), "entries": .array(Array(entries.dropLast(tail)))])]
}

@Test func splitSnapshotsPaintTheTailFirstThenMatchTheWholeSnapshot() {
    let whole = compactedSnapshot(head: 6, marker: 9, after: [10, 11, 12])
    var expected = Transcript()
    expected.apply(whole)

    var transcript = Transcript()
    let parts = split(whole, tail: 2)
    transcript.apply(parts[0])
    #expect(transcript.entries.map(\.id) == [11, 12], "the newest entries paint first")
    #expect(transcript.earlierCursor == nil, "no earlier page before the snapshot is complete")
    transcript.apply(page(before: 6, ids: [5], more: false))
    #expect(transcript.entries.map(\.id) == [11, 12], "a page cannot apply to a partial snapshot")
    transcript.apply(parts[1])
    #expect(transcript == expected)
    #expect(transcript.earlierCursor == 6)
    transcript.apply(json(#"{"type":"snapshot_prefix","entries":[\#(user(1, "late"))]}"#))
    #expect(transcript == expected, "a prefix without a pending split snapshot is ignored")
}

@Test func splitReplacementSnapshotsKeepLoadedEarlierPagesForTheSameHead() {
    var transcript = Transcript()
    transcript.apply(compactedSnapshot(head: 6, marker: 9, after: [10]))
    transcript.apply(page(before: 6, ids: [4, 5], more: true))
    #expect(transcript.earlierCursor == 4)
    // A reconnect snapshot, split, and replaced again before its prefix arrived.
    transcript.apply(split(compactedSnapshot(head: 6, marker: 9, after: [10, 11]), tail: 1)[0])
    let parts = split(compactedSnapshot(head: 6, marker: 9, after: [10, 11, 12]), tail: 1)
    transcript.apply(parts)
    #expect(transcript.entries.map(\.id) == [4, 5, 6, 9, 10, 11, 12])
    #expect(transcript.earlierCursor == 4)
}

@Test func automaticInputsAreReadSeparatelyFromTheQueueAndSurviveSnapshots() async throws {
    var transcript = Transcript()
    transcript.apply(json(#"{"type":"queue_update","items":[{"id":10,"mode":"followUp","content":"Mine"}],"automatic":[{"id":11,"origin":"coordinator","mode":"steer","preview":"Use the shared divider","queuedAt":1000},{"id":12,"origin":"job","mode":"followUp","preview":"Tests passed","queuedAt":2000,"held":true},{"id":13,"origin":"future-kind","mode":"followUp","preview":"Unknown","queuedAt":3000},{"id":14,"mode":"later"}]}"#))
    #expect(transcript.queuedMessages.map(\.id) == [10])
    #expect(transcript.automaticInputs == [
        PendingAutomaticInput(id: 11, origin: .coordinator, mode: .steer, preview: "Use the shared divider", queuedAt: 1000),
        PendingAutomaticInput(id: 12, origin: .job, mode: .followUp, preview: "Tests passed", queuedAt: 2000, held: true),
        PendingAutomaticInput(id: 13, origin: .extension, mode: .followUp, preview: "Unknown", queuedAt: 3000),
    ])
    #expect(PendingAutomaticInput.inDeliveryOrder(
        transcript.automaticInputs.reversed()).map(\.id) == [11, 13, 12])

    // The agent stream's snapshot must not erase the separate inbox projection.
    transcript.apply(json(#"{"type":"snapshot","entries":[],"tools":[],"inbox":[]}"#))
    #expect(transcript.automaticInputs.count == 3)
    #expect(TranscriptPresentation(transcript: transcript).automaticInputs == transcript.automaticInputs)

    // Older workers omit the field; each one leaves as it joins the run.
    transcript.apply(json(#"{"type":"queue_update","items":[]}"#))
    #expect(transcript.automaticInputs.isEmpty)

    let processor = TranscriptProcessor()
    let first = try await processor.apply([json(#"{"type":"queue_update","items":[],"automatic":[{"id":1,"origin":"job","mode":"followUp","preview":"Done","queuedAt":1}]}"#)])
    let cleared = try await processor.apply([json(#"{"type":"queue_update","items":[],"automatic":[]}"#)])
    #expect(first.automaticInputs.map(\.id) == [1])
    #expect(cleared.automaticInputs.isEmpty && cleared.revision > first.revision)
}

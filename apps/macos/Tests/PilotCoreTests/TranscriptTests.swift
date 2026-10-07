import Foundation
import Testing
@testable import PilotCore

private func json(_ text: String) -> JSONValue {
    try! JSONValue.decode(Data(text.utf8))
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

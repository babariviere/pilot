import Foundation
import PilotCore
import Testing
@testable import Pilot

private func entry(_ id: Int, _ text: String) -> String {
    #"{"id":\#(id),"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"\#(text)"}]}]}"#
}

private func events(_ json: String) throws -> [JSONValue] {
    try JSONValue.decode(Data(json.utf8)).array ?? []
}

private func until(_ check: @MainActor () -> Bool) async {
    for _ in 0 ..< 200 where !(await check()) { try? await Task.sleep(for: .milliseconds(10)) }
}

@Test func subagentStreamUpdatesAndErrorsDecode() throws {
    let update = try ServerUpdate.decode(Data(#"""
    {"type":"subagent.events","sessionId":"s1","name":"code \"review\"","events":[{"type":"entry_appended","entry":{"id":4}}]}
    """#.utf8))
    guard case let .subagentEvents(sessionId, name, events)? = update else { Issue.record("expected subagent events"); return }
    #expect(sessionId == "s1")
    #expect(name == #"code "review""#)
    #expect(events.count == 1)
    let error = try ServerUpdate.decode(Data(#"{"type":"error","sessionId":"s1","name":"review","message":"gone"}"#.utf8))
    guard case let .error(errorSession, errorName, message)? = error else { Issue.record("expected error"); return }
    #expect(errorSession == "s1" && errorName == "review" && message == "gone")
}

@Test @MainActor func viewsShareOneStreamThatAppendsEntriesAndStopsAfterTheLastView() async throws {
    let client = PilotClient()
    let key = SubagentKey(sessionId: "s1", name: "review")
    client.fixtureSubagentTranscripts = ["review": try events(#"""
    [{"type":"snapshot","entries":[\#(entry(1, "First"))],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{}}]
    """#)]
    let feeds = SubagentFeeds()
    let feed = feeds.feed(key, client: client)
    #expect(feeds.feed(key, client: client) === feed, "the popover and the Agents tab share one feed")
    feed.lingerDelay = .milliseconds(20)
    feed.retain()
    feed.retain()
    await until { !feed.loading }
    #expect(feed.presentation.rows.count == 1)

    client.handle(.subagentEvents(sessionId: "s1", name: "review", events: try events("[{\"type\":\"entry_appended\",\"entry\":\(entry(2, "Second"))}]")))
    await until { feed.presentation.rows.count == 2 }
    #expect(feed.presentation.rows.count == 2, "appended entries extend the transcript")
    client.handle(.subagentEvents(sessionId: "s1", name: "other", events: try events("[{\"type\":\"entry_appended\",\"entry\":\(entry(3, "Elsewhere"))}]")))
    client.handle(.error(sessionId: "s1", name: "review", message: "Session history is busy"))
    #expect(feed.error == "Session history is busy")
    client.handle(.subagentEvents(sessionId: "s1", name: "review", events: []))
    #expect(feed.presentation.rows.isEmpty, "an empty batch replaces the transcript")

    feed.release()
    feed.release()
    #expect(feed.isActive, "the stream lingers briefly between views")
    feed.retain()
    feed.release()
    await until { !feed.isActive }
    #expect(!feed.isActive)
    #expect(feeds.count == 0)
}

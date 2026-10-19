import Foundation
import Testing
@testable import PilotCore

@Test func trackedSourceDecodesOptionallyAndReadsAsOneLine() throws {
    let json = #"{"id":"s","title":"Chat","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"idle""#
    let plain = try JSONDecoder().decode(SessionSummary.self, from: Data((json + "}").utf8))
    #expect(plain.trackedSource == nil)

    let source = ##"{"kind":"slack","itemId":"item-1","label":"#support","title":"Login broken","url":"https://example.slack.com/p1"}"##
    let session = try JSONDecoder().decode(SessionSummary.self,
                                          from: Data((json + ",\"trackedSource\":\(source)}").utf8))
    #expect(session.trackedSource == SessionTrackedSource(kind: .slack, itemId: "item-1", label: "#support",
                                                          title: "Login broken", url: "https://example.slack.com/p1"))
    #expect(session.trackedSource?.summary == "From Slack #support: Login broken")
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)

    // A Slack message without a channel name is labelled just "Slack"; Linear names the ticket.
    #expect(SessionTrackedSource(kind: .slack, itemId: "i", label: "Slack", title: "", url: "").summary == "From Slack")
    #expect(SessionTrackedSource(kind: .linear, itemId: "i", label: "ENG-1", title: "Fix crash", url: "").summary
        == "From Linear ENG-1: Fix crash")
}

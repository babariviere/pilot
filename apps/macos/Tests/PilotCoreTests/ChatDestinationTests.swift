import Foundation
import Testing
@testable import PilotCore

@Test func chatDestinationsAcceptOnlyUnambiguousChatURLs() throws {
    let id = "abee494b-d1a8-484c-a57b-669148815d37"
    for value in ["pilot://chat/\(id)", "PILOT://CHAT/\(id.uppercased())"] {
        let url = try #require(URL(string: value))
        #expect(ChatDestination(url: url)?.sessionId == id)
    }
    for value in ["https://chat/\(id)", "pilot://other/\(id)", "pilot://chat", "pilot://chat/not-a-chat",
                  "pilot://chat/\(id)/", "pilot://chat/\(id)/extra", "pilot://chat/\(id)?start=true",
                  "pilot://chat/\(id)#message", "pilot://user@chat/\(id)", "pilot://chat:123/\(id)",
                  "pilot:///chat/\(id)", "pilot://chat/../\(id)"] {
        let url = try #require(URL(string: value))
        #expect(ChatDestination(url: url) == nil, "Unexpected destination: \(value)")
    }
}

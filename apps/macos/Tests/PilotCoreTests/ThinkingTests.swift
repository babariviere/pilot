import Foundation
import Testing
@testable import PilotCore

@Test func thinkingContractsDecodeOlderDaemonsAndRoundTripNewFields() throws {
    let oldSession = Data(#"{"id":"s","title":"Chat","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"idle"}"#.utf8)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: oldSession).thinking == nil)
    let session = SessionSummary(id: "s", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 2,
                                 state: "idle", model: "provider/model", thinking: "high")
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)
    #expect(session.thinking == "high")

    let oldModel = Data(#"{"id":"provider/model","provider":"provider","name":"Model","reasoning":true,"thinking":"low"}"#.utf8)
    let decoded = try JSONDecoder().decode(ModelOption.self, from: oldModel)
    #expect(decoded.thinkingLevels == nil)
    #expect(decoded.thinking == "low")
    let option = ModelOption(id: "provider/model", provider: "provider", name: "Model", reasoning: true,
                             thinking: "low", thinkingLevels: ["off", "low", "high", "xhigh"])
    #expect(try JSONDecoder().decode(ModelOption.self, from: JSONEncoder().encode(option)) == option)
    #expect(ModelOption(id: "old", provider: "provider", name: "Old").thinkingLevels == nil)
}

@Test func changeModelRequestsOmitMissingThinkingButPreserveExplicitOff() throws {
    for thinking in [nil, "off", "high"] as [String?] {
        let request = ChangeModelRequest(model: "provider/model", thinking: thinking)
        let data = try JSONEncoder().encode(request)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(object["model"] == "provider/model")
        #expect(object["thinking"] == thinking)
        #expect(object.count == (thinking == nil ? 1 : 2))
        let decoded = try JSONDecoder().decode(ChangeModelRequest.self, from: data)
        #expect(decoded.model == request.model)
        #expect(decoded.thinking == thinking)
    }
    let old = try JSONDecoder().decode(ChangeModelRequest.self, from: Data(#"{"model":"provider/model"}"#.utf8))
    #expect(old.thinking == nil)
}

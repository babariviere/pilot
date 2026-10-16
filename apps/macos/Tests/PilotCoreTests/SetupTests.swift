import Foundation
import Testing
@testable import PilotCore

@Test func setupTypesDecodePrivateChallengesSeparatelyFromNonSecretRunState() throws {
    let runJSON = """
    {"id":"same","provider":"anthropic","method":"manual_code","state":"cancelled",
    "createdAt":1,"expiresAt":2,"reauthenticationRequired":true,"problem":"Start a fresh sign-in."}
    """
    let run = try JSONDecoder().decode(SetupRun.self, from: Data(runJSON.utf8))
    #expect(run.reauthenticationRequired)
    let local = HostedSetupRun(host: HostRef(hostId: "local", daemonId: "same", lineageId: "same"), run: run)
    let remote = HostedSetupRun(host: HostRef(hostId: "box", daemonId: "same", lineageId: "same"), run: run)
    #expect(local != remote)
    let message = try JSONDecoder().decode(SetupServerMessage.self, from: Data("{\"type\":\"setup.state\",\"run\":\(runJSON)}".utf8))
    #expect(message == .state(run))
    let encoded = try JSONEncoder().encode(SetupStartRequest(provider: "openai-codex", method: .deviceCode))
    let body = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: String])
    #expect(body == ["provider": "openai-codex", "method": "device_code"])
}

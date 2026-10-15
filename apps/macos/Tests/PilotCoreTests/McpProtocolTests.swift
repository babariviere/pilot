import Foundation
import PilotCore
import Testing

struct McpProtocolTests {
    @Test func statusPushDecodesAndListsServersNeedingTheUser() throws {
        let data = Data(#"{"type":"mcp","mcp":{"checking":false,"configProblems":1,"servers":[{"name":"datadog","transport":"http","state":"needs_sign_in","canSignIn":true,"checkedAt":1,"signIn":{"state":"failed","startedAt":1,"expiresAt":2,"finishedAt":2,"error":"Sign-in timed out. Try again."}},{"name":"local","transport":"stdio","state":"failed","problem":"Couldn't start the server.","checkedAt":1},{"name":"linear","transport":"http","state":"connected","tools":1,"checkedAt":1},{"name":"future","transport":"websocket","state":"rebooting"}]}}"#.utf8)
        guard case let .mcp(status) = try ServerUpdate.decode(data) else { Issue.record("Missing MCP update"); return }
        #expect(status.configProblems == 1)
        #expect(status.needingUser.map(\.name) == ["datadog", "local"])
        #expect(status.server(named: "future")?.state == .unknown, "newer daemons' states decode leniently")
        #expect(status.server(named: "future")?.transport == .stdio)
        #expect(McpStatusText.signInProblem(status.servers[0]) == "Sign-in timed out. Try again.")
    }

    @Test func linesSayWhatTheServerNeeds() {
        let connected = McpServerStatus(name: "linear", transport: .http, state: .connected, tools: 1)
        #expect(McpStatusText.line(connected) == "Connected · 1 tool")
        #expect(McpStatusText.line(McpServerStatus(name: "a", transport: .http, state: .connected)) == "Connected")
        #expect(McpStatusText.line(McpServerStatus(name: "dd", transport: .http, state: .needsSignIn, canSignIn: true))
            == "Needs sign-in")
        #expect(McpStatusText.line(McpServerStatus(name: "dd", transport: .http, state: .needsSignIn))
            == "Needs sign-in · run pi mcp login dd")
        #expect(McpStatusText.line(McpServerStatus(name: "x", transport: .stdio, state: .disabled)) == "Turned off in pi")
        let waiting = McpServerStatus(name: "dd", transport: .http, state: .needsSignIn, canSignIn: true,
                                      signIn: McpSignInState(state: .waiting, startedAt: 1, expiresAt: 2))
        #expect(McpStatusText.line(waiting) == "Waiting for sign-in in your browser…")
        let failedThenConnected = McpServerStatus(name: "dd", transport: .http, state: .connected, canSignIn: true,
                                                  signIn: McpSignInState(state: .failed, startedAt: 1, expiresAt: 2))
        #expect(McpStatusText.signInProblem(failedThenConnected) == nil, "an old failure stops mattering once connected")
    }
}

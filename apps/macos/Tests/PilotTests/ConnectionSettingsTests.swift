import PilotCore
import Testing
@testable import Pilot

struct ConnectionSettingsTests {
    @Test func oneActionPerServerAndTheFooterNamesWhoNeedsSignIn() {
        let signIn = McpServerStatus(name: "datadog", transport: .http, state: .needsSignIn, canSignIn: true)
        #expect(McpServerRowText.action(signIn) == .signIn)
        #expect(McpServerRowText.state(signIn) == .init(text: "Needs sign-in", attention: true, waiting: false))
        let waiting = McpServerStatus(name: "datadog", transport: .http, state: .needsSignIn, canSignIn: true,
                                      signIn: McpSignInState(state: .waiting, startedAt: 1, expiresAt: 2))
        #expect(McpServerRowText.action(waiting) == .cancel)
        #expect(McpServerRowText.state(waiting).waiting)
        let terminal = McpServerStatus(name: "datadog", transport: .http, state: .needsSignIn)
        #expect(McpServerRowText.action(terminal) == nil, "no browser sign-in: the line names the pi command")
        let failed = McpServerStatus(name: "local", transport: .stdio, state: .failed, problem: "Couldn't start the server.")
        #expect(McpServerRowText.action(failed) == .checkAgain)
        #expect(McpServerRowText.state(failed) == .init(text: "Couldn't start the server.", attention: true, waiting: false))
        let connected = McpServerStatus(name: "linear", transport: .http, state: .connected, tools: 3, canSignIn: true)
        #expect(McpServerRowText.action(connected) == nil, "Sign in again stays in the context menu")
        #expect(!McpServerRowText.state(connected).attention)

        #expect(McpServerRowText.footer([]) == nil)
        #expect(McpServerRowText.footer(["datadog"]) == "datadog needs sign-in")
        #expect(McpServerRowText.footer(["datadog", "notion"]) == "2 MCP servers need sign-in")
    }
}

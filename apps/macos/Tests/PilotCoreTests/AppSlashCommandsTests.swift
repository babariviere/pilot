import Foundation
import Testing
@testable import PilotCore

@Test func appCommandsDependOnWhereTheComposerIs() {
    #expect(SlashCommands.chatAppCommands(supportsChanges: true).map(\.name) == ["model", "terminal", "changes", "artifacts", "help"])
    #expect(SlashCommands.chatAppCommands(supportsChanges: false).map(\.name) == ["model", "artifacts", "help"],
            "Ask chats and coordinators have no Changes or terminal")
    #expect(SlashCommands.newChatAppCommands.map(\.name) == ["model", "mode", "help"],
            "no inspector before a chat exists; mode only before it starts")
    #expect(SlashCommands.appCommands.allSatisfy { $0.kind == .app })
}

@Test func appCommandsNeverHideASessionPromptOrSkill() {
    let commands = SlashCommands.all([
        SessionCommand(name: "model", source: .prompt, description: "the user's own"),
        SessionCommand(name: "review", source: .prompt),
        SessionCommand(name: "compact", source: .prompt, description: "shadowed"),
    ], app: SlashCommands.chatAppCommands(supportsChanges: true))
    #expect(commands.map(\.name) == ["compact", "jobs", "terminal", "changes", "artifacts", "help", "model", "review"])
    let model = commands.first { $0.name == "model" }
    #expect(model?.kind == .prompt, "the session's /model keeps its name")
    #expect(commands.first?.kind == .builtin, "built-ins still win")
    #expect(SlashCommands.appInvocation("/model", in: commands) == nil, "a prompt named model is sent as before")
}

@Test func appInvocationsReadTheWholeMessage() throws {
    let available = SlashCommands.chatAppCommands(supportsChanges: true)
    let terminal = try #require(SlashCommands.appInvocation("  /terminal \n", in: available))
    #expect(terminal.command == SlashCommands.terminal && terminal.arguments.isEmpty)
    let model = try #require(SlashCommands.appInvocation("/model opus", in: available))
    #expect(model.command == SlashCommands.model && model.arguments == "opus")
    #expect(SlashCommands.appInvocation("/terminals", in: available) == nil)
    #expect(SlashCommands.appInvocation("open /terminal", in: available) == nil)
    #expect(SlashCommands.appInvocation("/mode", in: available) == nil, "not offered in an existing chat")
    #expect(SlashCommands.appInvocation("/compact", in: available) == nil)
}

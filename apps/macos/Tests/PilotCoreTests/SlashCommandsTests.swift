import Foundation
import Testing
@testable import PilotCore

private func token(_ text: String, at location: Int? = nil) -> String? {
    let caret = location ?? (text as NSString).length
    return SlashCommands.range(in: text, selection: NSRange(location: caret, length: 0))
        .map { (text as NSString).substring(with: $0) }
}

@Test func slashTokenOnlyAtTheStartOfTheMessageBeforeWhitespace() {
    #expect(token("/") == "/")
    #expect(token("/comp") == "/comp")
    #expect(token("/skill:com") == "/skill:com")
    #expect(token("/compact keep") == nil)
    #expect(token("hello /comp") == nil)
    #expect(token(" /comp") == nil)
    #expect(token("") == nil)
    #expect(token("/compact", at: 4) == nil, "inside a token")
    #expect(token("/comp more", at: 5) == "/comp", "before trailing text")
}

@Test func slashMatchesPreferPrefixesIncludingBareSkillNames() {
    let commands = SlashCommands.all([
        SessionCommand(name: "review", source: .prompt),
        SessionCommand(name: "skill:commit", source: .skill),
        SessionCommand(name: "skill:recompile", source: .skill),
        SessionCommand(name: "compact", source: .prompt, description: "shadowed"),
    ])
    #expect(commands.map(\.name) == ["compact", "review", "skill:commit", "skill:recompile"])
    #expect(commands.first?.kind == .builtin)
    #expect(SlashCommands.matches("com", in: commands).map(\.name) == ["compact", "skill:commit", "skill:recompile"])
    #expect(SlashCommands.matches("skill:", in: commands).map(\.name) == ["skill:commit", "skill:recompile"])
    #expect(SlashCommands.matches("REV", in: commands).map(\.name) == ["review"])
    #expect(SlashCommands.matches("", in: commands).count == 4)
    #expect(SlashCommands.matches("zzz", in: commands).isEmpty)
}

@Test func compactInstructionsRecognizeOnlyTheCompactCommand() {
    #expect(SlashCommands.compactInstructions("/compact") == "")
    #expect(SlashCommands.compactInstructions("  /compact  ") == "")
    #expect(SlashCommands.compactInstructions("/compact keep the API notes\nand tests") == "keep the API notes\nand tests")
    #expect(SlashCommands.compactInstructions("/compacting") == nil)
    #expect(SlashCommands.compactInstructions("please /compact") == nil)
    #expect(SlashCommands.compactInstructions("/skill:compact") == nil)
}


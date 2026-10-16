import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private let models = [
    ModelOption(id: "anthropic/opus", provider: "anthropic", name: "Opus", reasoning: true, thinking: nil, thinkingLevels: ["low", "high"]),
    ModelOption(id: "openai/codex", provider: "openai", name: "Codex", reasoning: true, thinking: nil, thinkingLevels: nil),
]

@Test @MainActor func modelAndThinkingCommandsRunTheirHandlerOnlyWhenChosen() {
    var picked: [String] = []
    let commands = ComposerCommandText.modelCommands(models, current: "openai/codex") { picked.append($0) }
    #expect(commands.map(\.title) == ["Model: Opus", "Model: Codex"])
    #expect(commands.map(\.current) == [false, true])
    #expect(picked.isEmpty, "listing never changes the model")
    commands[0].perform()
    #expect(picked == ["anthropic/opus"])
    #expect(ComposerCommandText.thinkingCommands(["high"], current: nil) { _ in }.isEmpty,
            "a single level is not a choice")
    let levels = ComposerCommandText.thinkingCommands(["low", "high"], current: "high") { picked.append($0) }
    #expect(levels.map(\.title) == ["Thinking: Low", "Thinking: High"])
    #expect(levels.last?.current == true)
}

@Test @MainActor func sendLaterCommandsOfferOnlyChoicesThatNeedNoMoreInput() {
    var scheduled: [ScheduleTrigger] = []
    let commands = ComposerCommandText.sendLater { scheduled.append($0.trigger) }
    #expect(commands.count == 2)
    #expect(commands.allSatisfy { $0.title.hasPrefix("Send later: ") })
    for command in commands { command.perform() }
    #expect(scheduled == [.onBack, .onOnline])
}

@Test @MainActor func composerCommandsAppearInThePaletteOnlyWhileTheirComposerIsShown() throws {
    _ = NSApplication.shared
    let keyboard = AppModel.shared.keyboard
    var ran = 0
    let view = Text("Composer").composerCommands(revision: 1) {
        [ComposerCommand(id: "fixture-command", title: "Fixture command", icon: .model) { ran += 1 }]
    }
    let hosting = NSHostingView(rootView: view)
    hosting.frame = NSRect(x: 0, y: 0, width: 200, height: 40)
    let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    for _ in 0..<20 where !keyboard.composerCommands.contains(where: { $0.id == "fixture-command" }) {
        hosting.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    let command = try #require(keyboard.composerCommands.first { $0.id == "fixture-command" })
    command.perform()
    #expect(ran == 1)
    window.contentView = nil
    window.close()
    for _ in 0..<20 where keyboard.composerCommands.contains(where: { $0.id == "fixture-command" }) {
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    #expect(!keyboard.composerCommands.contains { $0.id == "fixture-command" })
}

@Test @MainActor func stopShortcutAppliesOnlyToTheOpenWorkingChatWithoutADialog() {
    let model = AppModel(projectFolderDefaults: UserDefaults(suiteName: "stop-\(UUID())")!)
    model.client.loadFixture(projects: [], sessions: [
        SessionSummary(id: "idle", title: "Idle", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle"),
        SessionSummary(id: "busy", title: "Busy", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "working"),
    ])
    #expect(!model.canStopSelectedChat, "no chat open")
    model.selectedSessionId = "idle"
    #expect(!model.canStopSelectedChat)
    model.selectedSessionId = "busy"
    #expect(model.canStopSelectedChat)
    model.showingCommandPalette = true
    #expect(!model.canStopSelectedChat, "never under the palette or a sheet")
    model.showingCommandPalette = false
    model.renamingSession = SessionRenameTarget(id: "busy", title: "Busy")
    #expect(!model.canStopSelectedChat)
}

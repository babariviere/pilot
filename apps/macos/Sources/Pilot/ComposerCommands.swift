import AppKit
import PilotCore
import SwiftUI

/// One composer control the palette can operate: a model, thinking level, mode, branch, workspace or send-later
/// choice. Each runs the same handler and availability check as the control on screen, so keyboard users reach
/// menus and pickers without Full Keyboard Access. Picking a choice never sends the draft.
struct ComposerCommand {
    let id: String
    let title: String
    var keywords: [String] = []
    let icon: PilotIcon
    var detail: String? = nil
    /// The current choice, shown as such and still pickable.
    var current = false
    let perform: @MainActor () -> Void
}

extension KeyboardFocus {
    /// The composer on screen offering its controls to the palette. The most recently shown one wins.
    var composerCommands: [ComposerCommand] { composerProviders.last?.provide() ?? [] }
}

extension View {
    /// Offers this composer's controls to ⌘K while it is on screen. `revision` re-registers the provider when what
    /// it reads changes, so the palette never acts on a stale chat state.
    func composerCommands(revision: some Hashable,
                          _ provide: @escaping @MainActor () -> [ComposerCommand]) -> some View {
        modifier(ComposerCommandsModifier(revision: AnyHashable(revision), provide: provide))
    }
}

private struct ComposerCommandsModifier: ViewModifier {
    let revision: AnyHashable
    let provide: @MainActor () -> [ComposerCommand]
    @State private var id = UUID()

    func body(content: Content) -> some View {
        content
            .onAppear { AppModel.shared.keyboard.setComposerProvider(id, provide) }
            .onChange(of: revision) { AppModel.shared.keyboard.setComposerProvider(id, provide) }
            .onDisappear { AppModel.shared.keyboard.removeComposerProvider(id) }
    }
}

enum ComposerCommandText {
    static func modelCommands(_ models: [ModelOption], current: String?, perform: @escaping @MainActor (String) -> Void)
        -> [ComposerCommand] {
        models.map { option in
            ComposerCommand(id: "model:\(option.id)", title: "Model: \(option.name)",
                            keywords: ["model", option.provider, option.id], icon: .model, detail: option.provider,
                            current: option.id == current) { perform(option.id) }
        }
    }

    static func thinkingCommands(_ levels: [String], current: String?, perform: @escaping @MainActor (String) -> Void)
        -> [ComposerCommand] {
        guard levels.count >= 2 else { return [] }
        return levels.map { level in
            ComposerCommand(id: "thinking:\(level)", title: "Thinking: \(level.capitalized)",
                            keywords: ["thinking", "reasoning", "effort"], icon: .thinking,
                            current: level == current) { perform(level) }
        }
    }

    /// Send later choices that need no further input. "At a time" stays in the composer's menu.
    static func sendLater(_ schedule: @escaping @MainActor (ScheduleWhen) -> Void) -> [ComposerCommand] {
        [ScheduleTrigger.onBack, .onOnline].map { trigger in
            ComposerCommand(id: "schedule:\(trigger)", title: "Send later: \(ScheduleText.label(trigger))",
                            keywords: ["schedule", "later", "send"], icon: .pending) {
                schedule(ScheduleWhen(trigger: trigger))
            }
        }
    }

    static func pasteImage(_ paste: @escaping @MainActor () -> Void) -> ComposerCommand {
        ComposerCommand(id: "paste-image", title: "Attach image from clipboard", keywords: ["image", "paste", "attach"],
                        icon: .image, perform: paste)
    }
}

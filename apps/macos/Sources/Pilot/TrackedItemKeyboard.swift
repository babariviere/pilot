import AppKit
import PilotCore
import SwiftUI

/// What ⌘K asks a highlighted Linear or Slack row to do: the same actions as its hover buttons and context menu.
enum TrackedItemCommand: Equatable {
    case startChat, startMission, openLinked, toggleDismissed
}

struct TrackedItemRequest: Equatable {
    let id = UUID()
    let itemId: String
    let command: TrackedItemCommand
}

/// Requests reach the row that shows the item, which owns its actions and refresh. Each runs once.
@MainActor
final class TrackedItemRequests: ObservableObject {
    @Published private(set) var latest: TrackedItemRequest?
    private var consumed: UUID?

    func send(_ command: TrackedItemCommand, to itemId: String) {
        latest = TrackedItemRequest(itemId: itemId, command: command)
    }

    func take(_ request: TrackedItemRequest?, for itemId: String) -> TrackedItemCommand? {
        guard let request, request.itemId == itemId, request.id != consumed else { return nil }
        consumed = request.id
        return request.command
    }
}

extension CommandPaletteCatalog {
    /// The highlighted ticket or message's actions. Starting opens the prefilled new chat or mission form, which
    /// still needs the user to send; nothing starts from the palette itself.
    func trackedItemActions(id: String, title: String, linked: Bool) -> (title: String, entries: [CommandPaletteEntry]) {
        let requests = model.trackedItemRequests
        func entry(_ key: String, _ label: String, _ icon: PilotIcon, _ command: TrackedItemCommand) -> CommandPaletteEntry {
            CommandPaletteEntry(item: CommandPaletteItem(id: "target:tracked:\(id):\(key)", kind: .action, title: label,
                                                         keywords: [title]),
                                icon: icon) { requests.send(command, to: id) }
        }
        var entries: [CommandPaletteEntry] = []
        if linked { entries.append(entry("linked", "Open linked chat or mission", .message, .openLinked)) }
        entries.append(entry("chat", linked ? "Start another chat" : "Start chat", .compose, .startChat))
        entries.append(entry("mission", linked ? "Start another mission…" : "Start mission…", .mission, .startMission))
        entries.append(entry("dismiss", "Dismiss or restore", .dismiss, .toggleDismissed))
        return ("Highlighted: \(title)", entries)
    }
}

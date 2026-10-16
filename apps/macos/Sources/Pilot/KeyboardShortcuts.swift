import SwiftUI

/// A small, static reference. Opening it never loads projects, chats or daemon data.
enum KeyboardShortcuts {
    static let windowID = "keyboard-shortcuts"
    static let key = KeyEquivalent("?")
    static let modifiers: EventModifiers = .command
    static let hint = "⌘?"

    struct Entry: Identifiable {
        let title: String
        let keys: String
        var id: String { title }
    }

    struct Group: Identifiable {
        let title: String
        let entries: [Entry]
        var id: String { title }
    }

    static let groups: [Group] = [
        Group(title: "Navigation", entries: [
            Entry(title: "Show keyboard shortcuts", keys: hint),
            Entry(title: "Show keyboard shortcuts outside text", keys: "?"),
            Entry(title: "Open command palette", keys: "⌘K"),
            Entry(title: "Search chats", keys: "⌘F"),
            Entry(title: "Back", keys: "⌘←"),
            Entry(title: "Forward", keys: "⌘→"),
            Entry(title: "Back (alternative)", keys: "⌘["),
            Entry(title: "Forward (alternative)", keys: "⌘]"),
            Entry(title: "Show all projects", keys: "⌘0"),
            Entry(title: "Switch to project 1–9", keys: "⌘1–9"),
            Entry(title: "Add project", keys: "⇧⌘O"),
            Entry(title: "Open settings", keys: "⌘,"),
        ]),
        Group(title: "Focus", entries: [
            Entry(title: "Focus next region", keys: "⌃⇥"),
            Entry(title: "Focus previous region", keys: "⌃⇧⇥"),
            Entry(title: "Focus composer or question", keys: "⌘L"),
            Entry(title: "Move through a list", keys: "↑ / ↓ or J / K"),
        ]),
        Group(title: "Go to (outside text)", entries: GoDestination.allCases.map { destination in
            Entry(title: destination.menuTitle, keys: destination.keys)
        }),
        Group(title: "Chat", entries: [
            Entry(title: "New chat", keys: "⌘N"),
            Entry(title: "Toggle changes", keys: "⇧⌘D"),
            Entry(title: "Toggle terminal", keys: "⌘J"),
            Entry(title: "Open latest pull request", keys: "⇧⌘P"),
            Entry(title: "Confirm merge of latest open pull request", keys: "⇧⌘M"),
            Entry(title: "Stop the open chat's agent", keys: "⌘."),
            Entry(title: "Choose model, thinking, mode, project, branch or workspace", keys: "⌘K, then type"),
        ]),
        Group(title: "Composer", entries: [
            Entry(title: "Send, or steer a running agent", keys: "↩"),
            Entry(title: "Queue a follow-up", keys: "⌥↩"),
            Entry(title: "Insert a new line", keys: "⇧↩"),
            Entry(title: "Edit previous or next queued message", keys: "⌥↑ / ⌥↓"),
            Entry(title: "Leave queued-message editing", keys: "esc"),
            Entry(title: "Complete a file path", keys: "⇥"),
        ]),
        Group(title: "Agent questions", entries: [
            Entry(title: "Select or tick an answer", keys: "1–9"),
            Entry(title: "Move between answers", keys: "↑ / ↓"),
            Entry(title: "Write your own answer", keys: "0"),
            Entry(title: "Send selected answers", keys: "↩"),
            Entry(title: "Return from reply to answers", keys: "esc"),
        ]),
        Group(title: "Editors and dialogs", entries: [
            Entry(title: "Save mission brief while editing", keys: "⌘S"),
            Entry(title: "Confirm a form with a multiline editor", keys: "⌘↩"),
            Entry(title: "Confirm a single-line form or palette choice", keys: "↩"),
            Entry(title: "Close a dialog or command palette", keys: "esc"),
            Entry(title: "Close window", keys: "⌘W"),
            Entry(title: "Quit Pilot (agents keep running)", keys: "⌘Q"),
        ]),
    ]
}

struct KeyboardShortcutsCommands: Commands {
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .help) {
            Button("Keyboard Shortcuts") { openWindow(id: KeyboardShortcuts.windowID) }
                .keyboardShortcut(KeyboardShortcuts.key, modifiers: KeyboardShortcuts.modifiers)
        }
    }
}

struct KeyboardShortcutsView: View {
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        SheetScaffold("Keyboard shortcuts", subtitle: "Shortcuts apply when their action is available.",
                      cancel: { dismissWindow(id: KeyboardShortcuts.windowID) }, width: 540, fillsHeight: true) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    ForEach(KeyboardShortcuts.groups) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            PageSectionHeader(title: group.title)
                            VStack(spacing: 0) {
                                ForEach(group.entries) { entry in
                                    HStack(spacing: 16) {
                                        Text(entry.title)
                                            .font(.pilot(.body))
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                        KeyCap(key: entry.keys)
                                    }
                                    .foregroundStyle(Theme.foreground)
                                    .padding(.vertical, 8)
                                    .accessibilityElement(children: .ignore)
                                    .accessibilityLabel("\(entry.title), \(entry.keys)")
                                    HairlineDivider()
                                }
                            }
                        }
                    }
                }
            }
        }
        .frame(height: 620)
    }
}

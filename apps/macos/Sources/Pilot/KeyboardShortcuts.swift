import PilotCore
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
            Entry(title: "Open a control: /model, /mode, /terminal, /changes, /artifacts, /help", keys: "/ then ↩"),
            Entry(title: "Leave the composer, keeping the draft", keys: "esc"),
        ]),
        Group(title: "Agent questions", entries: [
            Entry(title: "Select or tick an answer", keys: "1–9"),
            Entry(title: "Move between answers", keys: "↑ / ↓"),
            Entry(title: "Write your own answer", keys: "0"),
            Entry(title: "Send selected answers", keys: "↩"),
            Entry(title: "Return from reply to answers", keys: "esc"),
        ]),
        Group(title: "Transcript and inspector", entries: [
            Entry(title: "Focus the transcript", keys: "⌃⇥ from the sidebar"),
            Entry(title: "Move between messages", keys: "↑ / ↓ or J / K"),
            Entry(title: "Fold or unfold work or a long message", keys: "↩"),
            Entry(title: "Copy the highlighted message", keys: "⌘C"),
            Entry(title: "Edit the highlighted sent message", keys: "E"),
            Entry(title: "Return to the composer", keys: "esc or ⌘L"),
            Entry(title: "Open a highlighted file, link, artifact or subagent", keys: "↩ in the inspector"),
            Entry(title: "Leave the terminal or an artifact page", keys: "⌃⇥ / ⌘L / ⌘J"),
        ]),
        Group(title: "Task list", entries: [
            Entry(title: "Open the task's chat, or start one", keys: "↩"),
            Entry(title: "Edit the task title", keys: "E"),
            Entry(title: "Save or cancel the title", keys: "↩ / esc"),
            Entry(title: "Move the task up or down in its phase", keys: "⌥↑ / ⌥↓"),
            Entry(title: "Status, phase, model, dependencies and links", keys: "⌘K"),
        ]),
        Group(title: "Slack triage", entries: [
            Entry(title: "Move between messages and columns", keys: "↑ ↓ ← → or J / K"),
            Entry(title: "Start a chat from the message", keys: "↩"),
            Entry(title: "Change type", keys: "T"),
            Entry(title: "Change label", keys: "L"),
            Entry(title: "Dismiss or restore", keys: "D"),
        ]),
        Group(title: "Memory", entries: [
            Entry(title: "Move through the tree", keys: "↑ / ↓ or J / K"),
            Entry(title: "Fold or unfold", keys: "← / →"),
            Entry(title: "Clear the search, then return to the tree", keys: "esc"),
        ]),
        Group(title: "Editors and dialogs", entries: [
            Entry(title: "Save mission brief while editing", keys: "⌘S"),
            Entry(title: "Confirm a form with a multiline editor", keys: "⌘↩"),
            Entry(title: "Confirm a single-line form or palette choice", keys: "↩"),
            Entry(title: "Close a dialog or command palette", keys: "esc"),
            Entry(title: "Reach toggles, pickers and buttons in Settings and dialogs",
                  keys: "⇥ with Keyboard navigation on"),
            Entry(title: "Close window", keys: "⌘W"),
            Entry(title: "Quit Pilot (agents keep running)", keys: "⌘Q"),
        ]),
    ]

    /// Groups with the entries whose title, keys or group match every word of `query`. Empty lists everything.
    static func filtered(_ query: String, in groups: [Group] = groups) -> [Group] {
        let tokens = CommandPalette.tokens(query)
        guard !tokens.isEmpty else { return groups }
        return groups.compactMap { group in
            let entries = group.entries.filter { entry in
                let text = CommandPalette.tokens([group.title, entry.title, entry.keys].joined(separator: " ")).joined(separator: " ")
                return tokens.allSatisfy(text.contains)
            }
            return entries.isEmpty ? nil : Group(title: group.title, entries: entries)
        }
    }
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
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    var body: some View {
        SheetScaffold("Keyboard shortcuts", subtitle: "Shortcuts apply when their action is available.",
                      cancel: { dismissWindow(id: KeyboardShortcuts.windowID) }, width: 540, fillsHeight: true) {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    PilotSymbol(PilotIcon.search).foregroundStyle(Theme.faintForeground)
                    TextField("Search shortcuts", text: $query)
                        .textFieldStyle(.plain)
                        .font(.pilot(.body))
                        .focused($searchFocused)
                        .accessibilityLabel("Search shortcuts")
                }
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(Theme.border))
                .padding(.bottom, 12)
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        let groups = KeyboardShortcuts.filtered(query)
                        if groups.isEmpty {
                            Text("No shortcuts match.").font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                        }
                        ForEach(groups) { group in
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
        }
        .frame(height: 620)
        .onAppear { searchFocused = true }
    }
}

import AppKit
import PilotCore
import SwiftUI

/// Keyboard targeting for one chat's transcript. The page region's focus lands on the transcript; arrows or J/K
/// move a highlight between rows by id, without realizing the lazy history. Return folds or unfolds the row's
/// work or long message, ⌘C copies its text, E edits a sent message through the existing rewind flow, and moving
/// above the first row loads earlier history. Escape returns to the composer with its draft.
@MainActor
final class TranscriptKeyboard: ObservableObject {
    @Published var highlighted: String?

    /// The row to highlight after a move, or nil when there is nowhere to go.
    static func next(from current: String?, by offset: Int, in ids: [String]) -> String? {
        guard !ids.isEmpty else { return nil }
        // Entering from the composer, or after the row left, starts at the latest message.
        guard let current, let index = ids.firstIndex(of: current) else { return ids.last }
        let next = index + offset
        guard ids.indices.contains(next) else { return nil }
        return ids[next]
    }

    /// The text ⌘C copies for a row: messages only.
    static func copyText(_ row: ChatRow) -> String? {
        switch row {
        case let .user(_, text, _), let .text(_, text, _): text
        default: nil
        }
    }
}

struct TranscriptHighlight: Equatable {
    var id: String?
    /// The transcript has focus and the keyboard is navigating (`KeyboardCue`).
    var showsCue = false
}

private struct TranscriptHighlightKey: EnvironmentKey {
    static let defaultValue = TranscriptHighlight()
}

extension EnvironmentValues {
    var transcriptHighlight: TranscriptHighlight {
        get { self[TranscriptHighlightKey.self] }
        set { self[TranscriptHighlightKey.self] = newValue }
    }
}

/// The highlighted row's quiet fill, behind the message, while the keyboard is navigating. Only this small view
/// reads the highlight, so moving it or clicking never re-evaluates message bodies.
struct TranscriptRowHighlight: View {
    let id: String
    @Environment(\.transcriptHighlight) private var highlight

    var body: some View {
        if highlight.showsCue, highlight.id == id {
            KeyboardHighlightFill(radius: Theme.Radius.card, outset: 6)
        }
    }
}

struct TranscriptKeyboardModifier: ViewModifier {
    @ObservedObject var keyboard: TranscriptKeyboard
    let proxy: ScrollViewProxy
    /// Read only when a key is pressed, so streaming never re-evaluates this modifier.
    let rows: () -> [ChatRow]
    let messageExpansions: TranscriptExpansions
    let rewind: TranscriptRewind?
    let loadEarlier: (() -> Void)?
    let pauseFollowing: () -> Void
    @FocusState private var focused: Bool
    @Environment(\.keyboardFocus) private var keyboardFocus
    @Environment(\.keyboardCue) private var cue

    func body(content: Content) -> some View {
        content
            .environment(\.transcriptHighlight, TranscriptHighlight(id: keyboard.highlighted, showsCue: focused && cue))
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .onKeyPress(keys: [.upArrow, .downArrow, .home, .end, .return, .escape]) { press in
                guard press.modifiers.isDisjoint(with: [.command, .control, .option]) else { return .ignored }
                switch press.key {
                case .upArrow: move(-1)
                case .downArrow: move(1)
                case .home: select(rows().first?.id)
                case .end: select(rows().last?.id)
                case .return: toggleHighlighted()
                default:
                    // Back to the composer, draft and caret as they were.
                    _ = keyboardFocus.focus(.composer)
                }
                return .handled
            }
            .onKeyPress(characters: CharacterSet(charactersIn: "eE")) { press in
                guard press.modifiers.isDisjoint(with: [.command, .control, .option]) else { return .ignored }
                return editHighlighted() ? .handled : .ignored
            }
            .onCopyCommand {
                guard let row = highlightedRow, let text = TranscriptKeyboard.copyText(row) else { return [] }
                return [NSItemProvider(object: text as NSString)]
            }
            .onChange(of: focused) { _, isFocused in
                guard isFocused else { return }
                keyboardFocus.noteFocused(.content)
                if keyboard.highlighted == nil || highlightedRow == nil { select(rows().last?.id) }
            }
            .keyboardFocusHandler(.content) {
                focused = true
                return true
            }
    }

    private var highlightedRow: ChatRow? {
        keyboard.highlighted.flatMap { id in rows().first { $0.id == id } }
    }

    private func move(_ offset: Int) {
        let ids = rows().map(\.id)
        if let next = TranscriptKeyboard.next(from: keyboard.highlighted, by: offset, in: ids) {
            select(next)
        } else if offset < 0, let loadEarlier {
            loadEarlier()
        }
    }

    private func select(_ id: String?) {
        guard let id else { return }
        keyboard.highlighted = id
        // Reading back must not be pulled to the bottom by the next streamed token.
        pauseFollowing()
        proxy.scrollTo(id, anchor: .center)
    }

    /// Folds or unfolds the highlighted work row or long sent message, as clicking its disclosure does.
    private func toggleHighlighted() {
        guard let row = highlightedRow else { return }
        switch row {
        case let .work(id, _):
            let state = messageExpansions.state(for: id)
            state.choice = !(state.choice ?? false)
        case .thinking, .tools:
            let state = messageExpansions.state(for: row.id)
            state.choice = !(state.choice ?? false)
        case let .user(id, _, _), let .automatic(id, _, _, _), let .question(id, _):
            messageExpansions.state(for: id).expanded.toggle()
        case let .event(event):
            messageExpansions.state(for: event.id).expanded.toggle()
        default:
            return
        }
    }

    /// E on a sent message opens the existing edit flow, which confirms before stopping a running agent.
    private func editHighlighted() -> Bool {
        guard let rewind, let row = highlightedRow, case .user = row, let entryID = row.entryID else { return false }
        rewind.request(.edit, entryID: entryID)
        return true
    }
}

import AppKit
import PilotCore
import SwiftUI

/// Wraps a user bubble or agent reply with a hover-revealed footer: sent time, copy and, for the
/// user's own messages, edit. Hovering anywhere on the row reveals it.
struct MessageWithActions<Content: View>: View {
    let text: String
    let milliseconds: Double?
    var trailing = false
    var entryID: Int? = nil
    let content: Content
    @State private var hovered = false

    init(text: String, milliseconds: Double?, trailing: Bool = false, entryID: Int? = nil,
         @ViewBuilder content: () -> Content) {
        self.text = text
        self.milliseconds = milliseconds
        self.trailing = trailing
        self.entryID = entryID
        self.content = content()
    }

    var body: some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: 4) {
            content
            MessageActionBar(text: text, milliseconds: milliseconds, trailing: trailing,
                             entryID: entryID, revealed: hovered)
        }
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: Text("Copy message")) { MessageCopyButton.copy(text) }
    }
}

/// Footer under a message. Its slot is always laid out, so revealing it never reflows the transcript
/// or disturbs bottom-follow. Keyboard focus reveals it too; zero-opacity controls leave the
/// accessibility tree, so the row and its context menu carry copy and edit for VoiceOver.
/// User messages read time, copy, edit (trailing); agent replies read copy, time (leading).
struct MessageActionBar: View {
    private enum Field: Hashable { case copy, edit }

    let text: String
    let milliseconds: Double?
    var trailing = false
    var entryID: Int? = nil
    let revealed: Bool
    @Environment(\.transcriptRewind) private var rewind
    @FocusState private var focus: Field?

    var body: some View {
        let shown = revealed || focus != nil
        HStack(spacing: 2) {
            if trailing {
                time.padding(.trailing, 6)
                copy
                if let entryID, let rewind {
                    MessageEditButton(entryID: entryID, rewind: rewind).focused($focus, equals: .edit)
                }
            } else {
                copy
                time.padding(.leading, 6)
            }
        }
        .frame(height: 20)
        .opacity(shown ? 1 : 0)
        .allowsHitTesting(shown)
        .animation(Theme.Motion.quick, value: shown)
    }

    private var copy: some View {
        MessageCopyButton(text: text).focused($focus, equals: .copy)
    }

    @ViewBuilder private var time: some View {
        if let milliseconds, let label = MessageTimeFormatting.label(milliseconds) {
            Text(label)
                .font(.pilot(.caption))
                .foregroundStyle(Theme.mutedForeground)
                .lineLimit(1)
                .fixedSize()
                .help(MessageTimeFormatting.detail(milliseconds) ?? label)
        }
    }
}

/// Copies a message's full text and briefly confirms with a checkmark.
struct MessageCopyButton: View {
    let text: String
    @State private var copied = false

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    var body: some View {
        Button {
            Self.copy(text)
            copied = true
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
        }
        .buttonStyle(QuietIconButtonStyle())
        .help("Copy message")
        .accessibilityLabel("Copy message")
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

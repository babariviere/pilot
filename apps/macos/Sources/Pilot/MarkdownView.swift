import AppKit
import PilotCore
import SwiftUI

/// Renders agent and user Markdown with native text: block structure from `Markdown.parse`, inline styling
/// from `AttributedString`.
struct MarkdownView: View {
    let text: String
    let textColor: NSColor
    /// Creates blocks only as they scroll into view, for long documents such as a mission brief inside a
    /// scroll view. Shows a small spinner, not the raw text, until the blocks are prepared.
    let lazy: Bool
    /// Sizes text blocks to their longest line instead of the offered width, so user bubbles stay
    /// narrow for short messages. Code blocks, tables and rules still take the full width.
    let hugsContent: Bool
    /// A reply still streaming: only text after its last block boundary is prepared again per update.
    let streaming: Bool
    @StateObject private var state: MarkdownRenderState
    @Environment(\.transcriptContentPrepared) private var contentPrepared
    @Environment(\.pilotFonts) private var fonts
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(text: String, textColor: NSColor = .labelColor, lazy: Bool = false, hugsContent: Bool = false,
         streaming: Bool = false) {
        self.text = text
        self.textColor = textColor
        self.lazy = lazy
        self.hugsContent = hugsContent
        self.streaming = streaming
        _state = StateObject(wrappedValue: MarkdownRenderState(markdown: text))
    }

    var body: some View {
        Group {
            if lazy {
                LazyVStack(alignment: .leading, spacing: 10) { blocks }
            } else {
                VStack(alignment: .leading, spacing: 10) { blocks }
            }
        }
        .environment(\.messageTextSelection, state.selection)
        .environment(\.messageSelectionColor, textColor)
        // Streamed text fades in from the transcript's background; restored history and Reduce Motion do not.
        .environment(\.messageTextFade, streaming && !reduceMotion ? NSColor(Theme.background) : nil)
        .frame(maxWidth: hugsContent ? nil : .infinity, alignment: .leading)
        .task(id: text) {
            state.selection.source = text
            guard state.source != text else { return }
            do {
                let blocks = try await MarkdownRenderer.shared.prepare(text, streaming: streaming)
                try Task.checkCancellation()
                PreparedMarkdownCache.shared.store(blocks, for: text, replacing: state.source)
                if state.restoredBlockCount == nil { state.restoredBlockCount = blocks.count }
                state.source = text
                state.blocks = blocks
                contentPrepared?()
            } catch { /* A newer streamed value or disappeared row cancelled preparation. */ }
        }
    }

    @ViewBuilder private var blocks: some View {
        if state.source == nil {
            if lazy {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                // Not prepared yet: plain text keeps the row near its final height, so the
                // lazy transcript does not jump when the formatted blocks arrive.
                SelectableMessageText(text: AttributedString(text), font: fonts.nsBody, monoFont: fonts.nsMono,
                                      hugsContent: hugsContent)
            }
        } else {
            ForEach(Array(state.blocks.enumerated()), id: \.offset) { index, block in
                // Final blocks keep their prepared ID while a reply streams, so only changed blocks update.
                BlockView(block: block, hugsContent: hugsContent).equatable()
                    .environment(\.messageSelectionBlock, index)
                    .environment(\.messageTextFadesInitial, index >= (state.restoredBlockCount ?? state.blocks.count))
            }
        }
    }

    /// Prepares Markdown off the main actor and keeps it for views created later, such as a tab opened
    /// after its content arrived.
    static func prewarm(_ text: String) async {
        guard !text.isEmpty, PreparedMarkdownCache.shared.blocks(for: text) == nil,
              let blocks = try? await MarkdownRenderer.shared.prepare(text) else { return }
        PreparedMarkdownCache.shared.store(blocks, for: text)
    }
}

private struct BlockView: View, Equatable {
    @Environment(\.pilotFonts) private var fonts
    @Environment(\.messageTextFade) private var fade
    let block: PreparedMarkdownBlock
    let hugsContent: Bool

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.block.id == rhs.block.id && lhs.hugsContent == rhs.hugsContent
    }

    var body: some View {
        switch block.block {
        case let .heading(level, text):
            SelectableMessageText(text: block.inline ?? AttributedString(text),
                font: fonts.nsChat(fonts.chatSize + (level == 1 ? 6 : level == 2 ? 3 : 1), weight: .semibold),
                monoFont: fonts.nsMono, lineSpacing: 0, hugsContent: hugsContent)
                .padding(.top, 4)
        case let .paragraph(text):
            SelectableMessageText(text: block.inline ?? AttributedString(text), font: fonts.nsBody, monoFont: fonts.nsMono,
                                  hugsContent: hugsContent)
        case let .list(ordered, start, items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, _ in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(start + index)." : "•")
                            .font(fonts.body.monospacedDigit())
                            .foregroundStyle(Theme.mutedForeground)
                            .frame(minWidth: 14, alignment: .trailing)
                        SelectableMessageText(text: block.items[index], font: fonts.nsBody, monoFont: fonts.nsMono, item: index,
                                              hugsContent: hugsContent, copyPrefix: ordered ? "\(start + index). " : "• ")
                            .alignmentGuide(.firstTextBaseline) { _ in fonts.nsBody.ascender }
                    }
                }
            }
        case let .code(language, text):
            CodeBlock(language: language, text: text, prepared: block.code)
                .environment(\.messageTextFade, fade == nil ? nil : NSColor(Theme.code))
        case let .diagram(kind, text):
            InlineDiagramBlock(kind: kind, text: text).id(kind.rawValue + ":" + text)
        case let .quote(text):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1).fill(Theme.faintForeground).frame(width: 3)
                SelectableMessageText(text: block.inline ?? AttributedString(text), font: fonts.nsBody,
                                      monoFont: fonts.nsMono, color: .secondaryLabelColor, lineSpacing: 0,
                                      hugsContent: hugsContent)
            }
        case let .table(rows):
            SelectableMessageText(text: AttributedString(rows.joined(separator: "\n")),
                                  font: fonts.nsMono, monoFont: fonts.nsMono, lineSpacing: 0)
                // The table's fill is translucent, so no single colour can veil its text.
                .environment(\.messageTextFade, nil)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.muted))
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }
}

struct CodeBlock: View {
    @Environment(\.pilotFonts) private var fonts
    @Environment(\.messageTextSelection) private var selection
    let language: String?
    let text: String
    var prepared: AttributedString? = nil
    @StateObject private var state = MarkdownRenderState()
    @Environment(\.transcriptContentPrepared) private var contentPrepared

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "code").font(.caption).foregroundStyle(Theme.mutedForeground)
                Spacer()
                CopyButton(text: text)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Theme.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                Group {
                    if selection != nil {
                        SelectableMessageText(text: prepared ?? state.highlighted ?? AttributedString(text),
                                              font: fonts.nsMono, monoFont: fonts.nsMono, lineSpacing: 0, unwrapped: true)
                    } else {
                        Text(prepared ?? state.highlighted ?? AttributedString(text))
                            .font(fonts.mono)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }.padding(10)
            }
        }
        .background(Theme.code)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(Theme.border))
        .task(id: CodeRenderKey(text: text, language: language)) {
            guard prepared == nil else { return }
            do {
                let highlighted = try await MarkdownRenderer.shared.prepareCode(text, language: language)
                try Task.checkCancellation()
                state.highlighted = highlighted
                contentPrepared?()
            } catch { /* Cancelled by a newer source or collapsed tool row. */ }
        }
    }
}

private struct CodeRenderKey: Equatable {
    let text: String
    let language: String?
}

struct CopyButton: View {
    let text: String

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        } label: {
            PilotSymbol(PilotIcon.copy, context: .toolbar)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(Theme.mutedForeground)
        .help("Copy")
    }
}

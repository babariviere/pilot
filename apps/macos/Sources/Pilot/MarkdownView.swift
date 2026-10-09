import AppKit
import PilotCore
import SwiftUI

/// Renders agent Markdown with native text: block structure from `Markdown.parse`, inline styling
/// from `AttributedString`.
struct MarkdownView: View {
    let text: String
    @StateObject private var state: MarkdownRenderState
    @Environment(\.transcriptContentPrepared) private var contentPrepared
    @Environment(\.pilotFonts) private var fonts

    init(text: String) {
        self.text = text
        _state = StateObject(wrappedValue: MarkdownRenderState(markdown: text))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if state.source == nil {
                // Not prepared yet: plain text keeps the row near its final height, so the
                // lazy transcript does not jump when the formatted blocks arrive.
                Text(text).font(fonts.body).lineSpacing(3)
            } else {
                ForEach(Array(state.blocks.enumerated()), id: \.offset) { _, block in
                    BlockView(block: block)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: text) {
            guard state.source != text else { return }
            do {
                let blocks = try await MarkdownRenderer.shared.prepare(text)
                try Task.checkCancellation()
                PreparedMarkdownCache.shared.store(blocks, for: text, replacing: state.source)
                state.source = text
                state.blocks = blocks
                contentPrepared?()
            } catch { /* A newer streamed value or disappeared row cancelled preparation. */ }
        }
    }
}

private struct BlockView: View {
    @Environment(\.pilotFonts) private var fonts
    let block: PreparedMarkdownBlock

    var body: some View {
        switch block.block {
        case let .heading(level, text):
            Text(block.inline ?? AttributedString(text))
                .font(fonts.chat(fonts.chatSize + (level == 1 ? 6 : level == 2 ? 3 : 1), weight: .semibold))
                .padding(.top, 4)
        case let .paragraph(text):
            Text(block.inline ?? AttributedString(text)).font(fonts.body).lineSpacing(3)
        case let .list(ordered, start, items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(start + index)." : "•")
                            .font(fonts.body.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 14, alignment: .trailing)
                        Text(block.items[index]).font(fonts.body).lineSpacing(3)
                    }
                }
            }
        case let .code(language, text):
            CodeBlock(language: language, text: text, prepared: block.code)
        case let .diagram(kind, text):
            InlineDiagramBlock(kind: kind, text: text).id(kind.rawValue + ":" + text)
        case let .quote(text):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1).fill(.tertiary).frame(width: 3)
                Text(block.inline ?? AttributedString(text)).font(fonts.body).foregroundStyle(.secondary)
            }
        case let .table(rows):
            Text(rows.joined(separator: "\n"))
                .font(fonts.mono)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.subtleFill))
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }
}

struct CodeBlock: View {
    @Environment(\.pilotFonts) private var fonts
    let language: String?
    let text: String
    var prepared: AttributedString? = nil
    @StateObject private var state = MarkdownRenderState()
    @Environment(\.transcriptContentPrepared) private var contentPrepared

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "code").font(.caption).foregroundStyle(.secondary)
                Spacer()
                CopyButton(text: text)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Theme.subtleFill)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(prepared ?? state.highlighted ?? AttributedString(text))
                    .font(fonts.mono)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(10)
            }
        }
        .background(Theme.codeBackground)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline))
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
            Image(systemName: "doc.on.doc").font(.caption)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .help("Copy")
    }
}

import AppKit
import PilotCore
import SwiftUI

/// Renders agent Markdown with native text: block structure from `Markdown.parse`, inline styling
/// from `AttributedString`.
struct MarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(Markdown.parse(text).enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private func inline(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
}

private struct BlockView: View {
    @Environment(\.pilotFonts) private var fonts
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case let .heading(level, text):
            Text(inline(text))
                .font(fonts.chat(fonts.chatSize + (level == 1 ? 6 : level == 2 ? 3 : 1), weight: .semibold))
                .padding(.top, 4)
        case let .paragraph(text):
            Text(inline(text)).font(fonts.body).lineSpacing(3)
        case let .list(ordered, start, items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(start + index)." : "•")
                            .font(fonts.body.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 14, alignment: .trailing)
                        Text(inline(item)).font(fonts.body).lineSpacing(3)
                    }
                }
            }
        case let .code(language, text):
            CodeBlock(language: language, text: text)
        case let .quote(text):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1).fill(.tertiary).frame(width: 3)
                Text(inline(text)).font(fonts.body).foregroundStyle(.secondary)
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
    private let highlightedText: AttributedString

    init(language: String?, text: String) {
        self.language = language
        self.text = text
        var highlighted = AttributedString()
        for token in CodeSyntax.tokens(text, language: language) {
            var part = AttributedString(token.text)
            part.foregroundColor = Theme.syntaxColor(token.kind)
            highlighted.append(part)
        }
        highlightedText = highlighted
    }

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
                Text(highlightedText)
                    .font(fonts.mono)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(10)
            }
        }
        .background(Theme.codeBackground)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline))
    }
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

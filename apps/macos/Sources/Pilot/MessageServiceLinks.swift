import AppKit
import PilotCore
import SwiftUI

/// Inline TextKit attachments keep links in the same selectable, wrapping text as the sentence.
/// The copy source covers the complete reference, so copying a shortened URL never loses its destination.
@MainActor
enum MessageServiceLinks {
    static let copySource = NSAttributedString.Key("PilotMessageLinkCopySource")

    static func decorate(_ text: NSMutableAttributedString, font: NSFont) {
        var links: [(NSRange, URL)] = []
        text.enumerateAttribute(.link, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            if let url = value as? URL { links.append((range, url)) }
        }
        guard !links.isEmpty else { return }
        let result = NSMutableAttributedString(string: "")
        let source = text.string as NSString
        var cursor = 0
        for (range, url) in links {
            result.append(text.attributedSubstring(from: NSRange(location: cursor, length: range.location - cursor)))
            cursor = NSMaxRange(range)
            let original = source.substring(with: range)
            guard let link = ServiceLink(url: url, label: original) else {
                result.append(text.attributedSubstring(from: range))
                continue
            }
            let mark: PilotMark
            switch link.service {
            case .github: mark = .github
            case .linear: mark = .linear
            case .slack: mark = .slack
            }
            let attachment = NSTextAttachment()
            attachment.image = mark.image
            let size = max(font.capHeight, PilotIcon.Context.inline.markSize)
            attachment.bounds = NSRect(x: 0, y: (font.capHeight - size) / 2, width: size, height: size)
            let replacement = NSMutableAttributedString(attributedString: NSAttributedString(attachment: attachment))
            replacement.append(NSAttributedString(string: "\u{00A0}" + link.title))
            var attributes = text.attributes(at: range.location, effectiveRange: nil)
            attributes[.font] = font
            attributes[.foregroundColor] = NSColor(Theme.foreground)
            attributes[.underlineStyle] = nil
            attributes[.toolTip] = url.absoluteString
            attributes[copySource] = original
            replacement.addAttributes(attributes, range: NSRange(location: 0, length: replacement.length))
            result.append(replacement)
        }
        result.append(text.attributedSubstring(from: NSRange(location: cursor, length: text.length - cursor)))
        text.setAttributedString(result)
    }

    static func copiedText(_ text: NSAttributedString, range: NSRange) -> String {
        var result = ""
        let string = text.string as NSString
        text.enumerateAttribute(copySource, in: range) { source, part, _ in
            result += (source as? String) ?? string.substring(with: part)
        }
        return result
    }
}

/// User messages stay literal, rather than interpreting their Markdown as agent prose.
struct LinkedMessageText: View {
    let text: String
    @Environment(\.pilotFonts) private var fonts
    @StateObject private var state = LinkedMessageTextState()

    var body: some View {
        SelectableMessageText(text: state.source == text ? state.text : AttributedString(text),
                              font: fonts.nsBody, monoFont: fonts.nsMono, hugsContent: true)
            .environment(\.messageTextSelection, state.selection)
            .task(id: text) {
                guard state.source != text else { return }
                state.selection.source = text
                let prepared = await MarkdownRenderer.shared.preparePlainText(text)
                guard !Task.isCancelled else { return }
                state.text = prepared
                state.source = text
            }
    }
}

@MainActor
private final class LinkedMessageTextState: ObservableObject {
    let selection = MessageTextSelection()
    @Published var text = AttributedString()
    @Published var source: String?
}

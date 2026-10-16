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
                let plain = NSMutableAttributedString(attributedString: text.attributedSubstring(from: range))
                styleTitle(plain, range: NSRange(location: 0, length: plain.length), url: url)
                result.append(plain)
                continue
            }
            let image: NSImage?
            switch link.service {
            case .github: image = PilotMark.github.image
            case .linear: image = PilotMark.linear.image
            case .slack: image = PilotMark.slack.image
            case .artifact: image = PilotIcon.artifact.symbolImage()
            }
            let attachment = NSTextAttachment()
            attachment.image = image
            let size = max(font.capHeight, PilotIcon.Context.inline.markSize)
            attachment.bounds = NSRect(x: 0, y: (font.capHeight - size) / 2, width: size, height: size)
            let replacement = NSMutableAttributedString(attributedString: NSAttributedString(attachment: attachment))
            replacement.append(NSAttributedString(string: "\u{00A0}" + link.title))
            var attributes = text.attributes(at: range.location, effectiveRange: nil)
            attributes[.font] = font
            attributes[.foregroundColor] = NSColor(Theme.foreground)
            attributes[.underlineStyle] = nil
            attributes[.underlineColor] = nil
            attributes[.toolTip] = url.absoluteString
            attributes[copySource] = original
            replacement.addAttributes(attributes, range: NSRange(location: 0, length: replacement.length))
            // The attachment and its non-breaking space remain clickable, but never underlined.
            styleTitle(replacement, range: NSRange(location: 2, length: replacement.length - 2), url: url)
            result.append(replacement)
        }
        result.append(text.attributedSubstring(from: NSRange(location: cursor, length: text.length - cursor)))
        text.setAttributedString(result)
    }

    static var linkTextAttributes: [NSAttributedString.Key: Any] {
        // Do not set an underline here: NSTextView would also apply it to service attachments.
        [.cursor: NSCursor.pointingHand, .foregroundColor: NSColor(Theme.foreground)]
    }

    private static func styleTitle(_ text: NSMutableAttributedString, range: NSRange, url: URL) {
        text.addAttributes([
            .foregroundColor: NSColor(Theme.foreground),
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .underlineColor: NSColor(Theme.LinkUnderline.ink),
            .toolTip: url.absoluteString,
        ], range: range)
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

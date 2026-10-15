import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Suite(.serialized) @MainActor
struct MessageServiceLinksTests {
    private var style: MessageSelectionTextView.Style {
        .init(font: .systemFont(ofSize: 14), mono: .monospacedSystemFont(ofSize: 13, weight: .regular),
              color: .labelColor, spacing: 3)
    }

    private func expectTitleStyle(_ rich: NSAttributedString, range: NSRange, url: String) {
        rich.enumerateAttributes(in: range) { attributes, _, _ in
            #expect(attributes[.foregroundColor] as? NSColor == NSColor(Theme.foreground))
            #expect(attributes[.underlineStyle] as? Int == NSUnderlineStyle.single.rawValue)
            #expect(attributes[.underlineColor] as? NSColor == NSColor(Theme.LinkUnderline.ink))
            #expect(attributes[.toolTip] as? String == url)
            #expect(attributes[.attachment] == nil)
            #expect(attributes[.backgroundColor] == nil)
        }
    }

    @Test func serviceTitlesAloneHaveSoftUnderlines() async throws {
        for url in ["https://github.com/acme/api/pull/42", "https://linear.app/acme/issue/ENG-42/fix-chat-links",
                    "https://acme.slack.com/archives/C123/p1234567890123456"] {
            let parsed = await MarkdownRenderer.shared.preparePlainText(url)
            let rich = SelectableMessageText.attributed(parsed, style: style)
            #expect(rich.attribute(.attachment, at: 0, effectiveRange: nil) is NSTextAttachment)
            #expect((rich.string as NSString).substring(with: NSRange(location: 1, length: 1)) == "\u{00A0}")
            for index in 0..<2 {
                #expect(rich.attribute(.underlineStyle, at: index, effectiveRange: nil) == nil)
                #expect(rich.attribute(.underlineColor, at: index, effectiveRange: nil) == nil)
                #expect(rich.attribute(.link, at: index, effectiveRange: nil) as? URL == URL(string: url))
                #expect(rich.attribute(.toolTip, at: index, effectiveRange: nil) as? String == url)
            }
            expectTitleStyle(rich, range: NSRange(location: 2, length: rich.length - 2), url: url)
            #expect(MessageServiceLinks.copiedText(rich, range: NSRange(location: 0, length: rich.length)) == url)
        }
    }

    @Test func plainLinksShareTheServiceTitleStyleInUserAndAgentText() async throws {
        let url = "https://example.com/docs?q=one%20two#section"
        let user = await MarkdownRenderer.shared.preparePlainText("Read \(url).")
        let blocks = try await MarkdownRenderer.shared.prepare("Read [the **docs**](\(url)) and \(url).")
        let agent = try #require(blocks.first?.inline)
        for parsed in [user, agent] {
            let rich = SelectableMessageText.attributed(parsed, style: style)
            var count = 0
            rich.enumerateAttribute(.link, in: NSRange(location: 0, length: rich.length)) { link, range, _ in
                guard link != nil else { return }
                count += 1
                expectTitleStyle(rich, range: range, url: url)
            }
            #expect(count == (parsed == user ? 1 : 2))
            #expect(MessageServiceLinks.copiedText(rich, range: NSRange(location: 0, length: rich.length))
                    == String(parsed.characters))
            #expect(rich.attribute(.underlineStyle, at: 0, effectiveRange: nil) == nil)
        }
        let view = MessageSelectionTextView.make()
        let linkAttributes = try #require(view.linkTextAttributes)
        #expect(linkAttributes[.foregroundColor] as? NSColor == NSColor(Theme.foreground))
        #expect(linkAttributes[.cursor] as? NSCursor == .pointingHand)
        #expect(linkAttributes[.underlineStyle] == nil)
        #expect(linkAttributes[.backgroundColor] == nil)
    }

    @Test func hoverDarkensOnlyTheHitLinkWithoutChangingStorageSelectionOrWrapping() throws {
        let parsed = try AttributedString(markdown:
            "[A long service title that wraps over several lines](https://github.com/acme/api/pull/42) and [docs](https://example.com)",
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        let rich = SelectableMessageText.attributed(parsed, style: style)
        let view = MessageSelectionTextView.make()
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.setFrameSize(NSSize(width: 150, height: 200))
        view.textStorage?.setAttributedString(rich)
        let layout = try #require(view.layoutManager as? MessageSelectionLayoutManager)
        let container = try #require(view.textContainer)
        let size = view.measure(width: 150, unwrapped: false)
        let plain = (rich.string as NSString).range(of: "docs")
        view.setSelectedRange(NSRange(location: 2, length: 4))
        let selection = view.selectedRange()
        for index in [0, 1, 2, plain.location] {
            let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
            let rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
            view.updateLinkHover(at: NSPoint(x: rect.midX + view.textContainerOrigin.x,
                                             y: rect.midY + view.textContainerOrigin.y))
            #expect(layout.linkUnderlineColor(at: index < plain.location ? 2 : plain.location) == NSColor(Theme.foreground))
            #expect(layout.linkUnderlineColor(at: index < plain.location ? plain.location : 2) == NSColor(Theme.LinkUnderline.ink))
            #expect(view.textStorage?.isEqual(to: rich) == true)
            #expect(view.selectedRange() == selection)
            #expect(view.measure(width: 150, unwrapped: false) == size)
        }
        view.updateLinkHover(at: nil)
        #expect(view.hoveredLinkRange == nil)
        #expect(layout.linkUnderlineColor(at: 2) == NSColor(Theme.LinkUnderline.ink))
        #expect(layout.linkUnderlineColor(at: plain.location) == NSColor(Theme.LinkUnderline.ink))
        // Nearest-glyph snapping must not leave a link highlighted over empty space.
        view.updateLinkHover(at: NSPoint(x: 149, y: 199))
        #expect(view.hoveredLinkRange == nil)
    }

    @Test func underlineGeometryUsesOnePointInkFivePointsBelowBaseline() {
        let rect = MessageSelectionLayoutManager.linkUnderlineRect(
            enclosing: NSRect(x: 30, y: 10, width: 80, height: 20), baseline: 25, origin: NSPoint(x: 2, y: 3))
        #expect(rect == NSRect(x: 32, y: 33, width: 80, height: 1))
    }

    @Test func brandedReferencesKeepTheirDestinationsAndCopySources() throws {
        _ = NSApplication.shared
        let url = "https://linear.app/acme/issue/ENG-42/fix-chat-links"
        let source = "See \(url), and task #42."
        let parsed = ServiceLinks.detecting(in: AttributedString(source))
        let rich = SelectableMessageText.attributed(parsed, style: style)
        #expect(rich.string == "See \u{FFFC}\u{00A0}ENG-42 · Fix chat links, and task #42.")
        var range = NSRange()
        #expect(rich.attribute(.link, at: 4, effectiveRange: &range) as? URL == URL(string: url))
        #expect(rich.attribute(.attachment, at: 4, effectiveRange: nil) is NSTextAttachment)
        #expect(rich.attribute(.toolTip, at: 4, effectiveRange: nil) as? String == url)
        #expect(MessageServiceLinks.copiedText(rich, range: range) == url)
        #expect(MessageServiceLinks.copiedText(rich, range: NSRange(location: 0, length: rich.length)) == source)

        let owner = MessageTextSelection()
        owner.source = source
        let view = MessageSelectionTextView.make()
        view.textStorage?.setAttributedString(rich)
        view.selectionOwner = owner
        owner.register(view)
        owner.select(from: .init(key: view.selectionKey, offset: 0), to: .init(key: view.selectionKey, offset: rich.length))
        #expect(owner.selectedText == source)
        let board = NSPasteboard(name: .init("pilot-service-link-\(UUID())"))
        defer { board.releaseGlobally() }
        #expect(view.writeSelection(to: board, type: .string))
        #expect(board.string(forType: .string) == source)
        view.selectionOwner = nil
        view.setSelectedRange(range)
        #expect(view.writeSelection(to: board, type: .string))
        #expect(board.string(forType: .string) == url)
    }

    @Test func markdownLabelsGetOneMarkAndGenericLinksStayUnchanged() throws {
        let parsed = try AttributedString(markdown: "[#42 **Fix links**](https://github.com/acme/api/pull/42) and [docs](https://example.com)",
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        let rich = SelectableMessageText.attributed(parsed, style: style)
        #expect(rich.string == "\u{FFFC}\u{00A0}#42 Fix links and docs")
        #expect(MessageServiceLinks.copiedText(rich, range: NSRange(location: 0, length: rich.length)) == "#42 Fix links and docs")
        #expect(rich.attribute(.link, at: rich.length - 1, effectiveRange: nil) as? URL == URL(string: "https://example.com"))
        #expect(rich.attribute(.attachment, at: rich.length - 1, effectiveRange: nil) == nil)
    }

    @Test func codeRemainsLiteralAndParagraphListQuoteLinksArePrepared() async throws {
        let url = "https://github.com/acme/api/pull/42"
        let source = "\(url)\n\n- \(url)\n\n> \(url)\n\n`\(url)`\n\n```text\n\(url)\n```"
        let blocks = try await MarkdownRenderer.shared.prepare(source)
        #expect(blocks[0].inline?.runs.compactMap(\.link).count == 1)
        #expect(blocks[1].items[0].runs.compactMap(\.link).count == 1)
        #expect(blocks[2].inline?.runs.compactMap(\.link).count == 1)
        #expect(blocks[3].inline?.runs.compactMap(\.link).isEmpty == true)
        #expect(blocks[4].code?.runs.compactMap(\.link).isEmpty == true)
    }

    @Test func manyLinksWrapAndShortUserBubblesKeepTheirNaturalWidth() {
        let repeated = String(repeating: "https://github.com/acme/api/pull/42 and ", count: 500)
        let clock = ContinuousClock()
        let baseline = clock.measure {
            _ = SelectableMessageText.attributed(AttributedString(repeated), style: style)
        }
        var rich = NSAttributedString(string: "")
        let linked = clock.measure {
            rich = SelectableMessageText.attributed(ServiceLinks.detecting(in: AttributedString(repeated)), style: style)
        }
        print("Service links, 500 URLs: plain conversion \(baseline), detection and branded conversion \(linked)")
        #expect(MessageServiceLinks.copiedText(rich, range: NSRange(location: 0, length: rich.length)) == repeated)
        let view = MessageSelectionTextView.make()
        view.textStorage?.setAttributedString(rich)
        let wide = view.measure(width: 760, unwrapped: false)
        let narrow = view.measure(width: 320, unwrapped: false)
        #expect(narrow.height > wide.height)
        #expect(view.measure(width: 320, unwrapped: false) == narrow)
        view.textStorage?.setAttributedString(SelectableMessageText.attributed(AttributedString("Short message"), style: style))
        view.invalidateMeasurements()
        #expect(view.measure(width: 600, unwrapped: false, hugsContent: true).width < 200)
        #expect(view.measure(width: 600, unwrapped: false).width == 600)
    }
}

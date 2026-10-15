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

import AppKit
import SwiftUI
import Testing
@testable import Pilot

@Suite(.serialized) @MainActor
struct MessageTextSelectionTests {
    private func region(_ source: String, block: Int, owner: MessageTextSelection) -> MessageSelectionTextView {
        _ = NSApplication.shared
        let view = MessageSelectionTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 60))
        view.isEditable = false
        view.isSelectable = true
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = false
        view.textContainer?.heightTracksTextView = false
        view.textContainer?.size = CGSize(width: 400, height: 60)
        view.font = .systemFont(ofSize: 14)
        view.string = source
        view.selectionKey = .init(block: block)
        view.selectionOwner = owner
        owner.register(view)
        return view
    }

    @Test func forwardAndReverseSelectionSpanParagraphsAndCode() {
        let owner = MessageTextSelection()
        let first = region("First paragraph", block: 0, owner: owner)
        let code = region("let answer = 42", block: 1, owner: owner)
        let last = region("Last paragraph", block: 2, owner: owner)
        let start = MessageTextSelection.Position(key: first.selectionKey, offset: 6)
        let end = MessageTextSelection.Position(key: last.selectionKey, offset: 4)
        for (a, b) in [(start, end), (end, start)] {
            owner.select(from: a, to: b)
            #expect(first.selectedRange() == NSRange(location: 6, length: 9))
            #expect(code.selectedRange() == NSRange(location: 0, length: 15))
            #expect(last.selectedRange() == NSRange(location: 0, length: 4))
            #expect(owner.selectedText == "paragraph\n\nlet answer = 42\n\nLast")
        }
    }

    @Test func selectAllAndCopyIncludeOriginalMarkdownAndDiagramSource() {
        let owner = MessageTextSelection()
        owner.source = "# Heading\n\n**Body** 🧑‍💻\n\n```mermaid\ngraph LR; A --> B\n```"
        let first = region("Heading", block: 0, owner: owner)
        let last = region("Body 🧑‍💻", block: 1, owner: owner)
        first.selectAll(nil)
        #expect(first.selectedRange().length == first.string.utf16.count)
        #expect(last.selectedRange().length == last.string.utf16.count)
        #expect(owner.selectedText == owner.source)
        let board = NSPasteboard(name: .init("pilot-selection-test-\(UUID())"))
        defer { board.releaseGlobally() }
        last.copySelection(owner.selectedText, to: board)
        #expect(board.string(forType: .string) == owner.source)
    }

    @Test func regionReplacementAndStreamingClampExistingSelection() {
        let owner = MessageTextSelection()
        let first = region("Long first paragraph", block: 0, owner: owner)
        let second = region("Second", block: 1, owner: owner)
        first.selectAll(nil)
        first.string = "Short"
        owner.register(first)
        #expect(first.selectedRange() == NSRange(location: 0, length: 5))
        owner.unregister(second)
        let replacement = region("New second", block: 1, owner: owner)
        #expect(replacement.selectedRange().length == 6)
        owner.unregister(second) // An obsolete view must not remove its replacement.
        first.selectAll(nil)
        #expect(replacement.selectedRange().length == 10)
    }

    @Test func separateRepliesDoNotShareSelection() {
        let a = MessageTextSelection(), b = MessageTextSelection()
        let first = region("First reply", block: 0, owner: a)
        let second = region("Second reply", block: 0, owner: b)
        first.selectAll(nil)
        #expect(second.selectedRange().length == 0)
        a.clear()
        #expect(first.selectedRange().length == 0)
    }

    @Test func windowCoordinatesSelectAcrossNativeRegions() {
        let owner = MessageTextSelection()
        let first = region("First paragraph", block: 0, owner: owner)
        let last = region("Last paragraph", block: 1, owner: owner)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 200))
        window.contentView = host
        first.frame.origin.y = 130
        last.frame.origin.y = 30
        host.addSubview(first)
        host.addSubview(last)
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        let start = first.convert(NSPoint(x: 0, y: 8), to: nil)
        let finish = last.convert(NSPoint(x: 390, y: 8), to: nil)
        let anchor = MessageTextSelection.Position(key: first.selectionKey, offset: first.insertionIndex(atWindowPoint: start))
        owner.select(from: anchor, to: anchor)
        owner.extend(toWindowPoint: finish)
        #expect(first.selectedRange().length == first.string.utf16.count)
        #expect(last.selectedRange().length == last.string.utf16.count)
        #expect(owner.selectedText == "First paragraph\n\nLast paragraph")
        owner.source = "First paragraph\n\nLast paragraph"
        window.makeFirstResponder(first)
        let shortcut = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
            timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "a",
            charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0)!
        #expect(first.performKeyEquivalent(with: shortcut))
        #expect(owner.selectedText == owner.source)
        let arrow = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: window.windowNumber, context: nil, characters: "\u{F702}",
            charactersIgnoringModifiers: "\u{F702}", isARepeat: false, keyCode: 123)!
        first.keyDown(with: arrow)
        #expect(last.selectedRange().length == 0)
    }

    @Test func inlineFormattingAndSizingRemainNative() throws {
        let text = try AttributedString(markdown: "**Bold** *italic* `code` [link](https://example.com)",
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        let style = MessageSelectionTextView.Style(font: .systemFont(ofSize: 14),
            mono: .monospacedSystemFont(ofSize: 12, weight: .regular), color: .labelColor, spacing: 3)
        let rich = SelectableMessageText.attributed(text, style: style)
        #expect((rich.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.fontDescriptor.symbolicTraits.contains(.bold) == true)
        #expect((rich.attribute(.font, at: 5, effectiveRange: nil) as? NSFont)?.fontDescriptor.symbolicTraits.contains(.italic) == true)
        #expect(rich.attribute(.link, at: rich.length - 1, effectiveRange: nil) as? URL == URL(string: "https://example.com"))
        let view = region(String(repeating: "Some longer text. ", count: 100), block: 0, owner: MessageTextSelection())
        let wide = view.measure(width: 760, unwrapped: false)
        let narrow = view.measure(width: 320, unwrapped: false)
        #expect(narrow.height > wide.height)
        #expect(view.measure(width: 320, unwrapped: false) == narrow)
    }

    @Test func sizingProbesDoNotChangePlacedWrapping() {
        let view = MessageSelectionTextView.make()
        view.string = String(repeating: "Streaming text keeps its wrapping. ", count: 40)
        view.setFrameSize(NSSize(width: 320, height: 200))
        #expect(view.textContainer?.size.width == 320)
        _ = view.measure(width: 760, unwrapped: false)
        #expect(view.textContainer?.size.width == 320)
        view.string += "More streamed text."
        view.invalidateMeasurements()
        _ = view.measure(width: 500, unwrapped: false)
        #expect(view.textContainer?.size.width == 320)
    }

    @Test func regionsShareOneSelectionHighlight() {
        let owner = MessageTextSelection()
        let first = MessageSelectionTextView.make(), last = MessageSelectionTextView.make()
        #expect(first.layoutManager is MessageSelectionLayoutManager)
        for (index, view) in [first, last].enumerated() {
            view.frame = NSRect(x: 0, y: CGFloat(index) * 40, width: 300, height: 30)
            view.string = "Region \(index)"
            view.selectionKey = .init(block: index)
            view.selectionOwner = owner
            owner.register(view)
        }
        #expect(!owner.isActive)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 100),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
        window.contentView?.addSubview(first)
        window.contentView?.addSubview(last)
        window.makeFirstResponder(last)
        // Activity depends on the message, not on which region AppKit made first responder.
        #expect(owner.isActive == window.isKeyWindow)
    }

    @Test func renderedReplyKeepsLayoutAndWholeMessageSelection() async throws {
        let source = """
        ## Selection across a full reply

        This paragraph has **bold text**, *emphasis*, and a [link](https://example.com).

        You can select this second paragraph together with the first. Longer lines wrap naturally when the window is narrow.

        - First list item
        - Second list item, with enough text to wrap onto another line in the narrow window and keep its bullet aligned with the first line.

        ```swift
        let answer = 42
        print("A long code line stays horizontally scrollable, not wrapped into the message width.")
        ```

        > A quoted conclusion is part of the same selection.
        """
        let blocks = try await MarkdownRenderer.shared.prepare(source)
        PreparedMarkdownCache.shared.store(blocks, for: source)
        func regions(in view: NSView) -> [MessageSelectionTextView] {
            (view as? MessageSelectionTextView).map { [$0] } ?? view.subviews.flatMap { regions(in: $0) }
        }
        for width: CGFloat in [380, 760] {
            let host = NSHostingView(rootView: MarkdownView(text: source)
                .padding(20).frame(width: width).fixedSize(horizontal: false, vertical: true)
                .background(Color.white).environment(\.colorScheme, .light))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 700),
                                  styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: .aqua)
            window.contentView = host
            window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
            window.orderFrontRegardless()
            host.layoutSubtreeIfNeeded()
            for _ in 0..<3 { await Task.yield(); host.layoutSubtreeIfNeeded() }
            let views = regions(in: host).sorted { $0.selectionKey < $1.selectionKey }
            #expect(views.count == 7)
            #expect(views.allSatisfy { $0.frame.height > 0 })
            #expect(host.fittingSize.height > 250 && host.fittingSize.height < 700)
            let first = try #require(views.first)
            window.makeFirstResponder(first)
            first.selectAll(nil)
            #expect(views.allSatisfy { $0.selectedRange().length == $0.string.utf16.count })
            #expect(first.selectionOwner?.selectedText == source)
            if ProcessInfo.processInfo.environment["PILOT_SELECTION_SNAPSHOTS"] == "1",
               let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: bitmap)
                try bitmap.representation(using: .png, properties: [:])?.write(
                    to: URL(fileURLWithPath: "/tmp/pilot-message-selection-\(Int(width)).png"))
            }
            window.orderOut(nil)
        }
    }
}

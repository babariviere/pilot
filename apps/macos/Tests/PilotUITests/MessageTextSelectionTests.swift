import AppKit
import SwiftUI
import Testing
@testable import Pilot

@Suite(.serialized) @MainActor
struct MessageTextSelectionTests {
    @Test func nativeRebindingSkipsEmptySelectionWritesButClearsRangesAndCarets() {
        _ = NSApplication.shared
        let view = MessageSelectionTextView.makeReadOnly()
        view.string = "A reused message"
        view.setSelectedRange(NSRange(location: 0, length: 0))
        #expect(!view.clearMessageSelection())
        for range in [NSRange(location: 2, length: 4), NSRange(location: 5, length: 0)] {
            view.setSelectedRange(range)
            #expect(view.clearMessageSelection())
            #expect(view.selectedRange() == NSRange(location: 0, length: 0))
            #expect(!view.clearMessageSelection())
        }
    }

    @Test func nativeRebindingStillResetsAffinityAndMultipleRanges() {
        _ = NSApplication.shared
        let view = MessageSelectionTextView.makeReadOnly()
        view.string = "A reused message"
        // AppKit can normalize upstream affinity at offset zero back to the canonical empty selection.
        // A displaced caret requires a real reset even when AppKit normalizes the requested affinity.
        view.setSelectedRanges([NSValue(range: NSRange(location: 5, length: 0))],
                               affinity: .upstream, stillSelecting: false)
        #expect(view.selectedRange() == NSRange(location: 5, length: 0))
        let affinityReset = view.clearMessageSelection()
        #expect(affinityReset)
        #expect(view.selectedRange() == NSRange(location: 0, length: 0))
        #expect(view.selectionAffinity == .downstream)
        view.setSelectedRanges([NSValue(range: NSRange(location: 0, length: 0)),
                                NSValue(range: NSRange(location: 4, length: 2))],
                               affinity: .downstream, stillSelecting: false)
        let multipleReset = view.clearMessageSelection()
        #expect(multipleReset)
        #expect(view.selectedRanges == [NSValue(range: NSRange(location: 0, length: 0))])
        let repeatedReset = view.clearMessageSelection()
        #expect(!repeatedReset)
    }

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
        #expect(last.writeSelection(to: board, type: .string))
        #expect(board.string(forType: .string) == owner.source)
    }

    @Test func nativeCopyExportsTheSharedSelectionAndValidatesAnEmptyFocusedBlock() {
        let owner = MessageTextSelection()
        let first = region("First paragraph", block: 0, owner: owner)
        let code = region("let answer = 42", block: 1, owner: owner)
        let last = region("Last 🧑‍💻 paragraph", block: 2, owner: owner)
        let copy = NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        let start = MessageTextSelection.Position(key: first.selectionKey, offset: first.string.utf16.count)
        let finish = MessageTextSelection.Position(key: last.selectionKey, offset: last.string.utf16.count)
        let board = NSPasteboard(name: .init("pilot-native-copy-test-\(UUID())"))
        defer { board.releaseGlobally() }
        for (a, b) in [(start, finish), (finish, start)] {
            owner.select(from: a, to: b)
            #expect(first.selectedRange().length == 0)
            #expect(first.validateMenuItem(copy))
            #expect(first.writablePasteboardTypes == [.string])
            #expect(first.writeSelection(to: board, type: .string))
            #expect(board.string(forType: .string) == "let answer = 42\n\nLast 🧑‍💻 paragraph")
            #expect(!first.writeSelection(to: board, type: .rtf))
            #expect(code.selectedRange().length == code.string.utf16.count)
        }
        owner.clear()
        #expect(!first.validateMenuItem(copy))
        #expect(!first.writeSelection(to: board, type: .string))
        #expect(board.string(forType: .string) == "let answer = 42\n\nLast 🧑‍💻 paragraph")
    }

    @Test func nativeCopyLinkExportsTheClickedURLInsteadOfTheSharedSelection() throws {
        let owner = MessageTextSelection()
        let previous = region("Another paragraph", block: 0, owner: owner)
        let message = region("🛫 First link and second link", block: 1, owner: owner)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        previous.frame.origin.y = 100
        window.contentView?.addSubview(previous)
        window.contentView?.addSubview(message)
        #expect(window.makeFirstResponder(message))
        let storage = try #require(message.textStorage)
        let links = [
            ("First link", URL(string: "https://example.com/first?q=one%20two#section")!),
            ("second link", URL(string: "https://example.com/second")!),
        ]
        for (label, url) in links {
            storage.addAttribute(.link, value: url, range: (message.string as NSString).range(of: label))
        }
        let board = NSPasteboard.general
        let saved = (board.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }
        defer { board.clearContents(); if !saved.isEmpty { board.writeObjects(saved) } }
        let layout = try #require(message.layoutManager)
        let container = try #require(message.textContainer)
        for (index, link) in links.enumerated() {
            // Cover both no message selection and a selection owned by another region.
            owner.clear()
            if index > 0 {
                owner.select(from: .init(key: previous.selectionKey, offset: 0),
                             to: .init(key: previous.selectionKey, offset: previous.string.utf16.count))
            }
            let range = (message.string as NSString).range(of: link.0)
            let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: range.location, length: 1),
                                          actualCharacterRange: nil)
            let rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
            let point = NSPoint(x: rect.midX + message.textContainerOrigin.x,
                                y: rect.midY + message.textContainerOrigin.y)
            let event = try #require(NSEvent.mouseEvent(with: .rightMouseDown,
                location: message.convert(point, to: nil), modifierFlags: [], timestamp: 0,
                windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
            let menu = try #require(message.menu(for: event))
            let copyLink = try #require(menu.items.first { $0.action == NSSelectorFromString("copyLink:") })
            let action = try #require(copyLink.action)
            board.clearContents()
            board.setString("sentinel", forType: .string)
            #expect(NSApp.sendAction(action, to: message, from: copyLink))
            #expect(board.string(forType: .string) == link.1.absoluteString)
            #expect(board.string(forType: .URL) == link.1.absoluteString)
            #expect(board.string(forType: .init("public.url-name")) == link.0)
        }
    }

    @Test func commandCCopiesAcrossBlocksAndLeavesTheComposerAlone() throws {
        let owner = MessageTextSelection()
        owner.source = "**First paragraph**\n\n```swift\nlet answer = 42\n```"
        let first = region("First paragraph", block: 0, owner: owner)
        let code = region("let answer = 42", block: 1, owner: owner)
        let editor = NSTextView(frame: NSRect(x: 0, y: 150, width: 400, height: 40))
        editor.string = "Composer draft"
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        code.frame.origin.y = 80
        for view in [first, code, editor] { window.contentView?.addSubview(view) }
        let commandC = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
            timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "c",
            charactersIgnoringModifiers: "c", isARepeat: false, keyCode: 8))
        let board = NSPasteboard.general
        // Exercise the real copy action without leaving the developer's clipboard changed.
        let saved = (board.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }
        defer { board.clearContents(); if !saved.isEmpty { board.writeObjects(saved) } }
        board.clearContents()
        board.setString("sentinel", forType: .string)
        #expect(window.makeFirstResponder(first))
        owner.select(from: .init(key: first.selectionKey, offset: first.string.utf16.count),
                     to: .init(key: code.selectionKey, offset: code.string.utf16.count))
        #expect(window.performKeyEquivalent(with: commandC))
        #expect(board.string(forType: .string) == "let answer = 42")
        first.selectAll(nil)
        #expect(window.performKeyEquivalent(with: commandC))
        #expect(board.string(forType: .string) == owner.source)
        #expect(window.makeFirstResponder(editor))
        #expect(!first.performKeyEquivalent(with: commandC))
        #expect(!code.performKeyEquivalent(with: commandC))
        #expect(board.string(forType: .string) == owner.source)
    }

    @Test func selectionShortcutsLeaveAnotherFocusedEditorAlone() throws {
        let owner = MessageTextSelection()
        owner.source = "Agent reply"
        let message = region("Agent reply", block: 0, owner: owner)
        let editor = NSTextView(frame: NSRect(x: 0, y: 80, width: 400, height: 40))
        editor.string = "Composer draft"
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 140),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView?.addSubview(message)
        window.contentView?.addSubview(editor)
        window.makeFirstResponder(editor)
        let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
                                                  timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                                  characters: "a", charactersIgnoringModifiers: "a",
                                                  isARepeat: false, keyCode: 0))
        #expect(!message.performKeyEquivalent(with: event))
        #expect(owner.selectedText.isEmpty)
        window.makeFirstResponder(message)
        #expect(message.performKeyEquivalent(with: event))
        #expect(owner.selectedText == "Agent reply")
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

    @Test func streamedAppendsEditOnlyTheTailAndKeepSizeAndSelection() {
        let style = MessageSelectionTextView.Style(font: .systemFont(ofSize: 14),
            mono: .monospacedSystemFont(ofSize: 12, weight: .regular), color: .labelColor, spacing: 3)
        let owner = MessageTextSelection()
        let view = MessageSelectionTextView.make()
        view.setFrameSize(NSSize(width: 320, height: 200))
        view.selectionOwner = owner
        owner.register(view)
        var text = "Streaming text keeps growing. "
        guard let storage = view.textStorage else { Issue.record("Expected text storage"); return }
        storage.setAttributedString(SelectableMessageText.attributed(AttributedString(text), style: style))
        owner.select(from: .init(key: view.selectionKey, offset: 2), to: .init(key: view.selectionKey, offset: 9))
        var next = NSAttributedString()
        for index in 0 ..< 30 {
            text += "More **words** \(index). "
            next = SelectableMessageText.attributed(AttributedString(text), style: style)
            #expect(view.replaceChangedTail(storage, with: next) != nil)
            #expect(storage.isEqual(to: next))
        }
        #expect(view.selectedRange() == NSRange(location: 2, length: 7))
        let fresh = MessageSelectionTextView.make()
        fresh.setFrameSize(NSSize(width: 320, height: 200))
        fresh.textStorage?.setAttributedString(next)
        view.invalidateMeasurements()
        #expect(view.measure(width: 320, unwrapped: false) == fresh.measure(width: 320, unwrapped: false))
        // Probing another width uses a separate layout, so the drawn one is not invalidated.
        let probed = view.measure(width: 500, unwrapped: false)
        #expect(view.textContainer?.size.width == 320)
        #expect(probed == fresh.measure(width: 500, unwrapped: false))
    }

    @Test func sizeProbesNeverInvalidateTheDrawnTextLayout() throws {
        _ = NSApplication.shared
        let storage = NSTextStorage(string: String(repeating: "Text keeps its placed wrapping. ", count: 40),
                                    attributes: [.font: NSFont.systemFont(ofSize: 14)])
        let layout = GeometryTrackingLayoutManager()
        let container = NSTextContainer(size: .zero)
        container.lineFragmentPadding = 0
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        let view = MessageSelectionTextView(frame: .zero, textContainer: container)
        view.textContainerInset = .zero
        container.widthTracksTextView = false
        container.heightTracksTextView = false
        view.setFrameSize(NSSize(width: 320, height: 200))
        layout.ensureLayout(for: container)
        let placedSize = container.size
        let placedGlyphs = layout.glyphRange(for: container)
        let changes = layout.geometryChanges
        // Initial content, not just an edited-in-place tail, must use an isolated sizing layout.
        for width: CGFloat in [760, 1, 500, 320, 760] {
            _ = view.measure(width: width, unwrapped: false)
            #expect(container.size == placedSize)
            #expect(layout.geometryChanges == changes, "a size probe invalidated the drawn container")
        }
        #expect(layout.glyphRange(for: container) == placedGlyphs)
        // The same boundary holds after an append and when a placed view changes width.
        let next = NSAttributedString(string: storage.string + "More words.", attributes: [.font: NSFont.systemFont(ofSize: 14)])
        let start = try #require(view.replaceChangedTail(storage, with: next))
        #expect(start > 0)
        view.invalidateMeasurements()
        view.setFrameSize(NSSize(width: 280, height: 240))
        let resizedChanges = layout.geometryChanges
        _ = view.measure(width: 500, unwrapped: false)
        #expect(container.size.width == 280)
        #expect(layout.geometryChanges == resizedChanges)
    }

    @Test func streamedTextFadesInUnderAVeilWithoutChangingLayout() {
        let view = MessageSelectionTextView.make()
        view.textContainer?.lineFragmentPadding = 0
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView?.addSubview(view)
        view.setFrameSize(NSSize(width: 320, height: 120))
        let text = String(repeating: "Streamed words keep arriving. ", count: 8)
        view.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 14)]))
        let before = view.measure(width: 320, unwrapped: false)
        view.fadeIn(NSRange(location: 60, length: text.utf16.count - 60), from: .white)
        #expect(view.fadingVeilCount == 0, "veils wait for the draw that shows the new glyphs")
        view.display()
        #expect(view.fadingVeilCount > 1, "one veil per word run and line the new text covers")
        #expect(view.string == text)
        view.invalidateMeasurements()
        #expect(view.measure(width: 320, unwrapped: false) == before)
        window.close()
    }

    @Test func isolatedSizingKeepsCodeUnwrappedAndBubblesHugging() {
        let view = MessageSelectionTextView.makeReadOnly()
        view.textStorage?.setAttributedString(NSAttributedString(string: "Short text",
            attributes: [.font: NSFont.systemFont(ofSize: 14)]))
        let bubble = view.measure(width: 320, unwrapped: false, hugsContent: true)
        #expect(bubble.width > 0 && bubble.width < 320)
        view.unwrapped = true
        let code = view.measure(width: 1_000_000, unwrapped: true)
        view.setFrameSize(code)
        #expect(code.width == bubble.width)
        #expect(view.textContainer?.size.width == 1_000_000, "the drawn code container stays unwrapped too")
        view.unwrapped = false
        view.setFrameSize(NSSize(width: 80, height: code.height))
        #expect(view.textContainer?.size.width == 80)
        let wrapped = view.measure(width: 80, unwrapped: false)
        #expect(wrapped.height >= code.height)
    }

    @Test func unchangedBubblesCacheTheWholeSwiftUIProbeCycle() throws {
        let view = MessageSelectionTextView.makeReadOnly()
        view.textStorage?.setAttributedString(NSAttributedString(string: "Historical message 999",
            attributes: [.font: NSFont.systemFont(ofSize: 14)]))
        view.setFrameSize(NSSize(width: 153, height: 17))
        // Widths captured by the release streaming fixture, including probes of the window's size constraints.
        let widths: [CGFloat] = [159, 660, 153, 264, 760, 593]
        let sizes = widths.map { view.measure(width: $0, unwrapped: false, hugsContent: true) }
        let sizingLayout = try #require(view.textStorage?.layoutManagers.first { $0 !== view.layoutManager })
        let sizingContainer = try #require(sizingLayout.textContainers.first)
        let settled = sizingContainer.size
        for _ in 0..<3 {
            for (width, size) in zip(widths, sizes) {
                #expect(view.measure(width: width, unwrapped: false, hugsContent: true) == size)
                #expect(sizingContainer.size == settled, "cached widths must not rerun TextKit layout")
            }
        }
        // A content change invalidates every width, not just the last drawn width.
        view.textStorage?.append(NSAttributedString(string: " has a longer ending"))
        view.invalidateMeasurements()
        let wider = view.measure(width: 760, unwrapped: false, hugsContent: true)
        #expect(wider.width > sizes[4].width)
    }

    @Test func tailEditsStartAtTheFirstChangedTextOrStyle() {
        let font = NSFont.systemFont(ofSize: 14)
        let bold = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
        let plain = NSAttributedString(string: "Hello **wor", attributes: [.font: font])
        let restyled = NSMutableAttributedString(string: "Hello ", attributes: [.font: font])
        restyled.append(NSAttributedString(string: "world", attributes: [.font: bold]))
        #expect(MessageSelectionTextView.firstDifference(plain, restyled) == 6)
        let grown = NSAttributedString(string: "Hello **world", attributes: [.font: font])
        #expect(MessageSelectionTextView.firstDifference(plain, grown) == plain.length)
        let linked = NSMutableAttributedString(string: "See https://example.com", attributes: [.font: font])
        linked.addAttribute(.link, value: URL(string: "https://example.com")!, range: NSRange(location: 4, length: 19))
        let unlinked = NSAttributedString(string: "See https://example.com", attributes: [.font: font])
        #expect(MessageSelectionTextView.firstDifference(unlinked, linked) == 4)
        // A family emoji shares its first code units with a lone person; never split a character.
        let person = NSAttributedString(string: "Hi 🧑", attributes: [.font: font])
        let family = NSAttributedString(string: "Hi 🧑‍💻", attributes: [.font: font])
        #expect(MessageSelectionTextView.firstDifference(person, family) == 3)
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

    @Test func selectionClearsWhenFocusLeavesTheMessage() {
        let owner = MessageTextSelection(), other = MessageTextSelection()
        let first = region("First region", block: 0, owner: owner)
        let second = region("Second region", block: 1, owner: owner)
        let elsewhere = region("Another message", block: 0, owner: other)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 200))
        for view in [first, second, elsewhere] { window.contentView?.addSubview(view) }
        window.makeFirstResponder(first)
        owner.select(from: .init(key: first.selectionKey, offset: 0), to: .init(key: second.selectionKey, offset: 6))

        // Moving between regions of the same message keeps its selection.
        window.makeFirstResponder(second)
        owner.clearUnlessFocused(after: first)
        #expect(owner.hasSelection)
        #expect(first.selectedRange().length == first.string.utf16.count)

        // A region leaving the window, as when scrolled out of a lazy list, keeps it too.
        second.removeFromSuperview()
        owner.clearUnlessFocused(after: second)
        #expect(owner.hasSelection)
        window.contentView?.addSubview(second)

        // Focus elsewhere drops it, so no inactive highlight stays behind.
        window.makeFirstResponder(elsewhere)
        owner.clearUnlessFocused(after: second)
        #expect(!owner.hasSelection)
        #expect(first.selectedRange().length == 0)
        #expect(second.selectedRange().length == 0)
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

private final class GeometryTrackingLayoutManager: NSLayoutManager {
    var geometryChanges = 0

    override func textContainerChangedGeometry(_ container: NSTextContainer) {
        geometryChanges += 1
        super.textContainerChangedGeometry(container)
    }
}

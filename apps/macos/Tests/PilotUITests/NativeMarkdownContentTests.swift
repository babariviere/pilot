import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func nativeCodeMeasuresUnwrappedAndRebindsSelectionWithoutAHost() {
    _ = NSApplication.shared
    let view = NativeCodeBlock()
    let source = "let value = \"" + String(repeating: "wide-code-", count: 400) + "\""
    let first = MessageTextSelection()
    first.source = source
    let fonts = EnvironmentValues().pilotFonts
    view.update(source: source, language: "swift", prepared: AttributedString(source), fonts: fonts,
                selection: first, block: 2, changed: {})
    let wide = view.measure(width: 700)
    let narrow = view.measure(width: 180)
    #expect(wide.height == narrow.height)
    #expect(view.text.frame.width > 700)
    #expect(view.scroll.documentView?.frame.width ?? 0 > 700)
    first.selectAll()
    #expect(first.selectedText == source)
    #expect(view.text.selectedRange().length > 0)
    let second = MessageTextSelection()
    view.update(source: source, language: "swift", prepared: AttributedString(source), fonts: fonts,
                selection: second, block: 4, changed: {})
    #expect(view.text.selectionOwner === second)
    #expect(view.text.selectionKey == .init(block: 4))
    #expect(view.text.selectedRange().length == 0)
    #expect(view.subviews.compactMap { $0 as? NSHostingView<AnyView> }.isEmpty)
    view.stop()
}

@Test @MainActor func nativeMarkdownTableRebindClearsEveryCellAndPreservesMessageCopy() async throws {
    _ = NSApplication.shared
    let source = "| Name | Value |\n| --- | ---: |\n| **One** | [link](https://example.com) |"
    let blocks = try await MarkdownRenderer.shared.prepare(source)
    let prepared = try #require(blocks.first)
    let view = NativeMarkdownBlockView()
    let first = MessageTextSelection()
    first.source = source
    view.update(prepared, index: 3, selection: first, environment: EnvironmentValues(),
                streaming: false, fadesInitial: false, changed: {})
    first.selectAll()
    #expect(first.selectedText == source)
    #expect(view.nativeTextViews.count == 4)
    let cellText = view.nativeTextViews.map { $0.string }
    #expect(cellText == ["Name", "Value", "One", "link"])
    #expect(view.nativeTextViews.allSatisfy { $0.selectedRange().length > 0 })
    let second = MessageTextSelection()
    view.update(prepared, index: 3, selection: second, environment: EnvironmentValues(),
                streaming: false, fadesInitial: false, changed: {})
    #expect(view.nativeTextViews.allSatisfy { $0.selectionOwner === second && $0.selectedRange().length == 0 })
    let table = try #require(view.subviews.compactMap { $0 as? MarkdownTableView }.first)
    #expect(table.accessibilityRole() == .table)
    #expect(table.accessibilityRows()?.count == 2)
    #expect(table.accessibilityColumns()?.count == 2)
    #expect(view.subviews.compactMap { $0 as? NSHostingView<AnyView> }.isEmpty)
    view.stop()
}

@Test @MainActor func nativeDiagramHasFinalHeightWithoutAHostAndPresentsOutsideTheCell() throws {
    _ = NSApplication.shared
    let source = "flowchart LR\nA[One] --> B[Two]"
    let native = try #require(NativeMermaid.layout(source))
    let diagram = NativeDiagramBlock()
    var request: NativeTranscriptPresentation.Request?
    var environment = EnvironmentValues()
    environment.nativeTranscriptPresent = { request = $0 }
    diagram.update(kind: .mermaid, source: source, native: native, selection: MessageTextSelection(),
                   block: 0, environment: environment, changed: {})
    for width: CGFloat in [760, 240, 760] {
        let size = diagram.measure(width: width)
        #expect(size.height == DiagramLayout.inlineHeight(natural: native.natural, availableWidth: width))
        #expect(diagram.subviews.compactMap { $0 as? NSHostingView<AnyView> }.isEmpty)
    }
    let event = try #require(NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [],
        timestamp: 1, windowNumber: 0, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
    let menu = try #require(diagram.menu(for: event))
    let expand = try #require(menu.items.first)
    let expandAction = try #require(expand.action)
    let expanded = NSApp.sendAction(expandAction, to: expand.target, from: expand)
    #expect(expanded)
    let presented = try #require(request)
    if case let .diagram(kind, text, layout) = presented.content {
        #expect(kind == .mermaid && text == source && layout == native)
    } else { Issue.record("Expected the diagram viewer") }
    let sourceItem = try #require(menu.items.first { $0.title == "Show source" })
    let sourceAction = try #require(sourceItem.action)
    let toggled = NSApp.sendAction(sourceAction, to: sourceItem.target, from: sourceItem)
    #expect(toggled)
    _ = diagram.measure(width: 240)
    #expect(diagram.nativeTextViews.count == 1)
    #expect(diagram.nativeTextViews.first?.string == source)
    diagram.stop()
}

import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

/// Regression coverage for native chat tables: overflow and scroll routing, appearance and fonts, awkward content,
/// streamed growth, focus exit and accessibility hit-testing. These run the real views offscreen; they do not replace
/// checks with VoiceOver or a physical trackpad.
@Suite(.serialized) @MainActor
struct MarkdownTableRegressionTests {
    private func style(_ size: CGFloat, weight: NSFont.Weight = .regular) -> MessageSelectionTextView.Style {
        MessageSelectionTextView.Style(font: .systemFont(ofSize: size, weight: weight),
                                       mono: .monospacedSystemFont(ofSize: size - 1, weight: .regular),
                                       color: .labelColor, spacing: MarkdownTableView.lineSpacing)
    }

    private func update(_ view: MarkdownTableView, _ table: MarkdownTable, size: CGFloat = 13,
                        owner: MessageTextSelection? = nil) {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        func inline(_ text: String) -> AttributedString {
            (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        }
        view.update(rows: [table.header.map(inline)] + table.rows.map { $0.map(inline) }, alignments: table.alignments,
                    header: style(size, weight: .semibold), body: style(size), selection: owner, block: 0)
    }

    private func parsedTable(_ source: String) throws -> MarkdownTable {
        let blocks = Markdown.parse(source)
        guard case let .table(table)? = blocks.first(where: { if case .table = $0 { true } else { false } }) else {
            Issue.record("no table in \(source.debugDescription)")
            throw CancellationError()
        }
        return table
    }

    private func view(_ source: String, size: CGFloat = 13, owner: MessageTextSelection? = nil) throws -> MarkdownTableView {
        _ = NSApplication.shared
        let view = MarkdownTableView(frame: .zero)
        update(view, try parsedTable(source), size: size, owner: owner)
        return view
    }

    /// Mounts the table at the width SwiftUI would give it, inside a parent that records scroll events passed on.
    private func mount(_ table: MarkdownTableView, width: CGFloat) -> (NSWindow, ScrollRecorder) {
        let size = table.size(forWidth: width)
        let parent = ScrollRecorder(frame: NSRect(x: 0, y: 0, width: width, height: size.height))
        let window = NSWindow(contentRect: parent.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = parent
        table.frame = NSRect(origin: .zero, size: size)
        parent.addSubview(table)
        parent.layoutSubtreeIfNeeded()
        return (window, parent)
    }

    private func scrollView(of table: MarkdownTableView) throws -> MarkdownTableScrollView {
        try #require(table.subviews.compactMap { $0 as? MarkdownTableScrollView }.first)
    }

    private func wheel(dx: Int32, dy: Int32, phase: Int64 = 0, momentum: Int64 = 0) throws -> NSEvent {
        let event = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
        event.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
        return try #require(NSEvent(cgEvent: event))
    }

    private static let wide: String = {
        let columns = (1 ... 6).map { "Column \($0)" }
        let header = "| \(columns.joined(separator: " | ")) |"
        let separator = "|" + String(repeating: "---|", count: 6)
        let cell = String(repeating: "long words ", count: 30)
        let row = Array(repeating: cell, count: 6).joined(separator: " | ")
        return [header, separator, "| \(row) |"].joined(separator: "\n")
    }()

    @Test func anOverflowingTableScrollsSidewaysAndPassesVerticalScrollingOn() throws {
        let table = try view(Self.wide)
        let (window, parent) = mount(table, width: 320)
        defer { window.close() }
        #expect(table.frame.width == 320)
        let scroll = try scrollView(of: table)
        #expect(scroll.documentView!.frame.width > scroll.contentView.bounds.width)
        scroll.scrollWheel(with: try wheel(dx: 0, dy: -30))
        #expect(parent.received == 1)
        scroll.scrollWheel(with: try wheel(dx: -40, dy: 0))
        // Horizontal scrolling stays with the table. How far AppKit moves the clip offscreen depends on timing, so only
        // the routing is checked here.
        #expect(parent.received == 1)
        // A table that fits passes even horizontal scrolling on.
        let small = try view("| a | b |\n|---|---|\n| 1 | 2 |")
        let (other, smallParent) = mount(small, width: 320)
        defer { other.close() }
        try scrollView(of: small).scrollWheel(with: try wheel(dx: -40, dy: 0))
        #expect(smallParent.received == 1)
    }

    @Test func trackpadGesturesKeepTheAxisTheyStartedWith() throws {
        let scroll = MarkdownTableScrollView()
        // CGScrollPhase: began 1, changed 2, ended 4. CGMomentumScrollPhase: begin 1, continue 2, end 3.
        #expect(scroll.scrollsHorizontally(try wheel(dx: -6, dy: 1, phase: 1)))
        #expect(scroll.scrollsHorizontally(try wheel(dx: 0, dy: -9, phase: 2)))
        #expect(scroll.scrollsHorizontally(try wheel(dx: -2, dy: -4, momentum: 2)))
        #expect(!scroll.scrollsHorizontally(try wheel(dx: 1, dy: -8, phase: 1)))
        #expect(!scroll.scrollsHorizontally(try wheel(dx: -9, dy: 0, phase: 2)))
        #expect(!scroll.scrollsHorizontally(try wheel(dx: -9, dy: 0, momentum: 2)))
        // A gesture whose first event has no movement decides on its first movement.
        #expect(!scroll.scrollsHorizontally(try wheel(dx: 0, dy: 0, phase: 1)))
        #expect(scroll.scrollsHorizontally(try wheel(dx: -5, dy: 0, phase: 2)))
    }

    @Test func borderFollowsTheEffectiveAppearance() throws {
        let table = try view("| a |\n|---|\n| 1 |")
        func border(_ name: NSAppearance.Name) -> NSColor? {
            table.appearance = NSAppearance(named: name)
            table.updateLayer()
            return table.layer?.borderColor.flatMap { NSColor(cgColor: $0) }
        }
        let light = try #require(border(.aqua))
        let dark = try #require(border(.darkAqua))
        #expect(light != dark)
    }

    @Test func largerFontsMakeTallerRowsAndWiderColumns() throws {
        let source = "| Name | Value |\n|---|---|\n| alpha | a short sentence |"
        let regular = try view(source, size: 13)
        let large = try view(source, size: 22)
        #expect(large.size(forWidth: 760).height > regular.size(forWidth: 760).height)
        #expect(large.size(forWidth: 760).width > regular.size(forWidth: 760).width)
    }

    @Test func unicodeRaggedAndEmptyCellsKeepEveryValue() throws {
        let table = try view("| Name | 名前 |\n|:-:|--:|\n| 🧑‍💻 | שלום |\n| | |\n| a | b | extra |\n| only |")
        #expect(table.columnCount == 3)
        let text = table.cells.map { $0.map(\.text.string) }
        #expect(text == [["Name", "名前", ""], ["🧑‍💻", "שלום", ""], ["", "", ""], ["a", "b", "extra"], ["only", "", ""]])
        let size = table.size(forWidth: 400)
        #expect(size.width > 0 && size.width <= 400 && size.height.isFinite)
        #expect(table.cells[1][0].naturalWidth > 0)
        #expect(table.cells[2][0].height(forWidth: 96) > 0)
    }

    @Test func streamedTablesMatchTheReopenedTableAndKeepTheirCells() throws {
        var document = "| Step | Result | Note |\n| --- | :-: | --: |\n"
        for row in 0 ..< 120 { document += "| step \(row) | **ok** | §\(row)|x§ |\n".replacingOccurrences(of: "§", with: "`") }
        _ = NSApplication.shared
        let owner = MessageTextSelection()
        let streamed = MarkdownTableView(frame: .zero)
        var stream = MarkdownStream()
        var firstBodyCell: MarkdownTableCellView?
        let characters = Array(document)
        var end = 0
        while end < characters.count {
            end = min(characters.count, end + 37)
            stream.update(String(characters[0 ..< end]))
            guard case let .table(table)? = stream.blocks.last else { continue }
            update(streamed, table, owner: owner)
            _ = streamed.size(forWidth: 600)
            if firstBodyCell == nil, streamed.cells.count > 1 { firstBodyCell = streamed.cells[1][0] }
        }
        let reopened = try view(document)
        #expect(streamed.cells.map { $0.map(\.text.string) } == reopened.cells.map { $0.map(\.text.string) })
        #expect(streamed.cells.count == 121)
        #expect(streamed.size(forWidth: 600) == reopened.size(forWidth: 600))
        // Rows kept their views while the table grew, and the plan cache stayed bounded.
        #expect(streamed.cells[1][0] === firstBodyCell)
        #expect(streamed.cachedPlanCount <= 4)
        for width in stride(from: 300, through: 800, by: 50) { _ = streamed.size(forWidth: CGFloat(width)) }
        #expect(streamed.cachedPlanCount <= 4)
    }

    @Test func focusLeavingTheTableClearsItsSelectionButMovingBetweenCellsKeepsIt() throws {
        let owner = MessageTextSelection()
        let table = try view("| a | b |\n|---|---|\n| one | two |", owner: owner)
        let (window, parent) = mount(table, width: 400)
        defer { window.close() }
        let editor = NSTextField(frame: NSRect(x: 0, y: 0, width: 50, height: 20))
        parent.addSubview(editor)
        let first = table.cells[1][0].text, second = table.cells[1][1].text
        #expect(window.makeFirstResponder(first))
        owner.select(from: .init(key: first.selectionKey, offset: 0), to: .init(key: second.selectionKey, offset: 3))
        #expect(owner.selectedText == "one\ttwo")
        #expect(window.makeFirstResponder(second))
        owner.clearUnlessFocused(after: first)
        #expect(owner.hasSelection)
        #expect(window.makeFirstResponder(editor))
        owner.clearUnlessFocused(after: second)
        #expect(!owner.hasSelection)
    }

    @Test func accessibilityHitTestingReachesTheCellUnderAPoint() throws {
        let table = try view("| Name | Value |\n|---|---|\n| alpha | beta |")
        let (window, _) = mount(table, width: 400)
        defer { window.close() }
        let target = table.cells[1][1]
        let local = NSPoint(x: target.bounds.midX, y: target.bounds.midY)
        let screen = window.convertPoint(toScreen: target.convert(local, to: nil))
        func parent(_ element: Any?) -> Any? {
            (element as? NSView)?.accessibilityParent() ?? (element as? NSAccessibilityElement)?.accessibilityParent()
        }
        // The cell under the point (or its text), whose parent chain leads to its row and the table.
        let hit = table.accessibilityHitTest(screen)
        let cell = hit as? MarkdownTableCellView ?? parent(hit) as? MarkdownTableCellView
        #expect(cell === target)
        #expect(parent(cell) as? MarkdownTableRowElement === table.accessibilityRows()?[1] as? MarkdownTableRowElement)
        #expect(parent(parent(cell)) as? MarkdownTableView === table)
        #expect(table.screenFrame(of: [target]).contains(screen))
    }

    @Test func copyingFromACellExportsTheTabSeparatedSelection() throws {
        let owner = MessageTextSelection()
        let table = try view("| a | b |\n|---|---|\n| one | two |\n| three | four |", owner: owner)
        let cells = table.cells
        owner.select(from: .init(key: cells[1][1].text.selectionKey, offset: 1), to: .init(key: cells[2][1].text.selectionKey, offset: 2))
        let board = NSPasteboard(name: .init("pilot-table-copy-\(UUID())"))
        defer { board.releaseGlobally() }
        #expect(cells[2][0].text.writeSelection(to: board, type: .string))
        #expect(board.string(forType: .string) == "wo\nthree\tfo")
    }
}

/// Counts scroll events that reach the table's parent, standing in for the transcript's scroll view.
final class ScrollRecorder: NSView {
    private(set) var received = 0
    override func scrollWheel(with event: NSEvent) { received += 1 }
}

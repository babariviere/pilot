import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Suite(.serialized) @MainActor
struct MarkdownTableViewTests {
    private let body = MessageSelectionTextView.Style(font: .systemFont(ofSize: 13), mono: .monospacedSystemFont(ofSize: 12, weight: .regular),
                                                      color: .labelColor, spacing: MarkdownTableView.lineSpacing)
    private let header = MessageSelectionTextView.Style(font: .systemFont(ofSize: 13, weight: .semibold),
                                                        mono: .monospacedSystemFont(ofSize: 12, weight: .regular),
                                                        color: .labelColor, spacing: MarkdownTableView.lineSpacing)

    private func table(_ rows: [[String]], alignments: [MarkdownTableAlignment] = [], owner: MessageTextSelection? = nil,
                       block: Int = 0) -> MarkdownTableView {
        _ = NSApplication.shared
        let view = MarkdownTableView(frame: .zero)
        view.update(rows: rows.map { $0.map { AttributedString($0) } }, alignments: alignments, header: header, body: body,
                    selection: owner, block: block)
        return view
    }

    private func mount(_ view: MarkdownTableView, width: CGFloat) -> NSWindow {
        let size = view.size(forWidth: width)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: size.height + 20),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        view.frame = NSRect(origin: .zero, size: size)
        window.contentView?.addSubview(view)
        view.layoutSubtreeIfNeeded()
        return window
    }

    @Test func exposesRowsColumnsCellsAndColumnHeaders() throws {
        let view = table([["Name", "Value"], ["a", "1"], ["b", "2"]], alignments: [.none, .trailing])
        #expect(view.accessibilityRole() == .table)
        #expect(view.accessibilityRowCount() == 3)
        #expect(view.accessibilityColumnCount() == 2)
        let rows = try #require(view.accessibilityRows() as? [NSAccessibilityElement])
        let columns = try #require(view.accessibilityColumns() as? [NSAccessibilityElement])
        #expect(rows.map { $0.accessibilityRole() } == [.row, .row, .row])
        #expect(columns.map { $0.accessibilityRole() } == [.column, .column])
        let headers = try #require(view.accessibilityColumnHeaderUIElements() as? [MarkdownTableCellView])
        #expect(headers.map(\.text.string) == ["Name", "Value"])
        let cell = try #require(view.accessibilityCell(forColumn: 1, row: 2) as? MarkdownTableCellView)
        #expect(cell.text.string == "2")
        #expect(cell.accessibilityRole() == .cell)
        #expect(cell.accessibilityRowIndexRange() == NSRange(location: 2, length: 1))
        #expect(cell.accessibilityColumnIndexRange() == NSRange(location: 1, length: 1))
        #expect((cell.accessibilityParent() as? NSAccessibilityElement) === rows[2])
        let cellHeaders = try #require(cell.accessibilityColumnHeaderUIElements() as? [MarkdownTableCellView])
        #expect(cellHeaders.map(\.text.string) == ["Value"])
        #expect(headers[0].accessibilityColumnHeaderUIElements() == nil)
        #expect((rows[1].accessibilityChildren() as? [MarkdownTableCellView])?.map(\.text.string) == ["a", "1"])
        #expect((columns[0].accessibilityChildren() as? [MarkdownTableCellView])?.map(\.text.string) == ["Name", "a", "b"])
        #expect((columns[1].accessibilityHeader() as? MarkdownTableCellView)?.text.string == "Value")
        #expect(view.accessibilityCell(forColumn: 2, row: 0) == nil)
        // The trailing column's text is right-aligned.
        let style = cell.text.textStorage?.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        #expect(style?.alignment == .right)
    }

    @Test func narrowTablesKeepTheirWidthAndWideTablesScrollWithoutWideningTheColumn() {
        let small = table([["a", "b"], ["1", "2"]])
        let compact = small.size(forWidth: 600)
        #expect(compact.width < 200)
        #expect(!small.plan(for: 600).columns.overflows)
        let long = String(repeating: "word ", count: 60)
        let wide = table([["One", "Two", "Three", "Four", "Five", "Six"], Array(repeating: long, count: 6)])
        for width: CGFloat in [320, 480, 760] {
            #expect(wide.size(forWidth: width).width == width, "width \(width)")
        }
        #expect(wide.plan(for: 320).columns.overflows)
        #expect(wide.plan(for: 320).content.width > 320)
        // Wrapping makes a narrower table taller instead of wider while it can.
        let two = table([["A", "B"], [long, long]])
        #expect(!two.plan(for: 480).columns.overflows)
        #expect(two.size(forWidth: 480).height > two.size(forWidth: 760).height)
    }

    @Test func selectionCopiesCellsAsTabSeparatedRowsInRowMajorOrder() throws {
        let owner = MessageTextSelection()
        let view = table([["Name", "Note", "N"], ["a", "", "1"], ["b", "x", "2"]], owner: owner, block: 3)
        let cells = view.cells
        #expect(cells.flatMap { $0 }.map(\.text.selectionKey) == (0 ..< 3).flatMap { row in
            (0 ..< 3).map { MessageTextSelection.Key(block: 3, item: row, column: $0) }
        })
        owner.select(from: .init(key: cells[0][1].text.selectionKey, offset: 1),
                     to: .init(key: cells[2][1].text.selectionKey, offset: 1))
        // The empty cell inside the selection keeps its column.
        #expect(owner.selectedText == "ote\tN\na\t\t1\nb\tx")
        owner.source = "| Name | Note | N |\n|---|---|--:|\n| a | | 1 |\n| b | x | 2 |"
        owner.selectAll()
        #expect(owner.selectedText == owner.source)
        view.unregister()
    }

    @Test func dragsBetweenSideBySideCellsUseHorizontalDistance() throws {
        let owner = MessageTextSelection()
        let view = table([["Left", "Right"], ["alpha", "beta"]], owner: owner)
        let window = mount(view, width: 400)
        defer { window.close() }
        let cells = view.cells
        owner.select(from: .init(key: cells[1][0].text.selectionKey, offset: 0),
                     to: .init(key: cells[1][0].text.selectionKey, offset: 0))
        let target = cells[1][1].text
        let point = target.convert(NSPoint(x: target.bounds.maxX + 4, y: target.bounds.midY), to: nil)
        owner.extend(toWindowPoint: point)
        #expect(owner.end?.key == target.selectionKey)
        #expect(owner.selectedText == "alpha\tbeta")
    }

    @Test func streamedRowsKeepTheirCellViewsAndSelection() throws {
        let owner = MessageTextSelection()
        let view = table([["A", "B"], ["one", "tw"]], owner: owner)
        let first = view.cells[1][0]
        owner.select(from: .init(key: first.text.selectionKey, offset: 0), to: .init(key: first.text.selectionKey, offset: 3))
        view.update(rows: [["A", "B"], ["one", "two"], ["three", "four"]].map { $0.map { AttributedString($0) } },
                    alignments: [], header: header, body: body, selection: owner, block: 0)
        #expect(view.cells[1][0] === first)
        #expect(first.text.selectedRange() == NSRange(location: 0, length: 3))
        #expect(view.cells[1][1].text.string == "two")
        #expect(view.accessibilityRowCount() == 3)
        // A shorter replacement drops rows and their selection regions.
        view.update(rows: [["A", "B"]].map { $0.map { AttributedString($0) } }, alignments: [], header: header, body: body,
                    selection: owner, block: 0)
        #expect(view.cells.count == 1)
        #expect(first.superview == nil)
        #expect(first.text.selectionOwner == nil)
    }

    @Test func verticalScrollingIsLeftToTheTranscript() throws {
        let scroll = MarkdownTableScrollView()
        func wheel(dx: Int32, dy: Int32) throws -> NSEvent {
            let event = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                             wheel1: dy, wheel2: dx, wheel3: 0))
            return try #require(NSEvent(cgEvent: event))
        }
        #expect(!scroll.scrollsHorizontally(try wheel(dx: 0, dy: -12)))
        #expect(!scroll.scrollsHorizontally(try wheel(dx: 2, dy: -12)))
        #expect(scroll.scrollsHorizontally(try wheel(dx: -12, dy: 1)))
    }
}

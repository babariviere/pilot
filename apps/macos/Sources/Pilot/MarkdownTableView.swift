import AppKit
import PilotCore
import SwiftUI

/// A Markdown table in a message, drawn natively. Each cell is message text that takes part in the message's shared
/// selection, and the table exposes rows, columns, cells and their column headers to assistive technology.
/// The table never widens the reading column: columns wrap down to a minimum width, then the table alone scrolls
/// horizontally while vertical scrolling stays with the transcript.
struct MarkdownTableBlock: NSViewRepresentable {
    let table: MarkdownTable
    /// Inline Markdown of every cell, prepared off the main actor. Plain cell text until it arrives.
    let prepared: PreparedMarkdownTable?
    @Environment(\.pilotFonts) private var fonts
    @Environment(\.messageTextSelection) private var selection
    @Environment(\.messageSelectionBlock) private var block
    @Environment(\.messageSelectionColor) private var color

    func makeNSView(context: Context) -> MarkdownTableView {
        let view = MarkdownTableView(frame: .zero)
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: MarkdownTableView, context: Context) {
        let header = prepared?.header ?? table.header.map { AttributedString($0) }
        let rows = prepared?.rows ?? table.rows.map { $0.map { AttributedString($0) } }
        let body = MessageSelectionTextView.Style(font: fonts.nsBody, mono: fonts.nsMono, color: color,
                                                  spacing: MarkdownTableView.lineSpacing)
        let heading = MessageSelectionTextView.Style(font: fonts.nsChat(fonts.chatSize, weight: .semibold), mono: fonts.nsMono,
                                                     color: color, spacing: MarkdownTableView.lineSpacing)
        view.update(rows: [header] + rows, alignments: table.alignments, header: heading, body: body,
                    selection: selection, block: block)
    }

    static func dismantleNSView(_ view: MarkdownTableView, coordinator: ()) {
        view.unregister()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: MarkdownTableView, context: Context) -> CGSize? {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? Theme.column
        return view.size(forWidth: max(1, width))
    }
}

/// The table: a rounded border around a horizontal-only scroll view whose document holds the cells.
/// Row 0 is the header. Column widths come from `MarkdownTableColumns`; sizes for the last few widths are cached and
/// every cell caches its own measurements, so a streamed row lays out only what changed.
@MainActor
final class MarkdownTableView: NSView {
    /// Space between a cell's edges and its text.
    static let padding = NSSize(width: 10, height: 6)
    /// Lines between rows and columns and around the table.
    static let rule: CGFloat = 1
    static let lineSpacing: CGFloat = 2
    /// A column's text is never wider than this, so long cells wrap at a readable measure.
    static let maximumColumnWidth: CGFloat = 360
    /// Columns shrink to this before the table scrolls instead.
    static let minimumColumnWidth: CGFloat = 96
    /// Column width cap once the table scrolls horizontally.
    static let overflowColumnWidth: CGFloat = 240
    /// Width each column adds around its text: padding on both sides and one rule.
    static var columnSpacing: CGFloat { padding.width * 2 + rule }

    struct Plan {
        let width: CGFloat
        let columns: MarkdownTableColumns
        let rowHeights: [CGFloat]
        /// The document's size, without the outer border.
        let content: CGSize
        let scrollerHeight: CGFloat
    }

    private let scrollView = MarkdownTableScrollView()
    private let grid = MarkdownTableGridView()
    /// Row-major cells, header first.
    private(set) var cells: [[MarkdownTableCellView]] = []
    private var rowElements: [MarkdownTableRowElement] = []
    private var columnElements: [MarkdownTableColumnElement] = []
    private(set) var columnCount = 0
    private var plans: [Plan] = []
    private var flashedOverflow = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = Theme.Radius.control
        layer?.masksToBounds = true
        layer?.borderWidth = Self.rule
        scrollView.drawsBackground = false
        scrollView.hasHorizontalScroller = true
        scrollView.hasVerticalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.verticalScrollElasticity = .none
        scrollView.documentView = grid
        scrollView.setAccessibilityElement(false)
        scrollView.contentView.setAccessibilityElement(false)
        addSubview(scrollView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        var border = NSColor.clear.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance { border = NSColor(Theme.border).cgColor }
        layer?.borderColor = border
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
        grid.needsDisplay = true
    }

    /// Updates cells in place by row and column, so streamed rows keep their views, selection and focus.
    func update(rows: [[AttributedString]], alignments: [MarkdownTableAlignment], header: MessageSelectionTextView.Style,
                body: MessageSelectionTextView.Style, selection: MessageTextSelection?, block: Int) {
        let columns = rows.map(\.count).max() ?? 0
        let previousRows = cells.count
        var changed = columns != columnCount || rows.count != previousRows
        while cells.count > rows.count {
            for cell in cells.removeLast() { cell.detach() }
        }
        for (row, values) in rows.enumerated() {
            if row == cells.count { cells.append([]) }
            while cells[row].count > values.count { cells[row].removeLast().detach() }
            for (column, value) in values.enumerated() {
                let cell: MarkdownTableCellView
                if column < cells[row].count {
                    cell = cells[row][column]
                } else {
                    cell = MarkdownTableCellView(table: self)
                    grid.addSubview(cell)
                    cells[row].append(cell)
                    changed = true
                }
                cell.row = row
                cell.column = column
                let alignment = column < alignments.count ? alignments[column] : .none
                if cell.update(text: value, style: row == 0 ? header : body, alignment: alignment) { changed = true }
                cell.attach(to: selection, key: .init(block: block, item: row, column: column))
            }
        }
        columnCount = columns
        if rowElements.count > rows.count { rowElements.removeLast(rowElements.count - rows.count) }
        while rowElements.count < rows.count { rowElements.append(MarkdownTableRowElement(table: self, index: rowElements.count)) }
        if columnElements.count > columns { columnElements.removeLast(columnElements.count - columns) }
        while columnElements.count < columns {
            columnElements.append(MarkdownTableColumnElement(table: self, index: columnElements.count))
        }
        guard changed else { return }
        plans.removeAll(keepingCapacity: true)
        invalidateIntrinsicContentSize()
        needsLayout = true
        grid.needsDisplay = true
        if previousRows != 0, previousRows != rows.count { NSAccessibility.post(element: self, notification: .rowCountChanged) }
    }

    func unregister() {
        for row in cells { for cell in row { cell.text.selectionOwner?.unregister(cell.text) } }
    }

    /// The size SwiftUI places: the table's own width when it fits, otherwise all of `width`.
    func size(forWidth width: CGFloat) -> CGSize {
        let plan = plan(for: width)
        return CGSize(width: min(width, plan.content.width + Self.rule * 2),
                      height: plan.content.height + Self.rule * 2 + plan.scrollerHeight)
    }

    func plan(for width: CGFloat) -> Plan {
        if let cached = plans.first(where: { $0.width == width }) { return cached }
        var ideal = Array(repeating: CGFloat(0), count: columnCount)
        for row in cells {
            for cell in row where cell.column < columnCount { ideal[cell.column] = max(ideal[cell.column], cell.naturalWidth) }
        }
        ideal = ideal.map { min(Self.maximumColumnWidth, max(1, $0)) }
        // The last column has no rule after it, but the outer border adds one on each side.
        let columns = MarkdownTableColumns(ideal: ideal, available: width - Self.rule, spacing: Self.columnSpacing,
                                           minimum: Self.minimumColumnWidth, overflowMaximum: Self.overflowColumnWidth)
        let heights = cells.map { row in
            row.reduce(CGFloat(0)) { height, cell in
                cell.column < columns.widths.count ? max(height, cell.height(forWidth: columns.widths[cell.column])) : height
            } + Self.padding.height * 2
        }
        let content = CGSize(width: max(0, columns.contentWidth(spacing: Self.columnSpacing) - Self.rule),
                             height: heights.reduce(0, +) + Self.rule * CGFloat(max(0, heights.count - 1)))
        let legacy = columns.overflows && NSScroller.preferredScrollerStyle == .legacy
        let plan = Plan(width: width, columns: columns, rowHeights: heights, content: content,
                        scrollerHeight: legacy ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) : 0)
        if plans.count >= 4 { plans.removeFirst() }
        plans.append(plan)
        return plan
    }

    override func layout() {
        super.layout()
        let plan = plan(for: bounds.width)
        scrollView.frame = bounds.insetBy(dx: Self.rule, dy: Self.rule)
        grid.frame = NSRect(origin: .zero, size: plan.content)
        var y: CGFloat = 0
        let columnWidths = plan.columns.widths.map { $0 + Self.padding.width * 2 }
        for (row, height) in zip(cells, plan.rowHeights) {
            var x: CGFloat = 0
            for cell in row where cell.column < columnWidths.count {
                cell.frame = NSRect(x: x, y: y, width: columnWidths[cell.column], height: height)
                x += columnWidths[cell.column] + Self.rule
            }
            y += height + Self.rule
        }
        grid.columnWidths = columnWidths
        grid.rowHeights = plan.rowHeights
        grid.needsDisplay = true
        // Overlay scrollers are hidden at rest: show once that this table scrolls sideways.
        if plan.columns.overflows, !flashedOverflow, window != nil {
            flashedOverflow = true
            scrollView.flashScrollers()
        }
    }

    var overflows: Bool { plan(for: bounds.width).columns.overflows }
    /// Column plans kept for recent widths, bounded at four.
    var cachedPlanCount: Int { plans.count }

    // MARK: Accessibility: a table of rows and columns of cells, with the first row as column headers.

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .table }
    override func accessibilityChildren() -> [Any]? { rowElements + columnElements }
    override func accessibilityRows() -> [Any]? { rowElements }
    override func accessibilityVisibleRows() -> [Any]? { rowElements }
    override func accessibilityColumns() -> [Any]? { columnElements }
    override func accessibilityVisibleColumns() -> [Any]? { columnElements }
    override func accessibilityColumnHeaderUIElements() -> [Any]? { cells.first }
    override func accessibilityRowCount() -> Int { cells.count }
    override func accessibilityColumnCount() -> Int { columnCount }

    override func accessibilityCell(forColumn column: Int, row: Int) -> Any? {
        guard row >= 0, row < cells.count, column >= 0, column < cells[row].count else { return nil }
        return cells[row][column]
    }

    func rowElement(_ row: Int) -> MarkdownTableRowElement? { row < rowElements.count ? rowElements[row] : nil }
    func headerCell(_ column: Int) -> MarkdownTableCellView? {
        cells.first.flatMap { column < $0.count ? $0[column] : nil }
    }
    func cells(inRow row: Int) -> [MarkdownTableCellView] { row < cells.count ? cells[row] : [] }
    func cells(inColumn column: Int) -> [MarkdownTableCellView] { cells.compactMap { column < $0.count ? $0[column] : nil } }

    func screenFrame(of views: [NSView]) -> NSRect {
        views.map { NSAccessibility.screenRect(fromView: $0, rect: $0.bounds) }.reduce(NSRect.null) { $0.union($1) }
    }

    /// The element under a screen point among `cells`: the cell, or an element inside it.
    func hitTest(_ point: NSPoint, in cells: [MarkdownTableCellView]) -> Any? {
        guard let cell = cells.first(where: { screenFrame(of: [$0]).contains(point) }) else { return nil }
        return cell.accessibilityHitTest(point) ?? cell
    }
}

/// One cell: its padding and a message text view that wraps at the column width.
@MainActor
final class MarkdownTableCellView: NSView {
    let text = MessageSelectionTextView.makeReadOnly()
    weak var table: MarkdownTableView?
    var row = 0
    var column = 0
    private var content: AttributedString?
    private var style: MessageSelectionTextView.Style?
    private var alignment: MarkdownTableAlignment = .none
    /// The text's width on one line, measured once per content change.
    private(set) var naturalWidth: CGFloat = 0
    private var lineHeight: CGFloat = 0

    init(table: MarkdownTableView) {
        self.table = table
        super.init(frame: .zero)
        text.isTableCell = true
        addSubview(text)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }

    /// Returns whether anything that affects layout changed.
    func update(text value: AttributedString, style: MessageSelectionTextView.Style, alignment: MarkdownTableAlignment) -> Bool {
        guard value != content || style != self.style || alignment != self.alignment else { return false }
        let attributed = NSMutableAttributedString(attributedString: SelectableMessageText.attributed(value, style: style))
        if alignment != .none, attributed.length > 0 {
            attributed.enumerateAttribute(.paragraphStyle, in: NSRange(location: 0, length: attributed.length)) { current, range, _ in
                let paragraph = (current as? NSParagraphStyle)?.mutableCopy() as? NSMutableParagraphStyle ?? NSMutableParagraphStyle()
                paragraph.alignment = switch alignment {
                case .center: .center
                case .trailing: .right
                case .leading, .none: .natural
                }
                attributed.addAttribute(.paragraphStyle, value: paragraph, range: range)
            }
        }
        if let storage = text.textStorage {
            // A streamed cell mostly grows at its end; keep its laid-out start and any selection in it.
            let kept = self.style == style && self.alignment == alignment ? text.replaceChangedTail(storage, with: attributed) : nil
            if kept == nil { storage.setAttributedString(attributed) }
        }
        text.content = value
        text.style = style
        content = value
        self.style = style
        self.alignment = alignment
        naturalWidth = ceil(attributed.size().width)
        lineHeight = ceil(style.font.ascender - style.font.descender + style.font.leading)
        text.updateLinkHover(at: nil)
        text.invalidateMeasurements()
        needsLayout = true
        return true
    }

    func height(forWidth width: CGFloat) -> CGFloat {
        max(lineHeight, text.measure(width: max(1, width), unwrapped: false).height)
    }

    func attach(to selection: MessageTextSelection?, key: MessageTextSelection.Key) {
        if text.selectionOwner !== selection || text.selectionKey != key {
            text.selectionOwner?.unregister(text)
            text.clearMessageSelection()
            text.selectionOwner = selection
            text.selectionKey = key
        }
        selection?.register(text)
    }

    func detach() {
        text.selectionOwner?.unregister(text)
        text.selectionOwner = nil
        removeFromSuperview()
    }

    override func layout() {
        super.layout()
        // The text fills the cell's height, so a press or drag anywhere in a short cell lands in it.
        text.frame = bounds.insetBy(dx: MarkdownTableView.padding.width, dy: MarkdownTableView.padding.height)
    }

    override func mouseDown(with event: NSEvent) {
        text.mouseDown(with: event)
    }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .cell }
    override func accessibilityRowIndexRange() -> NSRange { NSRange(location: row, length: 1) }
    override func accessibilityColumnIndexRange() -> NSRange { NSRange(location: column, length: 1) }
    override func accessibilityParent() -> Any? { table?.rowElement(row) ?? super.accessibilityParent() }
    override func accessibilityChildren() -> [Any]? { [text] }
    override func accessibilityColumnHeaderUIElements() -> [Any]? {
        guard row > 0, let header = table?.headerCell(column) else { return nil }
        return [header]
    }
}

/// Draws the header background and the rules between rows and columns, behind the cells, so they scroll together.
@MainActor
final class MarkdownTableGridView: NSView {
    var columnWidths: [CGFloat] = []
    var rowHeights: [CGFloat] = []

    override var isFlipped: Bool { true }
    override func isAccessibilityElement() -> Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        guard let header = rowHeights.first else { return }
        let rule = MarkdownTableView.rule
        NSColor(Theme.muted).setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: header).fill(using: .sourceOver)
        NSColor(Theme.border).setFill()
        var y: CGFloat = 0
        for height in rowHeights.dropLast() {
            y += height
            NSRect(x: 0, y: y, width: bounds.width, height: rule).fill(using: .sourceOver)
            y += rule
        }
        var x: CGFloat = 0
        for width in columnWidths.dropLast() {
            x += width
            NSRect(x: x, y: 0, width: rule, height: bounds.height).fill(using: .sourceOver)
            x += rule
        }
    }
}

/// Scrolls only horizontally, and only for gestures that start sideways. Vertical wheel and trackpad scrolling,
/// including momentum, go on to the transcript, so a wide table never traps the reader's scroll.
final class MarkdownTableScrollView: NSScrollView {
    private var horizontalGesture: Bool?

    /// Whether this event belongs to horizontal scrolling of the table.
    func scrollsHorizontally(_ event: NSEvent) -> Bool {
        if event.phase.contains(.began) || event.phase.contains(.mayBegin) { horizontalGesture = nil }
        let dx = abs(event.scrollingDeltaX), dy = abs(event.scrollingDeltaY)
        guard !event.phase.isEmpty || !event.momentumPhase.isEmpty else { return dx > dy }
        if horizontalGesture == nil, dx > 0 || dy > 0 { horizontalGesture = dx > dy }
        return horizontalGesture ?? false
    }

    override func scrollWheel(with event: NSEvent) {
        let overflows = (documentView?.frame.width ?? 0) > contentView.bounds.width + 0.5
        if scrollsHorizontally(event), overflows {
            super.scrollWheel(with: event)
        } else {
            nextResponder?.scrollWheel(with: event)
        }
    }
}

/// A table row for assistive technology: its cells in column order.
final class MarkdownTableRowElement: NSAccessibilityElement {
    weak var table: MarkdownTableView?
    let index: Int

    init(table: MarkdownTableView, index: Int) {
        self.table = table
        self.index = index
        super.init()
    }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .row }
    override func accessibilityIndex() -> Int { index }
    override func accessibilityParent() -> Any? { table }
    override func accessibilityChildren() -> [Any]? { MainActor.assumeIsolated { table?.cells(inRow: index) } }
    override func accessibilityHitTest(_ point: NSPoint) -> Any? {
        let hit: Any? = MainActor.assumeIsolated { table.flatMap { $0.hitTest(point, in: $0.cells(inRow: index)) } }
        return hit ?? self
    }
    override func accessibilityFrame() -> NSRect {
        MainActor.assumeIsolated { table.map { $0.screenFrame(of: $0.cells(inRow: index)) } ?? .zero }
    }
}

/// A table column for assistive technology: its cells in row order, headed by its header cell.
final class MarkdownTableColumnElement: NSAccessibilityElement {
    weak var table: MarkdownTableView?
    let index: Int

    init(table: MarkdownTableView, index: Int) {
        self.table = table
        self.index = index
        super.init()
    }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .column }
    override func accessibilityIndex() -> Int { index }
    override func accessibilityParent() -> Any? { table }
    override func accessibilityChildren() -> [Any]? { MainActor.assumeIsolated { table?.cells(inColumn: index) } }
    override func accessibilityHitTest(_ point: NSPoint) -> Any? {
        let hit: Any? = MainActor.assumeIsolated { table.flatMap { $0.hitTest(point, in: $0.cells(inColumn: index)) } }
        return hit ?? self
    }
    override func accessibilityHeader() -> Any? { MainActor.assumeIsolated { table?.headerCell(index) } }
    override func accessibilityFrame() -> NSRect {
        MainActor.assumeIsolated { table.map { $0.screenFrame(of: $0.cells(inColumn: index)) } ?? .zero }
    }
}

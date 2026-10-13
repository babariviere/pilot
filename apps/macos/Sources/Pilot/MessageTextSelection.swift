import AppKit
import SwiftUI

/// One selection owner per Markdown message. Regions keep their existing layout (including
/// horizontally scrolling code), but dragging and Select All operate on the whole reply.
/// Only weak references to mounted regions are retained. No event monitors or polling.
@MainActor
final class MessageTextSelection: ObservableObject {
    struct Key: Hashable, Comparable {
        let block: Int
        var item: Int = 0
        static func < (lhs: Self, rhs: Self) -> Bool {
            lhs.block == rhs.block ? lhs.item < rhs.item : lhs.block < rhs.block
        }
    }
    struct Position: Comparable {
        let key: Key
        let offset: Int
        static func < (lhs: Self, rhs: Self) -> Bool {
            lhs.key == rhs.key ? lhs.offset < rhs.offset : lhs.key < rhs.key
        }
    }
    private struct Region {
        weak var view: MessageSelectionTextView?
    }
    private var regions: [Key: Region] = [:]
    private(set) var anchor: Position?
    private(set) var end: Position?
    var source = "" {
        didSet { if source != oldValue { entireMessage = false } }
    }
    private var entireMessage = false

    private var mounted: [MessageSelectionTextView] {
        regions.values.compactMap(\.view).sorted { $0.selectionKey < $1.selectionKey }
    }

    func register(_ view: MessageSelectionTextView) {
        regions[view.selectionKey] = Region(view: view)
        apply(to: view)
    }

    func unregister(_ view: MessageSelectionTextView) {
        if regions[view.selectionKey]?.view === view { regions[view.selectionKey] = nil }
    }

    func select(from start: Position, to finish: Position) {
        entireMessage = false
        anchor = start
        end = finish
        for view in mounted { apply(to: view) }
    }

    func clear() {
        entireMessage = false
        anchor = nil
        end = nil
        for view in mounted { view.setSelectedRange(NSRange(location: 0, length: 0)) }
    }

    func selectAll() {
        guard let first = mounted.first, let last = mounted.last else { return }
        select(from: Position(key: first.selectionKey, offset: 0),
               to: Position(key: last.selectionKey, offset: last.string.utf16.count))
        entireMessage = true
    }

    func extend(toWindowPoint point: NSPoint) {
        guard let anchor else { return }
        // Use the nearest text region in vertical gaps, such as code headers and rules.
        let views = mounted.filter { $0.window != nil }
        guard let view = views.min(by: { distance(point, to: $0) < distance(point, to: $1) }) else { return }
        select(from: anchor, to: Position(key: view.selectionKey, offset: view.insertionIndex(atWindowPoint: point)))
    }

    private func distance(_ point: NSPoint, to view: NSView) -> CGFloat {
        let rect = view.convert(view.bounds, to: nil)
        return max(rect.minY - point.y, point.y - rect.maxY, 0)
    }

    private func apply(to view: MessageSelectionTextView) {
        let count = view.string.utf16.count
        guard let anchor, let end else { return }
        let lower = min(anchor, end), upper = max(anchor, end)
        let key = view.selectionKey
        guard key >= lower.key && key <= upper.key else {
            view.setSelectedRange(NSRange(location: 0, length: 0))
            return
        }
        let start = key == lower.key ? min(lower.offset, count) : 0
        let finish = key == upper.key ? min(upper.offset, count) : count
        view.setSelectedRange(NSRange(location: start, length: max(0, finish - start)))
    }

    var selectedText: String {
        // Like the existing "Copy full message", Select All preserves the original Markdown,
        // including diagram source and block delimiters not represented by text regions.
        if entireMessage { return source }
        var result = ""
        var previous: Key?
        for view in mounted {
            let range = view.selectedRange()
            guard range.length > 0 else { continue }
            if let previous { result += previous.block == view.selectionKey.block ? "\n" : "\n\n" }
            if range.location == 0 { result += view.copyPrefix }
            result += (view.string as NSString).substring(with: range)
            previous = view.selectionKey
        }
        return result
    }
}

private struct MessageTextSelectionKey: EnvironmentKey {
    static let defaultValue: MessageTextSelection? = nil
}
private struct MessageSelectionBlockKey: EnvironmentKey {
    static let defaultValue = 0
}
private struct MessageSelectionColorKey: EnvironmentKey {
    static let defaultValue = NSColor.labelColor
}
extension EnvironmentValues {
    var messageTextSelection: MessageTextSelection? {
        get { self[MessageTextSelectionKey.self] }
        set { self[MessageTextSelectionKey.self] = newValue }
    }
    var messageSelectionBlock: Int {
        get { self[MessageSelectionBlockKey.self] }
        set { self[MessageSelectionBlockKey.self] = newValue }
    }
    var messageSelectionColor: NSColor {
        get { self[MessageSelectionColorKey.self] }
        set { self[MessageSelectionColorKey.self] = newValue }
    }
}

/// Native read-only text with the same inline styles as the SwiftUI Markdown renderer.
/// TextKit layout is cached until content or width changes, including repeated sizing probes.
struct SelectableMessageText: NSViewRepresentable {
    let text: AttributedString
    let font: NSFont
    let monoFont: NSFont
    var color: NSColor? = nil
    var lineSpacing: CGFloat = 3
    var item = 0
    var unwrapped = false
    var copyPrefix = ""
    @Environment(\.messageTextSelection) private var selection
    @Environment(\.messageSelectionBlock) private var block
    @Environment(\.messageSelectionColor) private var defaultColor

    func makeNSView(context: Context) -> MessageSelectionTextView {
        let view = MessageSelectionTextView()
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = false
        view.textContainer?.heightTracksTextView = false
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: MessageSelectionTextView, context: Context) {
        let key = MessageTextSelection.Key(block: block, item: item)
        view.copyPrefix = copyPrefix
        if view.selectionOwner !== selection || view.selectionKey != key {
            view.selectionOwner?.unregister(view)
            view.selectionOwner = selection
            view.selectionKey = key
        }
        let style = MessageSelectionTextView.Style(font: font, mono: monoFont, color: color ?? defaultColor, spacing: lineSpacing)
        if view.content != text || view.style != style {
            view.content = text
            view.style = style
            view.textStorage?.setAttributedString(Self.attributed(text, style: style))
            view.measuredWidth = nil
            view.invalidateIntrinsicContentSize()
        }
        selection?.register(view)
    }

    static func dismantleNSView(_ view: MessageSelectionTextView, coordinator: ()) {
        view.selectionOwner?.unregister(view)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: MessageSelectionTextView, context: Context) -> CGSize? {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? Theme.column
        return view.measure(width: unwrapped ? 1_000_000 : max(1, width), unwrapped: unwrapped)
    }

    static func attributed(_ text: AttributedString, style: MessageSelectionTextView.Style) -> NSAttributedString {
        let result = NSMutableAttributedString(string: "")
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = style.spacing
        for run in text.runs {
            let intent = run.inlinePresentationIntent ?? []
            var font = intent.contains(.code) ? style.mono : style.font
            if intent.contains(.stronglyEmphasized) { font = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) }
            if intent.contains(.emphasized) { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font, .foregroundColor: run.foregroundColor.map { NSColor($0) } ?? style.color,
                .paragraphStyle: paragraph,
            ]
            if let link = run.link { attributes[.link] = link }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            result.append(NSAttributedString(string: String(text[run.range].characters), attributes: attributes))
        }
        return result
    }
}

@MainActor
final class MessageSelectionTextView: NSTextView {
    struct Style: Equatable {
        let font: NSFont
        let mono: NSFont
        let color: NSColor
        let spacing: CGFloat
    }
    weak var selectionOwner: MessageTextSelection?
    var selectionKey = MessageTextSelection.Key(block: 0)
    var content: AttributedString?
    var style: Style?
    var copyPrefix = ""
    var measuredWidth: CGFloat?
    private var measuredSize = CGSize.zero

    func measure(width: CGFloat, unwrapped: Bool) -> CGSize {
        if measuredWidth == width { return measuredSize }
        guard let container = textContainer, let layout = layoutManager else { return .zero }
        container.size = CGSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container)
        measuredWidth = width
        measuredSize = CGSize(width: unwrapped ? ceil(used.width) : width, height: ceil(used.height))
        return measuredSize
    }

    func insertionIndex(atWindowPoint point: NSPoint) -> Int {
        let local = convert(point, from: nil)
        if local.y < bounds.minY { return 0 }
        if local.y > bounds.maxY { return string.utf16.count }
        return min(string.utf16.count, characterIndexForInsertion(at: local))
    }

    override func mouseDown(with event: NSEvent) {
        guard let selectionOwner, let window else { super.mouseDown(with: event); return }
        let index = insertionIndex(atWindowPoint: event.locationInWindow)
        // AppKit retains native word/paragraph selection, link activation and context menus.
        if event.clickCount > 1 || (index < string.utf16.count && textStorage?.attribute(.link, at: index, effectiveRange: nil) != nil) {
            selectionOwner.clear()
            super.mouseDown(with: event)
            let range = selectedRange()
            selectionOwner.select(from: .init(key: selectionKey, offset: range.location),
                                  to: .init(key: selectionKey, offset: NSMaxRange(range)))
            return
        }
        window.makeFirstResponder(self)
        let start = event.modifierFlags.contains(.shift) ? selectionOwner.anchor : nil
        let position = MessageTextSelection.Position(key: selectionKey, offset: index)
        selectionOwner.select(from: start ?? position, to: position)
        // A native tracking loop, scoped to this gesture, allows selection to leave this region.
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            selectionOwner.extend(toWindowPoint: next.locationInWindow)
            if next.type == .leftMouseUp { break }
            autoscroll(with: next)
        }
    }

    override func selectAll(_ sender: Any?) {
        if let selectionOwner { selectionOwner.selectAll() } else { super.selectAll(sender) }
    }

    override func copy(_ sender: Any?) {
        guard let selectionOwner else { super.copy(sender); return }
        copySelection(selectionOwner.selectedText, to: .general)
    }

    func copySelection(_ selected: String, to pasteboard: NSPasteboard) {
        guard !selected.isEmpty else { return }
        pasteboard.clearContents()
        pasteboard.setString(selected, forType: .string)
    }

    private func selectionShortcut(_ event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection([.command, .shift, .control, .option]) == .command else { return false }
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "a": selectAll(nil); return true
        case "c": copy(nil); return true
        default: return false
        }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        selectionShortcut(event) || super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if selectionShortcut(event) { return }
        let previousRange = selectedRange()
        selectionOwner?.clear()
        setSelectedRange(previousRange)
        super.keyDown(with: event)
        let range = selectedRange()
        selectionOwner?.select(from: .init(key: selectionKey, offset: range.location),
                               to: .init(key: selectionKey, offset: NSMaxRange(range)))
    }
}

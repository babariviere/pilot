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
    /// Window key observers exist only while this message has a selection, so every region repaints
    /// together when the window gains or loses focus.
    private var focusObservers: [NSObjectProtocol] = []

    deinit {
        for observer in focusObservers { NotificationCenter.default.removeObserver(observer) }
    }

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
        observeFocus(start != finish)
    }

    func clear() {
        entireMessage = false
        anchor = nil
        end = nil
        for view in mounted { view.setSelectedRange(NSRange(location: 0, length: 0)) }
        observeFocus(false)
    }

    /// One message is one selection, so its regions share one highlight color. AppKit would draw
    /// the first responder's range as active and every other region as inactive.
    var isActive: Bool {
        regions.values.contains { region in
            guard let view = region.view, let window = view.window else { return false }
            return window.isKeyWindow && window.firstResponder === view
        }
    }

    func focusChanged() {
        for region in regions.values {
            guard let view = region.view, view.selectedRange().length > 0 else { continue }
            view.needsDisplay = true
        }
    }

    private func observeFocus(_ enabled: Bool) {
        guard enabled == focusObservers.isEmpty else { return }
        guard enabled else {
            for observer in focusObservers { NotificationCenter.default.removeObserver(observer) }
            focusObservers = []
            return
        }
        focusObservers = [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.focusChanged() }
            }
        }
    }

    func selectAll() {
        guard let first = mounted.first, let last = mounted.last else { return }
        select(from: Position(key: first.selectionKey, offset: 0),
               to: Position(key: last.selectionKey, offset: last.string.utf16.count))
        entireMessage = true
    }

    var hasSelection: Bool {
        if entireMessage { return !source.isEmpty }
        guard let anchor, let end else { return false }
        return anchor != end
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
            if let storage = view.textStorage {
                result += MessageServiceLinks.copiedText(storage, range: range)
            }
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
    var hugsContent = false
    var copyPrefix = ""
    @Environment(\.messageTextSelection) private var selection
    @Environment(\.messageSelectionBlock) private var block
    @Environment(\.messageSelectionColor) private var defaultColor

    func makeNSView(context: Context) -> MessageSelectionTextView {
        let view = MessageSelectionTextView.make()
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.selectedTextAttributes = [.backgroundColor: NSColor.selectedTextBackgroundColor]
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
        view.unwrapped = unwrapped
        if view.selectionOwner !== selection || view.selectionKey != key {
            view.selectionOwner?.unregister(view)
            view.selectionOwner = selection
            view.selectionKey = key
        }
        let style = MessageSelectionTextView.Style(font: font, mono: monoFont, color: color ?? defaultColor, spacing: lineSpacing)
        if view.content != text || view.style != style {
            view.content = text
            view.style = style
            view.updateLinkHover(at: nil)
            view.textStorage?.setAttributedString(Self.attributed(text, style: style))
            view.invalidateMeasurements()
            view.invalidateIntrinsicContentSize()
        }
        selection?.register(view)
    }

    static func dismantleNSView(_ view: MessageSelectionTextView, coordinator: ()) {
        view.selectionOwner?.unregister(view)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: MessageSelectionTextView, context: Context) -> CGSize? {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? Theme.column
        return view.measure(width: unwrapped ? 1_000_000 : max(1, width), unwrapped: unwrapped, hugsContent: hugsContent)
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
            if let link = run.link {
                attributes[.link] = link
            }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            result.append(NSAttributedString(string: String(text[run.range].characters), attributes: attributes))
        }
        MessageServiceLinks.decorate(result, font: style.font)
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
    var unwrapped = false
    private var measuring = false
    /// Sizes for the few widths SwiftUI probes per layout pass, so alternating probes do not relayout.
    private var measurements: [(width: CGFloat, hugsContent: Bool, size: CGSize)] = []
    /// The text view does not own a TextKit 1 stack it was given, so it retains the root here.
    private var ownedStorage: NSTextStorage?
    private var linkTrackingArea: NSTrackingArea?
    private(set) var hoveredLinkRange: NSRange?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let linkTrackingArea { removeTrackingArea(linkTrackingArea) }
        let area = NSTrackingArea(rect: .zero,
            options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
            owner: self, userInfo: nil)
        addTrackingArea(area)
        linkTrackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        updateLinkHover(at: convert(event.locationInWindow, from: nil))
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        updateLinkHover(at: convert(event.locationInWindow, from: nil))
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        updateLinkHover(at: nil)
    }

    /// Hit-test actual glyphs, not the nearest insertion point in trailing whitespace. Hover only
    /// invalidates drawing when the link changes; it never edits storage or invalidates layout.
    func updateLinkHover(at point: NSPoint?) {
        let range = point.flatMap { linkRange(at: $0) }
        guard range != hoveredLinkRange else { return }
        hoveredLinkRange = range
        needsDisplay = true
    }

    private func linkRange(at point: NSPoint) -> NSRange? {
        guard visibleRect.contains(point), let layout = layoutManager, let container = textContainer,
              let storage = textStorage, storage.length > 0 else { return nil }
        let local = NSPoint(x: point.x - textContainerOrigin.x, y: point.y - textContainerOrigin.y)
        let glyph = layout.glyphIndex(for: local, in: container)
        guard glyph < layout.numberOfGlyphs,
              layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container).contains(local)
        else { return nil }
        let index = layout.characterIndexForGlyph(at: glyph)
        var range = NSRange()
        guard storage.attribute(.link, at: index, longestEffectiveRange: &range,
                                in: NSRange(location: 0, length: storage.length)) != nil else { return nil }
        return range
    }

    /// A TextKit 1 stack whose layout manager draws the message's shared selection highlight.
    static func make() -> MessageSelectionTextView {
        let storage = NSTextStorage()
        let layout = MessageSelectionLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: .zero)
        layout.addTextContainer(container)
        let view = MessageSelectionTextView(frame: .zero, textContainer: container)
        view.ownedStorage = storage
        view.linkTextAttributes = MessageServiceLinks.linkTextAttributes
        return view
    }

    func invalidateMeasurements() {
        measurements.removeAll(keepingCapacity: true)
    }

    func measure(width: CGFloat, unwrapped: Bool, hugsContent: Bool = false) -> CGSize {
        if let cached = measurements.first(where: { $0.width == width && $0.hugsContent == hugsContent }) { return cached.size }
        guard let container = textContainer, let layout = layoutManager else { return .zero }
        // Resizable text views can resize themselves during layout. Keep the probe width meanwhile.
        measuring = true
        container.size = CGSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container)
        measuring = false
        let size = CGSize(width: unwrapped || hugsContent ? ceil(used.width) : width, height: ceil(used.height))
        if measurements.count >= 4 { measurements.removeFirst() }
        measurements.append((width, hugsContent, size))
        // A sizing probe must not change how the placed text wraps. Otherwise the drawn text
        // follows whichever width SwiftUI probed last and reflows on every streamed update.
        if !unwrapped, frame.width > 0, frame.width != width { matchContainerToFrame() }
        return size
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        if !unwrapped, !measuring { matchContainerToFrame() }
    }

    private func matchContainerToFrame() {
        guard let container = textContainer, container.size.width != frame.width else { return }
        container.size = CGSize(width: frame.width, height: .greatestFiniteMagnitude)
    }

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { selectionOwner?.focusChanged() }
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { selectionOwner?.focusChanged() }
        return accepted
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

    override func clicked(onLink link: Any, at charIndex: Int) {
        let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:))
        if let url, BrowserLinkOpener.handles(url) {
            BrowserLinkOpener.shared.open(url)
        } else {
            super.clicked(onLink: link, at: charIndex)
        }
    }

    override func copy(_ sender: Any?) {
        guard let selectionOwner else {
            if let storage = textStorage {
                copySelection(MessageServiceLinks.copiedText(storage, range: selectedRange()), to: .general)
            }
            return
        }
        copySelection(selectionOwner.selectedText, to: .general)
    }

    override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        // A drag can start at the end of this block and select only later blocks. AppKit's
        // local range is then empty, but Edit > Copy must still enable the shared selection.
        if menuItem.action == #selector(copy(_:)), let selectionOwner {
            return selectionOwner.hasSelection
        }
        return super.validateMenuItem(menuItem)
    }

    override var writablePasteboardTypes: [NSPasteboard.PasteboardType] {
        selectionOwner == nil ? super.writablePasteboardTypes : [.string]
    }

    // AppKit's Copy Link requests these directly, independently of writablePasteboardTypes.
    // Keep its URL and title representations, including the legacy format that supplies plain
    // text to other apps. Ordinary Copy still exports only the shared message selection.
    private static let linkPasteboardTypes: Set<NSPasteboard.PasteboardType> = [
        .URL, .init("public.url-name"), .init("WebURLsWithTitlesPboardType"),
        .init("Apple URL pasteboard type"), .init("NSLinkStringPboardType"),
    ]

    override func writeSelection(to pasteboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        guard let selectionOwner else {
            if type == .string, let storage = textStorage {
                let selected = MessageServiceLinks.copiedText(storage, range: selectedRange())
                return !selected.isEmpty && pasteboard.setString(selected, forType: .string)
            }
            return super.writeSelection(to: pasteboard, type: type)
        }
        if Self.linkPasteboardTypes.contains(type) { return super.writeSelection(to: pasteboard, type: type) }
        guard type == .string else { return false }
        let selected = selectionOwner.selectedText
        guard !selected.isEmpty else { return false }
        return pasteboard.setString(selected, forType: .string)
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
        // AppKit offers key equivalents to every view in the window, so only claim them while focused.
        // Otherwise a mounted message would take Command-A and Command-C from the composer.
        (window?.firstResponder === self && selectionShortcut(event)) || super.performKeyEquivalent(with: event)
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

/// Paints every selected region of a message in the same color: active while any of its regions
/// is focused in the key window, inactive otherwise.
final class MessageSelectionLayoutManager: NSLayoutManager {
    @MainActor func linkUnderlineColor(at index: Int) -> NSColor {
        if let view = firstTextView as? MessageSelectionTextView,
           let range = view.hoveredLinkRange, NSLocationInRange(index, range) {
            return NSColor(Theme.foreground)
        }
        return NSColor(Theme.LinkUnderline.ink)
    }

    /// TextKit supplies wrapped/bidirectional title fragments. Keep their exact horizontal bounds
    /// and move only the underline, without changing font metrics, selection or line layout.
    override func drawUnderline(forGlyphRange glyphRange: NSRange, underlineType underlineVal: NSUnderlineStyle,
                                baselineOffset: CGFloat, lineFragmentRect lineRect: NSRect,
                                lineFragmentGlyphRange lineGlyphRange: NSRange, containerOrigin: NSPoint) {
        guard glyphRange.length > 0, let storage = textStorage,
              storage.attribute(.link, at: characterIndexForGlyph(at: glyphRange.location), effectiveRange: nil) != nil,
              let container = textContainer(forGlyphAt: glyphRange.location, effectiveRange: nil) else {
            super.drawUnderline(forGlyphRange: glyphRange, underlineType: underlineVal, baselineOffset: baselineOffset,
                                lineFragmentRect: lineRect, lineFragmentGlyphRange: lineGlyphRange,
                                containerOrigin: containerOrigin)
            return
        }
        MainActor.assumeIsolated {
            NSGraphicsContext.saveGraphicsState()
            defer { NSGraphicsContext.restoreGraphicsState() }
            linkUnderlineColor(at: characterIndexForGlyph(at: glyphRange.location)).setFill()
            let baseline = lineRect.minY + location(forGlyphAt: glyphRange.location).y
            enumerateEnclosingRects(forGlyphRange: glyphRange, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
                                    in: container) { rect, _ in
                Self.linkUnderlineRect(enclosing: rect, baseline: baseline, origin: containerOrigin).fill()
            }
        }
    }

    static func linkUnderlineRect(enclosing rect: NSRect, baseline: CGFloat, origin: NSPoint) -> NSRect {
        NSRect(x: origin.x + rect.minX, y: origin.y + baseline + Theme.LinkUnderline.baselineOffset,
               width: rect.width, height: Theme.LinkUnderline.thickness)
    }

    override func fillBackgroundRectArray(_ rectArray: UnsafePointer<NSRect>, count rectCount: Int,
                                          forCharacterRange charRange: NSRange, color: NSColor) {
        // Text views draw on the main thread. Background attributes keep AppKit's color.
        let active: Bool? = MainActor.assumeIsolated {
            guard let view = firstTextView as? MessageSelectionTextView, let owner = view.selectionOwner,
                  NSIntersectionRange(view.selectedRange(), charRange).length > 0 else { return nil }
            return owner.isActive
        }
        guard let active else {
            super.fillBackgroundRectArray(rectArray, count: rectCount, forCharacterRange: charRange, color: color)
            return
        }
        let shared: NSColor = active ? .selectedTextBackgroundColor : .unemphasizedSelectedTextBackgroundColor
        shared.setFill()
        super.fillBackgroundRectArray(rectArray, count: rectCount, forCharacterRange: charRange, color: shared)
    }
}

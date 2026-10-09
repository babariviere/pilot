import AppKit
import PilotCore
import SwiftUI

@MainActor
final class TranscriptScrollState: ObservableObject {
    @Published var follow = TranscriptScrollFollow()
    private var renderedScroll: Task<Void, Never>?
    /// Set by the native observer, so an expanding row keeps its own top edge in place.
    var onMessageToggled: (() -> Void)?
    lazy var messageToggled: () -> Void = { [weak self] in
        self?.follow.pauseFollowing()
        self?.onMessageToggled?()
    }

    /// Several visible Markdown/code rows can finish together. Scroll once, after publication/layout.
    func contentPrepared(_ action: @escaping () -> Void) {
        guard renderedScroll == nil else { return }
        renderedScroll = Task { @MainActor in
            await Task.yield()
            guard !Task.isCancelled else { return }
            if follow.shouldScrollToBottom { action() }
            renderedScroll = nil
        }
    }

    func cancelPreparedScroll() {
        renderedScroll?.cancel()
        renderedScroll = nil
    }
}

/// Observe native user scrolling, rather than content geometry, which also changes
/// when the agent streams output. Live-scroll notifications cover trackpad gestures,
/// scrollbar dragging, and legacy mouse wheels on macOS 14.
/// Follow native layout too: a SwiftUI scroll request can resolve before lazy history
/// has its final geometry when a session opens or its viewport changes size.
///
/// While the reader is away from the bottom, keep a visible row fixed on screen (scroll
/// anchoring). Lazy rows above the viewport are realized with estimated heights, and inline
/// artifacts grow once measured; neither may move what the reader is looking at.
struct TranscriptScrollObserver: NSViewRepresentable {
    let state: TranscriptScrollState
    var bottomPadding: CGFloat = 0

    func makeNSView(context: Context) -> ScrollObserverView {
        let view = ScrollObserverView()
        view.state = state
        view.bottomPadding = bottomPadding
        return view
    }

    func updateNSView(_ view: ScrollObserverView, context: Context) {
        view.state = state
        view.bottomPadding = bottomPadding
    }

    static func dismantleNSView(_ view: ScrollObserverView, coordinator: ()) {
        view.stopObserving()
    }
}

final class ScrollObserverView: NSView {
    weak var state: TranscriptScrollState? {
        didSet {
            guard state !== oldValue else { return }
            oldValue?.onMessageToggled = nil
            state?.onMessageToggled = { [weak self] in self?.captureAnchor(containing: true) }
        }
    }
    var bottomPadding: CGFloat = 0
    private weak var scrollView: NSScrollView?
    private var layoutScroll: DispatchWorkItem?
    private var anchorSettle: DispatchWorkItem?
    /// Visible rows when last settled, in order, each with the edge that must stay put on screen.
    private var anchors: [RowAnchor] = []
    private var anchorViewportTop: CGFloat = 0
    private var restoringAnchor = false

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observeScrollView()
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        observeScrollView()
    }

    private func observeScrollView() {
        let scroll = window == nil ? nil : enclosingScrollView
        guard scroll !== scrollView else { return }
        stopObserving()
        guard let scroll else { return }
        scrollView = scroll
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(scrollBegan), name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        center.addObserver(self, selector: #selector(scrolled), name: NSScrollView.didLiveScrollNotification, object: scroll)
        center.addObserver(self, selector: #selector(scrollEnded), name: NSScrollView.didEndLiveScrollNotification, object: scroll)
        scroll.contentView.postsFrameChangedNotifications = true
        center.addObserver(self, selector: #selector(layoutChanged), name: NSView.frameDidChangeNotification, object: scroll.contentView)
        scroll.contentView.postsBoundsChangedNotifications = true
        center.addObserver(self, selector: #selector(boundsChanged), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        if let document = scroll.documentView {
            document.postsFrameChangedNotifications = true
            center.addObserver(self, selector: #selector(layoutChanged), name: NSView.frameDidChangeNotification, object: document)
        }
        center.addObserver(self, selector: #selector(rowMoved), name: TranscriptRowAnchorView.didMove, object: nil)
        scheduleLayoutScroll()
    }

    func stopObserving() {
        NotificationCenter.default.removeObserver(self)
        layoutScroll?.cancel()
        layoutScroll = nil
        anchorSettle?.cancel()
        anchorSettle = nil
        replaceAnchors([])
        scrollView = nil
    }

    /// Restore within the layout pass that moved the rows, so a shifted frame is never drawn,
    /// and settle again once the pass is complete.
    @objc private func layoutChanged(_ notification: Notification) {
        settleAnchor(recapture: false)
        scheduleAnchorSettle()
        scheduleLayoutScroll()
    }

    /// A row can move without the document changing size, for example when one row above
    /// shrinks while another grows. Only the anchored rows matter.
    @objc private func rowMoved(_ notification: Notification) {
        guard !following, let row = notification.object as? TranscriptRowAnchorView,
              anchors.contains(where: { $0.row === row }) else { return }
        settleAnchor(recapture: false)
        scheduleAnchorSettle()
    }

    /// Keyboard and programmatic scrolls have no live-scroll notification. Settle after the
    /// layout pass, when a SwiftUI offset change and the rows it accompanies are both applied.
    @objc private func boundsChanged(_ notification: Notification) {
        guard !restoringAnchor else { return }
        scheduleAnchorSettle()
    }

    private func scheduleAnchorSettle() {
        guard anchorSettle == nil, !following else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.anchorSettle = nil
            self?.settleAnchor(recapture: true)
        }
        anchorSettle = work
        DispatchQueue.main.async(execute: work)
    }

    // MARK: Scroll anchoring

    private var following: Bool { state?.follow.shouldScrollToBottom ?? true }

    /// Distance from the document's top edge, whichever way the document is flipped.
    private func topOffset(of rect: NSRect, in document: NSView) -> CGFloat {
        document.isFlipped ? rect.minY - document.bounds.minY : document.bounds.maxY - rect.maxY
    }

    private func viewportTop(_ scroll: NSScrollView, _ document: NSView) -> CGFloat {
        topOffset(of: scroll.contentView.bounds, in: document)
    }

    private func rowFrame(_ row: TranscriptRowAnchorView, in document: NSView) -> (top: CGFloat, bottom: CGFloat)? {
        guard row.window != nil, row.enclosingScrollView === scrollView, !row.isHiddenOrHasHiddenAncestor else { return nil }
        let rect = row.convert(row.bounds, to: document)
        let top = topOffset(of: rect, in: document)
        return (top, top + rect.height)
    }

    private struct RowAnchor {
        weak var row: TranscriptRowAnchorView?
        /// Lazy stacks may reuse a platform view for another row.
        let id: String
        /// Track the bottom edge, rather than the top, of a row that starts above the viewport.
        let bottom: Bool
        var edge: CGFloat
    }

    private func edge(of anchor: RowAnchor, in document: NSView) -> CGFloat? {
        guard let row = anchor.row, row.rowID == anchor.id, let frame = rowFrame(row, in: document) else { return nil }
        return anchor.bottom ? frame.bottom : frame.top
    }

    /// Remember every realized row in the viewport. A row straddling the top edge (typically an
    /// artifact still being measured) is anchored by its bottom, so it grows upward, out of view,
    /// and the rows below it do not move. Later rows are fallbacks, should the first leave the
    /// window. After an explicit expansion, the straddling row keeps its top, so it expands downward.
    func captureAnchor(containing: Bool = false) {
        guard let scroll = scrollView, let document = scroll.documentView else { return }
        let top = viewportTop(scroll, document)
        let bottom = top + scroll.contentView.bounds.height
        replaceAnchors(TranscriptRowAnchorView.rows.allObjects.compactMap { row -> (TranscriptRowAnchorView, top: CGFloat, bottom: CGFloat)? in
            guard let frame = rowFrame(row, in: document), frame.bottom > top, frame.top < bottom else { return nil }
            return (row, frame.top, frame.bottom)
        }
        .sorted { $0.top < $1.top }
        .map { row, rowTop, rowBottom in
            let straddling = rowTop < top && !containing
            return RowAnchor(row: row, id: row.rowID, bottom: straddling, edge: straddling ? rowBottom : rowTop)
        })
        anchorViewportTop = top
    }

    /// Only anchored rows report their moves, so streaming layout does not post per-row notifications.
    private func replaceAnchors(_ new: [RowAnchor]) {
        for anchor in anchors { anchor.row?.isAnchored = false }
        anchors = new
        for anchor in anchors { anchor.row?.isAnchored = true }
    }

    /// Distinguish a scroll (the anchor stayed put in the document) from a layout change
    /// (the anchor moved), and undo only the latter. Absolute targets make this idempotent,
    /// including when SwiftUI already corrected the offset itself.
    private func settleAnchor(recapture: Bool) {
        // While following, the bottom is pinned instead. Leaving it always starts with a user
        // scroll or an explicit expansion, both of which capture a fresh anchor.
        guard !restoringAnchor, !following, let scroll = scrollView, let document = scroll.documentView else { return }
        guard let index = anchors.firstIndex(where: { edge(of: $0, in: document) != nil }),
              let moved = edge(of: anchors[index], in: document) else {
            if recapture { captureAnchor() }
            return
        }
        // Nothing moved under the reader: once the pass is complete, remember any keyboard or
        // programmatic scroll. Within the pass, rows may not have been placed yet.
        guard abs(moved - anchors[index].edge) > 0.5 else {
            if recapture { captureAnchor() }
            return
        }
        let current = viewportTop(scroll, document)
        let target = moved - (anchors[index].edge - anchorViewportTop)
        guard abs(target - current) > 0.5 else {
            captureAnchor()
            return
        }
        scrollViewport(to: target)
        captureAnchor()
    }

    /// SwiftUI can realize lazy rows synchronously while the clip view scrolls, before the live-scroll
    /// notification. The user's scroll moves the viewport, never the rows; keep any row shift out of it.
    private func compensateDuringScroll() {
        guard !following, let scroll = scrollView, let document = scroll.documentView,
              let index = anchors.firstIndex(where: { edge(of: $0, in: document) != nil }),
              let moved = edge(of: anchors[index], in: document) else { return }
        let shift = moved - anchors[index].edge
        guard abs(shift) > 0.5 else { return }
        scrollViewport(to: viewportTop(scroll, document) + shift)
    }

    private func scrollViewport(to target: CGFloat) {
        guard let scroll = scrollView, let document = scroll.documentView else { return }
        let visible = scroll.contentView.bounds
        let maximum = max(0, document.bounds.height - visible.height + scroll.contentInsets.bottom)
        let clamped = min(maximum, max(-scroll.contentInsets.top, target))
        let y = document.isFlipped ? document.bounds.minY + clamped : document.bounds.maxY - clamped - visible.height
        guard abs(y - visible.minY) > 0.5 else { return }
        restoringAnchor = true
        scroll.contentView.scroll(to: NSPoint(x: visible.minX, y: y))
        scroll.reflectScrolledClipView(scroll.contentView)
        restoringAnchor = false
    }

    /// Coalesce notifications and wait until AppKit has applied this layout pass. More
    /// lazy rows may then be realized, producing another pass, rather than a timed retry.
    private func scheduleLayoutScroll() {
        guard layoutScroll == nil, state?.follow.shouldScrollToBottom == true else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.layoutScroll = nil
            guard self.state?.follow.shouldScrollToBottom == true,
                  let scroll = self.scrollView, let document = scroll.documentView else { return }
            let visible = scroll.contentView.bounds
            let y = document.isFlipped
                ? max(document.bounds.minY - scroll.contentInsets.top,
                      document.bounds.maxY - visible.height + scroll.contentInsets.bottom - self.bottomPadding)
                : min(document.bounds.maxY - visible.height + scroll.contentInsets.top,
                      document.bounds.minY - scroll.contentInsets.bottom + self.bottomPadding)
            guard abs(visible.minY - y) > 0.5 else { return }
            scroll.contentView.scroll(to: NSPoint(x: visible.minX, y: y))
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        layoutScroll = work
        DispatchQueue.main.async(execute: work)
    }

    private var distanceToBottom: Double {
        guard let scrollView, let document = scrollView.documentView else { return .infinity }
        let visible = scrollView.contentView.bounds
        // SwiftUI keeps the composer over the clip view via safeAreaInset. Its
        // content inset must be excluded from the unobscured viewport bottom.
        let distance = document.isFlipped
            ? document.bounds.maxY - visible.maxY
            : visible.minY - document.bounds.minY
        // scrollTo targets the bottom marker, just above the transcript's padding.
        return Double(max(0, distance + scrollView.contentInsets.bottom - bottomPadding))
    }

    @objc private func scrollBegan(_ notification: Notification) {
        state?.follow.beginUserScroll()
        captureAnchor()
    }

    @objc private func scrolled(_ notification: Notification) {
        state?.follow.userScrolled(distanceToBottom: distanceToBottom)
        compensateDuringScroll()
        captureAnchor()
    }

    @objc private func scrollEnded(_ notification: Notification) {
        state?.follow.endUserScroll(distanceToBottom: distanceToBottom)
        captureAnchor()
    }
}

/// A zero-cost marker behind each transcript row, giving the native observer row geometry
/// without SwiftUI preferences or geometry readers re-evaluating on every scroll frame.
struct TranscriptRowAnchor: NSViewRepresentable {
    let id: String

    func makeNSView(context: Context) -> TranscriptRowAnchorView {
        let view = TranscriptRowAnchorView()
        view.rowID = id
        return view
    }

    func updateNSView(_ view: TranscriptRowAnchorView, context: Context) { view.rowID = id }
}

final class TranscriptRowAnchorView: NSView {
    /// Posted when SwiftUI moves the row, which it does by moving this view's host.
    static let didMove = Notification.Name("TranscriptRowAnchorViewDidMove")
    /// Realized rows only; lazy rows that leave the screen are removed from their window.
    static let rows = NSHashTable<TranscriptRowAnchorView>.weakObjects()
    var rowID = ""
    var isAnchored = false
    private weak var host: NSView?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { Self.rows.remove(self) } else { Self.rows.add(self) }
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        let center = NotificationCenter.default
        if let host { center.removeObserver(self, name: NSView.frameDidChangeNotification, object: host) }
        host = superview
        guard let superview else { return }
        superview.postsFrameChangedNotifications = true
        center.addObserver(self, selector: #selector(hostMoved), name: NSView.frameDidChangeNotification, object: superview)
    }

    @objc private func hostMoved(_ notification: Notification) {
        guard isAnchored, window != nil else { return }
        NotificationCenter.default.post(name: Self.didMove, object: self)
    }
}

import AppKit
import PilotCore
import SwiftUI

@MainActor
final class TranscriptScrollState: ObservableObject {
    /// Not published: live scrolling changes this on every frame, and the transcript only reads it
    /// when deciding whether to scroll, so publishing would re-evaluate the whole chat per frame.
    var follow = TranscriptScrollFollow()
    private var renderedScroll: Task<Void, Never>?
    /// Set by the native observer, so an expanding row keeps its own top edge in place.
    var onMessageToggled: (() -> Void)?
    /// Set by the native observer: scrolls to the document's real bottom after the current layout pass.
    /// SwiftUI's scrollTo can target an estimated position in the lazy history instead, thousands of points
    /// away, so following never uses it while content streams.
    var pinBottom: (() -> Void)?
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
            oldValue?.pinBottom = nil
            state?.onMessageToggled = { [weak self] in self?.captureAnchor(containing: true) }
            state?.pinBottom = { [weak self] in self?.scheduleLayoutScroll() }
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
        lastLayoutChange = CACurrentMediaTime()
        settleAnchor(recapture: false)
        scheduleAnchorSettle()
        scheduleLayoutScroll()
    }

    /// When the document or viewport last changed size: while content streams, every frame or so.
    private var lastLayoutChange: CFTimeInterval = 0
    private var recentlyGrew: Bool { CACurrentMediaTime() - lastLayoutChange < 0.5 }

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
        // SwiftUI's scroll view sometimes restores an offset it recorded before the native pins, during its own
        // layout, thousands of points above the streaming reply's end. While following, undo that within the
        // same pass, so the frame is never drawn. Only while the document is changing size: keyboard scrolling
        // has no live-scroll notification either, and stays free to leave the bottom of an idle chat.
        if following, recentlyGrew, let scroll = scrollView {
            let away = scroll.contentView.bounds.origin
            pinBottomNow()
            // A legacy mouse wheel scrolls without a live-scroll session: its didLiveScroll notification follows
            // in the same call, and returns the viewport to where the reader put it (see scrolled).
            undoablePin = away
            DispatchQueue.main.async { [weak self] in self?.undoablePin = nil }
            return
        }
        scheduleAnchorSettle()
    }

    /// Where the viewport was before the last foreign-scroll pin, until the run loop turns.
    private var undoablePin: NSPoint?

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
        guard !following else { replaceAnchors([]); return }
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
        // Keep subscriptions for overlapping rows instead of tearing them down on every
        // live-scroll step. Only newly visible/removed markers change observation lifetime.
        let retained = Set(new.compactMap { $0.row.map(ObjectIdentifier.init) })
        for anchor in anchors {
            if let row = anchor.row, !retained.contains(ObjectIdentifier(row)) { row.isAnchored = false }
        }
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
        replaceAnchors([])
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.layoutScroll = nil
            self.pinBottomNow()
        }
        layoutScroll = work
        DispatchQueue.main.async(execute: work)
    }

    private func pinBottomNow() {
        guard !restoringAnchor, state?.follow.shouldScrollToBottom == true,
              let scroll = scrollView, let document = scroll.documentView else { return }
        let visible = scroll.contentView.bounds
        let y = document.isFlipped
            ? max(document.bounds.minY - scroll.contentInsets.top,
                  document.bounds.maxY - visible.height + scroll.contentInsets.bottom - bottomPadding)
            : min(document.bounds.maxY - visible.height + scroll.contentInsets.top,
                  document.bounds.minY - scroll.contentInsets.bottom + bottomPadding)
        guard abs(visible.minY - y) > 0.5 else { return }
        restoringAnchor = true
        scroll.contentView.scroll(to: NSPoint(x: visible.minX, y: y))
        scroll.reflectScrolledClipView(scroll.contentView)
        restoringAnchor = false
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
        // During a live scroll, AppKit posts this notification synchronously from the clip view
        // scroll that compensation itself performs. The anchor is not recaptured until that
        // scroll returns, so a nested pass would apply the same shift again, without end.
        guard !restoringAnchor else { return }
        if let away = undoablePin, let scroll = scrollView {
            undoablePin = nil
            restoringAnchor = true
            scroll.contentView.scroll(to: away)
            scroll.reflectScrolledClipView(scroll.contentView)
            restoringAnchor = false
        }
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
    var isAnchored = false {
        didSet {
            guard isAnchored != oldValue else { return }
            observeGeometry()
        }
    }
    private struct GeometrySource { weak var view: NSView? }
    private var sources: [GeometrySource] = []
    private var previousGeometry: NSRect?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { Self.rows.remove(self) } else { Self.rows.add(self) }
        observeGeometry()
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        observeGeometry()
    }

    /// SwiftUI can move the marker, a host's bounds, or an ancestor without changing the
    /// immediate host's frame. Watch only anchored ancestry; never observe clip bounds,
    /// which represent the user's scrolling rather than changes in document geometry.
    private func observeGeometry() {
        let center = NotificationCenter.default
        for source in sources {
            guard let view = source.view else { continue }
            center.removeObserver(self, name: NSView.frameDidChangeNotification, object: view)
            center.removeObserver(self, name: NSView.boundsDidChangeNotification, object: view)
        }
        sources.removeAll(keepingCapacity: true)
        previousGeometry = nil
        guard isAnchored, window != nil, enclosingScrollView != nil else { return }
        previousGeometry = documentGeometry()
        var ancestor: NSView? = self
        while let view = ancestor, !(view is NSClipView) {
            sources.append(GeometrySource(view: view))
            view.postsFrameChangedNotifications = true
            view.postsBoundsChangedNotifications = true
            center.addObserver(self, selector: #selector(geometryChanged), name: NSView.frameDidChangeNotification, object: view)
            center.addObserver(self, selector: #selector(geometryChanged), name: NSView.boundsDidChangeNotification, object: view)
            ancestor = view.superview
        }
    }

    private func documentGeometry() -> NSRect? {
        guard let document = enclosingScrollView?.documentView else { return nil }
        let rect = convert(bounds, to: document)
        let top = document.isFlipped ? rect.minY - document.bounds.minY : document.bounds.maxY - rect.maxY
        return NSRect(x: rect.minX, y: top, width: rect.width, height: rect.height)
    }

    @objc private func geometryChanged(_ notification: Notification) {
        guard isAnchored, window != nil else { return }
        guard let geometry = documentGeometry(), geometry != previousGeometry else { return }
        previousGeometry = geometry
        NotificationCenter.default.post(name: Self.didMove, object: self)
    }
}

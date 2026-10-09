import AppKit
import PilotCore
import SwiftUI

@MainActor
final class TranscriptScrollState: ObservableObject {
    @Published var follow = TranscriptScrollFollow()
    private var renderedScroll: Task<Void, Never>?
    lazy var messageToggled: () -> Void = { [weak self] in self?.follow.pauseFollowing() }

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
    weak var state: TranscriptScrollState?
    var bottomPadding: CGFloat = 0
    private weak var scrollView: NSScrollView?
    private var layoutScroll: DispatchWorkItem?

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
        if let document = scroll.documentView {
            document.postsFrameChangedNotifications = true
            center.addObserver(self, selector: #selector(layoutChanged), name: NSView.frameDidChangeNotification, object: document)
        }
        scheduleLayoutScroll()
    }

    func stopObserving() {
        NotificationCenter.default.removeObserver(self)
        layoutScroll?.cancel()
        layoutScroll = nil
        scrollView = nil
    }

    @objc private func layoutChanged(_ notification: Notification) {
        scheduleLayoutScroll()
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
    }

    @objc private func scrolled(_ notification: Notification) {
        state?.follow.userScrolled(distanceToBottom: distanceToBottom)
    }

    @objc private func scrollEnded(_ notification: Notification) {
        state?.follow.endUserScroll(distanceToBottom: distanceToBottom)
    }
}

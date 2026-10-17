import AppKit
import PilotCore
import WebKit

/// An inline HTML or React artifact the reader uses in place: clicks, hover and typing reach the page.
/// Scrolling is shared with the chat (`ArtifactScrollRouter`): the scroll state under the pointer is
/// read from the page in an isolated script world while the pointer moves, never on the scroll path.
final class InlineArtifactWebView: WKWebView {
    var onEscape: (() -> Void)?
    /// Clicks and typing that may change the page's height.
    var onInteraction: (() -> Void)?
    private var router = ArtifactScrollRouter()
    private var held: [NSEvent] = []
    private var scrollState: ArtifactScrollState?
    private var probeTask: Task<Void, Never>?
    private var probePoint: CGPoint?
    private var probeAgain = false

    override func scrollWheel(with event: NSEvent) {
        let phase = Self.phase(event)
        switch router.route(phase, deltaX: event.scrollingDeltaX, deltaY: event.scrollingDeltaY, state: scrollState) {
        case .hold:
            held.append(event)
        case let .deliver(target):
            let events = held + [event]
            held.removeAll()
            for queued in events {
                if target == .chat, let chat = enclosingScrollView {
                    chat.scrollWheel(with: queued)
                } else {
                    super.scrollWheel(with: queued)
                }
            }
        }
        // The page may have scrolled: refresh its state before the next gesture.
        if phase == .discrete || phase == .ended || phase == .momentumEnded { probe(event) }
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        probe(event)
    }

    override func mouseUp(with event: NSEvent) {
        super.mouseUp(with: event)
        onInteraction?()
    }

    override func keyDown(with event: NSEvent) {
        super.keyDown(with: event)
        onInteraction?()
        // The page sees Escape too; then the chat's composer takes focus back.
        if event.keyCode == 53 { onEscape?() }
    }

    func tearDown() {
        probeTask?.cancel()
        probeTask = nil
        held.removeAll()
        onEscape = nil
        onInteraction = nil
    }

    static func phase(_ event: NSEvent) -> ArtifactScrollPhase {
        if !event.momentumPhase.isEmpty {
            return event.momentumPhase.contains(.ended) || event.momentumPhase.contains(.cancelled) ? .momentumEnded : .momentum
        }
        if event.phase.isEmpty { return .discrete }
        if event.phase.contains(.began) || event.phase.contains(.mayBegin) { return .began }
        if event.phase.contains(.ended) || event.phase.contains(.cancelled) { return .ended }
        return .changed
    }

    /// One read at a time; pointer moves during a read coalesce into one more read at the latest point.
    private func probe(_ event: NSEvent) {
        var point = convert(event.locationInWindow, from: nil)
        if !isFlipped { point.y = bounds.height - point.y }
        probePoint = point
        guard probeTask == nil else {
            probeAgain = true
            return
        }
        probeTask = Task { @MainActor [weak self] in
            repeat {
                guard let self, let point = self.probePoint else { return }
                self.probeAgain = false
                let values = try? await self.callAsyncJavaScript(Self.probeScript, arguments: ["x": point.x, "y": point.y],
                                                                 in: nil, contentWorld: .defaultClient) as? [Bool]
                guard !Task.isCancelled else { return }
                if let state = values.flatMap(ArtifactScrollState.init) { self.scrollState = state }
            } while self?.probeAgain == true
            self?.probeTask = nil
        }
    }

    /// Which ways the element under the point, its scrollable ancestors and the page can still scroll.
    static let probeScript = """
        const state = [false, false, false, false];
        const scrolls = value => value === 'auto' || value === 'scroll' || value === 'overlay';
        function add(up, down, left, right) {
          state[0] ||= up; state[1] ||= down; state[2] ||= left; state[3] ||= right;
        }
        const root = document.scrollingElement || document.documentElement;
        let node = document.elementFromPoint(x, y);
        for (let depth = 0; node && node.nodeType === 1 && depth < 64; depth++, node = node.parentElement) {
          if (node === root || node === document.body) break;
          const style = getComputedStyle(node);
          const vertical = scrolls(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
          const horizontal = scrolls(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
          add(vertical && node.scrollTop > 0, vertical && node.scrollTop + node.clientHeight < node.scrollHeight - 1,
              horizontal && node.scrollLeft > 0, horizontal && node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
        }
        if (root && document.body) {
          const hidden = element => { const s = getComputedStyle(element); return [s.overflowY === 'hidden' || s.overflowY === 'clip', s.overflowX === 'hidden' || s.overflowX === 'clip']; };
          const [rootY, rootX] = hidden(root), [bodyY, bodyX] = hidden(document.body);
          const vertical = !rootY && !bodyY, horizontal = !rootX && !bodyX;
          add(vertical && scrollY > 0, vertical && scrollY + innerHeight < root.scrollHeight - 1,
              horizontal && scrollX > 0, horizontal && scrollX + innerWidth < root.scrollWidth - 1);
        }
        return state;
        """
}

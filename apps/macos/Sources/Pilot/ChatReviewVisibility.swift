import AppKit
import SwiftUI

/// Selection is not review. Only a visible transcript end in the active key window
/// can acknowledge a result. In particular, minimized/closed/background windows cannot.
struct ChatReviewVisibility: NSViewRepresentable {
    let onVisible: () -> Void

    func makeNSView(context: Context) -> ReviewView { ReviewView() }

    func updateNSView(_ view: ReviewView, context: Context) {
        view.onVisible = onVisible
        view.scheduleCheck()
    }

    static func dismantleNSView(_ view: ReviewView, coordinator: ()) {
        view.onVisible = nil
        view.stopObserving()
    }

    final class ReviewView: NSView {
        var onVisible: (() -> Void)?
        private var observers: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stopObserving()
            guard window != nil else { return }
            let names: [Notification.Name] = [
                NSApplication.didBecomeActiveNotification,
                NSWindow.didBecomeKeyNotification,
                NSWindow.didDeminiaturizeNotification,
                NSWindow.didChangeOcclusionStateNotification,
                NSView.boundsDidChangeNotification,
            ]
            for name in names {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                    if name == NSView.boundsDidChangeNotification {
                        guard let clip = notification.object as? NSClipView, clip.window === self?.window else { return }
                    }
                    self?.scheduleCheck()
                })
            }
            scheduleCheck()
        }

        func scheduleCheck() {
            // Defer until SwiftUI has rendered the new result, rather than publishing
            // review changes during updateNSView or acknowledging a stale selection.
            DispatchQueue.main.async { [weak self] in
                guard let self, let window = self.window, NSApp.isActive,
                      window.isKeyWindow, window.isVisible, !window.isMiniaturized,
                      window.occlusionState.contains(.visible), !self.isHiddenOrHasHiddenAncestor,
                      !self.visibleRect.intersection(self.bounds).isEmpty else { return }
                self.onVisible?()
            }
        }

        func stopObserving() {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers.removeAll()
        }

        deinit { stopObserving() }
    }
}

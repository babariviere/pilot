import AppKit
import SwiftUI

/// SwiftUI's focusEffectDisabled does not suppress native field rings on every supported macOS release.
/// Watch only this scene's focused control, never scan the view tree or change keyboard focus itself.
struct NativeFocusRingSuppression: NSViewRepresentable {
    func makeNSView(context: Context) -> FocusRingSuppressionView { FocusRingSuppressionView() }
    func updateNSView(_ view: FocusRingSuppressionView, context: Context) { view.suppressFocusedRing() }
}

final class FocusRingSuppressionView: NSView {
    private var observers: [NSObjectProtocol] = []
    private weak var lastResponder: NSResponder?
    private weak var lastEditorOwner: NSView?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        removeObservers()
        guard window != nil else { return }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSWindow.didUpdateNotification, object: nil, queue: .main) { [weak self] notice in
            MainActor.assumeIsolated {
                guard let self, let window = self.window, notice.object as? NSWindow === window else { return }
                self.suppressFocusedRing()
            }
        })
        // Suppress editing rings synchronously; window updates also cover focus before typing begins.
        observers.append(center.addObserver(forName: NSControl.textDidBeginEditingNotification, object: nil, queue: .main) { [weak self] notice in
            MainActor.assumeIsolated {
                guard let self, let window = self.window, let control = notice.object as? NSView, control.window === window else { return }
                self.suppressRing(on: control)
                self.suppressFocusedRing()
            }
        })
        suppressFocusedRing()
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    private func removeObservers() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        lastResponder = nil
        lastEditorOwner = nil
    }

    func suppressFocusedRing() {
        guard let responder = window?.firstResponder else { return }
        let view = responder as? NSView
        let editor = responder as? NSTextView
        let owner = editor?.isFieldEditor == true ? editor?.delegate as? NSView : nil
        // AppKit reuses one field editor for different controls. Track its owner as well as the responder,
        // and reapply if SwiftUI refreshed a native control's ring setting without moving focus.
        guard responder !== lastResponder || owner !== lastEditorOwner
            || view.map({ $0.focusRingType != .none }) == true || owner.map({ $0.focusRingType != .none }) == true else { return }
        lastResponder = responder
        lastEditorOwner = owner
        if let view { suppressRing(on: view) }
        if let owner { suppressRing(on: owner) }
    }

    private func suppressRing(on view: NSView) {
        // Only the responder and its ancestors can draw its ring. Work is bounded by view depth,
        // independent of the number of transcript rows or controls in the window.
        var current: NSView? = view
        while let candidate = current {
            if candidate.focusRingType != .none { candidate.focusRingType = .none }
            current = candidate.superview
        }
    }
}

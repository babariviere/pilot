import AppKit
import PilotCore
import SwiftUI

private struct RepositoryPollingVisibilityKey: EnvironmentKey {
    // Standalone previews/tests have no MainWindow observer. Production supplies its window state.
    static let defaultValue = true
}

extension EnvironmentValues {
    var repositoryPollingVisible: Bool {
        get { self[RepositoryPollingVisibilityKey.self] }
        set { self[RepositoryPollingVisibilityKey.self] = newValue }
    }
}

struct RepositoryPollingKey: Equatable {
    let visible: Bool
    let state: String
    let updatedAt: Double

    var enabled: Bool { visible && state != "starting" }
}

enum RepositoryPolling {
    static func interval(working: Bool, fullDiff: Bool) -> TimeInterval {
        fullDiff ? (working ? 4 : 30) : (working ? 10 : 60)
    }

    static func visible(appHidden: Bool, windowVisible: Bool, miniaturized: Bool, occluded: Bool) -> Bool {
        !appHidden && windowVisible && !miniaturized && !occluded
    }
}

/// One observer per main window, not one set of notification subscriptions per sidebar row.
struct RepositoryWindowVisibility: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeNSView(context: Context) -> VisibilityView { VisibilityView() }

    func updateNSView(_ view: VisibilityView, context: Context) {
        view.onChange = onChange
        view.scheduleCheck()
    }

    static func dismantleNSView(_ view: VisibilityView, coordinator: ()) {
        view.onChange = nil
        view.stopObserving()
    }

    final class VisibilityView: NSView {
        var onChange: ((Bool) -> Void)?
        private var observers: [NSObjectProtocol] = []
        private var scheduled = false
        private var last: Bool?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stopObserving()
            if let window {
                let center = NotificationCenter.default
                for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                             NSWindow.didDeminiaturizeNotification] {
                    observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                        self?.scheduleCheck()
                    })
                }
                for name in [NSApplication.didHideNotification, NSApplication.didUnhideNotification] {
                    observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                        self?.scheduleCheck()
                    })
                }
            }
            scheduleCheck()
        }

        func scheduleCheck() {
            guard !scheduled else { return }
            scheduled = true
            // Do not mutate SwiftUI state while updating its NSViewRepresentable.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.scheduled = false
                let visible = RepositoryPolling.visible(appHidden: NSApp?.isHidden ?? false,
                    windowVisible: self.window?.isVisible == true,
                    miniaturized: self.window?.isMiniaturized == true,
                    occluded: self.window?.occlusionState.contains(.visible) != true)
                guard visible != self.last else { return }
                self.last = visible
                self.onChange?(visible)
            }
        }

        func stopObserving() {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers.removeAll()
        }

        deinit { stopObserving() }
    }
}

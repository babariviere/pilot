import AppKit
import GhosttyTerminal
import SwiftUI
import Testing
@testable import Pilot

@Suite(.serialized) @MainActor struct TerminalLayoutTests {
    @Test(.timeLimit(.minutes(1)))
    func terminalOpeningAndResizingDoNotFeedNativeFittingSizeBackIntoWindowConstraints() throws {
        _ = NSApplication.shared
        let state = TerminalLayoutState()
        let hosting = NSHostingView(rootView: TerminalLayoutContent(state: state))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 1231, height: 700),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = hosting
        window.orderFrontRegardless()

        func settle() {
            for _ in 0..<5 {
                hosting.layoutSubtreeIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            }
        }
        func terminal(in view: NSView) -> FittingSizeTerminalView? {
            if let surface = view as? FittingSizeTerminalView { return surface }
            return view.subviews.lazy.compactMap { terminal(in: $0) }.first
        }

        settle()
        for _ in 0..<3 {
            state.showsTerminal = true
            settle()
            let surface = try #require(terminal(in: hosting))
            let initialSize = surface.frame.size
            #expect(abs(initialSize.width - 340) <= 1)
            #expect(initialSize.height > 0)

            // Repeated native invalidations must not change the allocated viewport.
            for _ in 0..<3 {
                surface.invalidateIntrinsicContentSize()
                settle()
                #expect(surface.frame.size == initialSize)
            }
            window.setContentSize(NSSize(width: 1500, height: 800))
            settle()
            #expect(abs(surface.frame.width - 340) <= 1)
            #expect(surface.frame.height > initialSize.height)
            state.showsTerminal = false
            settle()
            window.setContentSize(NSSize(width: 1231, height: 700))
            settle()
        }
    }
}

@MainActor private final class TerminalLayoutState: ObservableObject {
    @Published var showsTerminal = false
    let terminal: TerminalViewState

    init() {
        terminal = TerminalViewState(controller: TerminalController(configSource: .none))
        terminal.configuration = TerminalSurfaceOptions(backend: .inMemory(
            InMemoryTerminalSession(write: { _ in }, resize: { _ in })
        ))
        terminal.makePlatformView = { FittingSizeTerminalView(frame: .zero) }
    }
}

private struct TerminalLayoutContent: View {
    @ObservedObject var state: TerminalLayoutState

    var body: some View {
        ChatInspectorSplit(showsInspector: state.showsTerminal) {
            Color.clear
        } inspector: {
            TerminalSurfaceView(context: state.terminal)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// An adversarial native surface: fitting-size changes during placement reproduce AppKit's
/// "more Update Constraints in Window passes than there are views" abort with the default bridge.
/// SwiftUI must supply the viewport instead, without asking this view for its fitting size.
@MainActor private final class FittingSizeTerminalView: AppTerminalView {
    override var intrinsicContentSize: NSSize {
        NSSize(width: max(340, frame.width + 1), height: NSView.noIntrinsicMetric)
    }

    override func setFrameSize(_ size: NSSize) {
        let changed = size != frame.size
        super.setFrameSize(size)
        if changed { invalidateIntrinsicContentSize() }
    }
}

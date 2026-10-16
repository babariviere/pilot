import AppKit
import SwiftUI
import Testing
@testable import Pilot

@Suite(.serialized) @MainActor struct ChatInspectorSplitTests {
    @Test(arguments: [800.0, 1000.0, 1400.0, 2200.0])
    func openingInspectorLeavesSpareWidthWithChat(width: CGFloat) throws {
        let fixture = InspectorSplitFixture(width: width)
        defer { fixture.window.close() }
        fixture.settle()
        fixture.state.showsInspector = true
        fixture.settle()

        let split = try #require(fixture.split)
        #expect(split.arrangedSubviews.count == 2)
        let chat = try #require(split.arrangedSubviews.first)
        let inspector = try #require(split.arrangedSubviews.last)
        #expect(abs(inspector.frame.width - 340) <= 1)
        #expect(chat.frame.width > inspector.frame.width)
        #expect(abs(chat.frame.width + inspector.frame.width + split.dividerThickness - width) <= 1)

        fixture.state.wideContent = true
        fixture.settle()
        #expect(abs(inspector.frame.width - 340) <= 1)
        fixture.state.showsInspector = false
        fixture.settle()
        #expect(split.arrangedSubviews.count == 1)
        #expect(abs(chat.frame.width - width) <= 1)
    }

    @Test func nativeDividerCanWidenInspectorAndContentChangesKeepUserWidth() throws {
        let fixture = InspectorSplitFixture(width: 1400)
        defer { fixture.window.close() }
        fixture.state.showsInspector = true
        fixture.settle()
        let split = try #require(fixture.split)
        split.setPosition(1400 - split.dividerThickness - 600, ofDividerAt: 0)
        fixture.settle()
        let inspector = try #require(split.arrangedSubviews.last)
        #expect(abs(inspector.frame.width - 600) <= 1)

        fixture.state.wideContent = true
        fixture.settle()
        #expect(abs(inspector.frame.width - 600) <= 1)
        fixture.window.setContentSize(NSSize(width: 1700, height: 400))
        fixture.settle()
        #expect(abs(inspector.frame.width - 600) <= 1)
    }
}

@MainActor private final class InspectorSplitState: ObservableObject {
    @Published var showsInspector = false
    @Published var wideContent = false
}

private struct InspectorSplitContent: View {
    @ObservedObject var state: InspectorSplitState

    var body: some View {
        ChatInspectorSplit(showsInspector: state.showsInspector) {
            Color.white
        } inspector: {
            Text(state.wideContent ? String(repeating: "Wide terminal or artifact content ", count: 100) : "Links")
                .lineLimit(1).frame(maxHeight: .infinity)
        }
    }
}

@MainActor private final class InspectorSplitFixture {
    let state = InspectorSplitState()
    let window: NSWindow
    let hosting: NSHostingView<InspectorSplitContent>

    init(width: CGFloat) {
        _ = NSApplication.shared
        hosting = NSHostingView(rootView: InspectorSplitContent(state: state))
        window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: width, height: 400),
                          styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.orderFrontRegardless()
    }

    var split: NSSplitView? {
        func find(_ view: NSView) -> NSSplitView? {
            if let split = view as? NSSplitView { return split }
            return view.subviews.lazy.compactMap { find($0) }.first
        }
        return find(hosting)
    }

    func settle() {
        for _ in 0..<5 {
            hosting.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
    }
}

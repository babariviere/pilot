import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@MainActor private func waitForMessageLayout(_ condition: () -> Bool) throws {
    let deadline = Date().addingTimeInterval(2)
    while !condition(), Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    try #require(condition(), "Message layout did not settle")
}

@Test @MainActor func clickingFoldedMessageExpandsItAndPausesFollow() throws {
    _ = NSApplication.shared
    let expansion = ExpansionState()
    let scroll = TranscriptScrollState()
    let source = (1...18).map { "Frame \($0): menu update" }.joined(separator: "\n")
    let host = NSHostingView(rootView: VStack(alignment: .leading) {
        CollapsibleMessage(text: source, userBubble: true, expansion: expansion) { Text(source) }
        Spacer()
    }.padding(24).environment(\.transcriptMessageToggled, scroll.messageToggled))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 600),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = host
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    host.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    let font = PilotFonts.standard.nsBody
    let previewHeight = ceil(font.ascender - font.descender + font.leading + 5) * CGFloat(MessagePreview.visibleLineLimit)
    // The bubble padding, fully faded text edge and separate chevron all expand.
    for topDistance in [40.0, 24 + 10 + previewHeight - 4, 24 + 10 + previewHeight + 4 + 8 + 5] {
        expansion.expanded = false
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        let point = NSPoint(x: 50, y: host.isFlipped ? topDistance : host.bounds.height - topDistance)
        let location = host.convert(point, to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1,
                clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        #expect(expansion.expanded)
    }
    #expect(!scroll.follow.shouldScrollToBottom)
}

@Test @MainActor func fadedPreviewHeightTracksChatFontMetrics() {
    _ = NSApplication.shared
    for size in [14.0, 24.0] {
        let fonts = PilotFonts(chatFamily: "Helvetica", chatSize: size,
            codeFamily: AppSettings.systemMono, codeSize: 12)
        let source = String(repeating: "Menu update frame\n", count: 4000)
        let host = NSHostingView(rootView: UserMessage(text: source)
            .environment(\.pilotFonts, fonts)
            .fixedSize(horizontal: false, vertical: true).frame(width: 400))
        host.frame = NSRect(x: 0, y: 0, width: 400, height: 600)
        host.layoutSubtreeIfNeeded()
        let font = fonts.nsBody
        let previewHeight = ceil(font.ascender - font.descender + font.leading + 5)
            * CGFloat(MessagePreview.visibleLineLimit)
        #expect(host.fittingSize.height >= previewHeight)
        #expect(host.fittingSize.height < previewHeight + 60)
    }
}

@Test @MainActor func foldedMessagesDoNotBuildTheirFullContent() throws {
    _ = NSApplication.shared
    let source = String(repeating: "Crash report frame\n", count: 4000)
    var fullContentBuilds = 0
    func fullContent() -> some View {
        fullContentBuilds += 1
        return Text(source)
    }
    let expansion = ExpansionState()
    let host = NSHostingView(rootView: CollapsibleMessage(text: source, expansion: expansion) {
        fullContent()
    }.fixedSize(horizontal: false, vertical: true).frame(width: 400))
    host.frame = NSRect(x: 0, y: 0, width: 400, height: 500)
    host.layoutSubtreeIfNeeded()
    let foldedHeight = host.fittingSize.height
    #expect(foldedHeight < 200)
    #expect(fullContentBuilds == 0)
    expansion.expanded = true
    host.layoutSubtreeIfNeeded()
    try waitForMessageLayout { host.fittingSize.height > foldedHeight + 500 && fullContentBuilds > 0 }
    #expect(host.fittingSize.height > foldedHeight + 500)
    #expect(fullContentBuilds > 0)
    expansion.expanded = false
    host.layoutSubtreeIfNeeded()
    try waitForMessageLayout { host.fittingSize.height == foldedHeight }
    #expect(host.fittingSize.height == foldedHeight)
}

@Test @MainActor func longUserBubbleStaysBoundedAtNarrowWidths() {
    _ = NSApplication.shared
    for width in [300.0, 700.0] {
        let host = NSHostingView(rootView: UserMessage(text: String(repeating: "Frame details\n", count: 5000))
            .fixedSize(horizontal: false, vertical: true).frame(width: width))
        host.frame = NSRect(x: 0, y: 0, width: width, height: 500)
        host.layoutSubtreeIfNeeded()
        #expect(host.fittingSize.height < 220)
        #expect(host.fittingSize.width <= width)
    }
}

@Test @MainActor func userBubblesHugShortMessagesAndWrapLongOnes() throws {
    _ = NSApplication.shared
    let width = 600.0
    // Row width less the 72 pt leading spacer and the bubble's horizontal padding.
    let available = width - 72 - 28
    func textFrame(_ text: String) throws -> NSRect {
        let host = NSHostingView(rootView: UserMessage(text: text)
            .fixedSize(horizontal: false, vertical: true).frame(width: width))
        host.frame = NSRect(x: 0, y: 0, width: width, height: 400)
        host.layoutSubtreeIfNeeded()
        func find(_ view: NSView) -> MessageSelectionTextView? {
            (view as? MessageSelectionTextView) ?? view.subviews.lazy.compactMap(find).first
        }
        return try #require(find(host)).frame
    }
    let short = try textFrame("what can we safely start with sol?")
    #expect(short.width > 0)
    #expect(short.width < available / 2)
    let long = try textFrame(String(repeating: "what can we safely start with sol? ", count: 12))
    #expect(long.width <= available)
    #expect(long.width > available - 80)
    #expect(long.height > short.height * 2)
}

@Test @MainActor func userBubblesRenderMarkdownAndStillHug() async throws {
    _ = NSApplication.shared
    let width = 600.0
    let source = "Use **bold** and `code`\n\n- first item\n- second item"
    // Seed the shared cache so the view shows prepared blocks on its first layout.
    await MarkdownView.prewarm(source)
    let host = NSHostingView(rootView: UserMessage(text: source)
        .fixedSize(horizontal: false, vertical: true).frame(width: width))
    host.frame = NSRect(x: 0, y: 0, width: width, height: 400)
    host.layoutSubtreeIfNeeded()
    func find(_ view: NSView) -> [MessageSelectionTextView] {
        ((view as? MessageSelectionTextView).map { [$0] } ?? []) + view.subviews.flatMap(find)
    }
    let views = find(host)
    let strings = views.map { $0.textStorage?.string ?? "" }
    #expect(strings.contains("Use bold and code"))
    #expect(strings.contains("first item"))
    #expect(!strings.contains { $0.contains("**") || $0.contains("- first") })
    for view in views { #expect(view.frame.width < (width - 72 - 28) / 2) }
}

@Test @MainActor func historicalMessageRetainsExpansionAfterRecreation() {
    _ = NSApplication.shared
    let source = String(repeating: "Report details\n", count: 40)
    let owner = TranscriptExpansions()
    owner.state(for: "7-0").expanded = true
    let rows: [ChatRow] = [.user(id: "7-0", text: source)]
    func height(_ expansions: TranscriptExpansions) -> CGFloat {
        let host = NSHostingView(rootView: TranscriptHistoryRows(revision: UUID(), rows: rows[...],
            messageExpansions: expansions).fixedSize(horizontal: false, vertical: true).frame(width: 500))
        host.frame = NSRect(x: 0, y: 0, width: 500, height: 800)
        host.layoutSubtreeIfNeeded()
        return host.fittingSize.height
    }
    #expect(height(owner) > height(TranscriptExpansions()) + 200)
    #expect(height(owner) > height(TranscriptExpansions()) + 200)
}

@Test @MainActor func expandingMessagesPausesPreparedBottomScroll() async {
    let scroll = TranscriptScrollState()
    var scrolled = false
    scroll.contentPrepared { scrolled = true }
    scroll.messageToggled()
    for _ in 0..<10 { await Task.yield() }
    #expect(!scrolled)
    #expect(!scroll.follow.shouldScrollToBottom)
    scroll.follow.endUserScroll(distanceToBottom: 0)
    #expect(scroll.follow.shouldScrollToBottom)
}

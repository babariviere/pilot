import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

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

@Test @MainActor func foldedMessagesDoNotBuildTheirFullContent() {
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
    #expect(host.fittingSize.height > foldedHeight + 500)
    #expect(fullContentBuilds > 0)
    expansion.expanded = false
    host.layoutSubtreeIfNeeded()
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

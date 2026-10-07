import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test func settledSessionStatusesUseDistinctAvailableSymbols() {
    let symbols: [(SessionStatus, String)] = [
        (.done, "checkmark"),
        (.needsInput, "hand.raised.fill"),
        (.failed, "exclamationmark.triangle.fill"),
        (.stopped, "stop.circle.fill"),
        (.idle, "moon.zzz.fill"),
    ]
    #expect(Set(symbols.map { $0.1 }).count == symbols.count)
    for (status, symbol) in symbols {
        #expect(status.symbolName == symbol)
        #expect(NSImage(systemSymbolName: symbol, accessibilityDescription: nil) != nil)
    }
    #expect(SessionStatus.working.symbolName == nil)
}

@Test func brailleProgressAdvancesAndLoops() {
    #expect(BrailleProgress.frames.count == 10)
    #expect(Set(BrailleProgress.frames).count == 10)
    for index in 0..<20 {
        let date = Date(timeIntervalSinceReferenceDate: Double(index) * BrailleProgress.interval + 0.01)
        #expect(BrailleProgress.frameIndex(at: date) == index % 10)
    }
    #expect(BrailleProgress.frameIndex(at: Date(timeIntervalSinceReferenceDate: -0.01)) == 9)
}

@Test func brailleProgressUsesFixedSizeTemplateImages() {
    #expect(BrailleProgress.images.count == BrailleProgress.frames.count)
    for image in BrailleProgress.images {
        #expect(image.isTemplate)
        #expect(image.size == NSSize(width: 14, height: 14))
    }
}

@Test func brailleProgressRendersDistinctGlyphsInsteadOfMissingCharacterBoxes() throws {
    let frames = try BrailleProgress.images.map { try #require($0.tiffRepresentation) }
    #expect(Set(frames).count == BrailleProgress.frames.count)
}

@Test func sessionStatusIconsUseNeutralWorkingAndColoredOutcomes() {
    #expect(SessionStatus.working.color == Theme.foreground)
    #expect(SessionStatus.done.color == Theme.success)
    #expect(SessionStatus.needsInput.color == Theme.warning)
    #expect(SessionStatus.failed.color == Theme.destructive)
    #expect(SessionStatus.stopped.color == Theme.mutedForeground)
    #expect(SessionStatus.idle.color == Theme.mutedForeground)
}

@Test @MainActor func sessionStatusIconsShareATitleAlignedBaseline() throws {
    _ = NSApplication.shared
    let statuses: [SessionStatus] = [.working, .done, .needsInput, .failed, .stopped, .idle]
    var baselines: [String: CGFloat] = [:]
    let root = HStack(alignment: .firstTextBaseline) {
        ForEach(statuses, id: \.rawValue) { status in
            SessionStatusIcon(status: status)
                .alignmentGuide(.firstTextBaseline) { dimensions in
                    let baseline = dimensions[.firstTextBaseline]
                    baselines[status.rawValue] = baseline
                    return baseline
                }
        }
        Text("Session title").font(.system(size: 13))
    }
    let hosting = NSHostingView(rootView: root)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 80),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = hosting
    hosting.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    hosting.layoutSubtreeIfNeeded()
    #expect(baselines.count == statuses.count)
    for status in statuses {
        let baseline = try #require(baselines[status.rawValue])
        #expect(abs(baseline - (7 + NSFont.systemFont(ofSize: 13).capHeight / 2)) < 0.01)
    }
}

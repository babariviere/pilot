import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test func sessionStatusesUseDistinctAvailableSymbols() {
    let symbols: [(SessionStatus, String)] = [
        (.working, "arrow.triangle.2.circlepath"),
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
}

@Test func sessionStatusIconsKeepTheirExistingColors() {
    #expect(SessionStatus.working.color == Theme.info)
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

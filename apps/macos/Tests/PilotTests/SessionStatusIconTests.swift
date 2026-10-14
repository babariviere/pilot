import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test func settledSessionStatusesUseDistinctAvailableSymbols() {
    let symbols: [(SessionStatus, PilotIcon)] = [
        (.done, .complete),
        (.failed, .warning),
        (.stopped, .stopped),
        (.idle, .idle),
    ]
    #expect(Set(symbols.map { $0.1 }).count == symbols.count)
    for (status, symbol) in symbols {
        #expect(status.icon == symbol)
        #expect(NSImage(systemSymbolName: symbol.systemName!, accessibilityDescription: nil) != nil)
    }
    #expect(SessionStatus.working.icon == .working)
}

@Test func sessionStatusIconsUseSharedWorkingAndOutcomeColors() {
    #expect(SessionStatus.working.color == Theme.working)
    #expect(SessionStatus.done.color == Theme.success)
    #expect(SessionStatus.failed.color == Theme.destructive)
    #expect(SessionStatus.stopped.color == Theme.mutedForeground)
    #expect(SessionStatus.idle.color == Theme.mutedForeground)
}

@Test @MainActor func sessionStatusIconsShareATitleAlignedBaseline() throws {
    _ = NSApplication.shared
    let statuses: [SessionStatus] = [.working, .done, .failed, .stopped, .idle]
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

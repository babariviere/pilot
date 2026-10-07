import AppKit
import PilotCore
import Testing
@testable import Pilot

@Test func sessionStatusesUseDistinctAvailableSymbols() {
    let symbols: [(SessionStatus, String)] = [
        (.working, "arrow.triangle.2.circlepath"),
        (.done, "checkmark.circle.fill"),
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

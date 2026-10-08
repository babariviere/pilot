import Testing
@testable import Pilot

@Test func terminalRenderingRequiresBothSelectedSessionAndVisibleTab() {
    #expect(TerminalPane.surfaceIsVisible("a", selected: "a", paneVisible: true))
    #expect(!TerminalPane.surfaceIsVisible("b", selected: "a", paneVisible: true))
    #expect(!TerminalPane.surfaceIsVisible("a", selected: "a", paneVisible: false))
    #expect(!TerminalPane.surfaceIsVisible("b", selected: "a", paneVisible: false))
}

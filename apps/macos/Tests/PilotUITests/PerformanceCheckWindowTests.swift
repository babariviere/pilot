import AppKit
import Testing
@testable import Pilot

@Suite(.serialized) @MainActor
struct PerformanceCheckWindowTests {
    private func window(identifier: String?) -> NSWindow {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.identifier = identifier.map { NSUserInterfaceItemIdentifier($0) }
        return window
    }

    @Test func fixtureUsesTheExistingSceneWithoutReplacingItsGraph() throws {
        let main = window(identifier: MainWindow.id)
        let other = window(identifier: "other")
        defer { main.close(); other.close() }
        let root = NSView()
        main.contentView = root
        let selected = try #require(PerformanceCheck.mainSceneWindow(in: [other, main]))
        let sameWindow = selected === main
        let sameRoot = selected.contentView === root
        #expect(sameWindow)
        #expect(sameRoot)
    }

    @Test func missingOrAmbiguousSceneCannotCreateAnotherFixtureHost() {
        let first = window(identifier: MainWindow.id)
        let second = window(identifier: MainWindow.id)
        let other = window(identifier: nil)
        defer { first.close(); second.close(); other.close() }
        #expect(PerformanceCheck.mainSceneWindow(in: []) == nil)
        #expect(PerformanceCheck.mainSceneWindow(in: [other]) == nil)
        #expect(PerformanceCheck.mainSceneWindow(in: [first, second]) == nil)
    }
}

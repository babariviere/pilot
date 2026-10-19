import AppKit
import PilotCore
import Testing
import WebKit
@testable import Pilot

@MainActor
private func shownWindow(width: CGFloat = 900) -> NSWindow {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 600), styleMask: [.titled],
                          backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 600))
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    return window
}

@MainActor
private func key(_ characters: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = [], in window: NSWindow) throws -> NSEvent {
    try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
                                 windowNumber: window.windowNumber, context: nil, characters: characters,
                                 charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code))
}

@MainActor
private func anchor(_ region: KeyboardRegion, _ frame: NSRect, focus: KeyboardFocus, in window: NSWindow) {
    let view = KeyboardRegionAnchor.AnchorView(frame: frame)
    view.region = region
    view.focus = focus
    window.contentView?.addSubview(view)
}

/// Artifact content that traps Tab: every key is its own, except the reserved routes.
@Test @MainActor func webContentKeepsItsKeysAndReservedRoutesStillLeave() throws {
    let window = shownWindow()
    defer { window.close() }
    let focus = KeyboardFocus()
    anchor(.content, NSRect(x: 0, y: 0, width: 600, height: 600), focus: focus, in: window)
    anchor(.composer, NSRect(x: 20, y: 10, width: 560, height: 80), focus: focus, in: window)
    anchor(.inspector, NSRect(x: 600, y: 0, width: 300, height: 600), focus: focus, in: window)
    let composer = NSTextView(frame: NSRect(x: 30, y: 20, width: 200, height: 40))
    window.contentView?.addSubview(composer)
    let web = WKWebView(frame: NSRect(x: 620, y: 20, width: 260, height: 500))
    window.contentView?.addSubview(web)
    #expect(window.makeFirstResponder(web))

    let router = KeyboardRouter()
    router.focus = focus
    var routes: [KeyboardRoute] = []
    router.perform = { route in routes.append(route); return true }
    for event in [try key("\t", 48, in: window), try key("\t", 48, .control, in: window), try key("\u{1b}", 53, in: window),
                  try key("c", 8, .control, in: window), try key("g", 5, in: window), try key("j", 38, in: window),
                  try key("?", 44, .shift, in: window), try key("w", 13, .command, in: window)] {
        #expect(router.handle(event) === event, "web content keeps \(event.charactersIgnoringModifiers ?? "")")
    }
    #expect(routes.isEmpty)
    #expect(router.handle(try key("k", 40, .command, in: window)) == nil)
    #expect(router.handle(try key("l", 37, .command, in: window)) == nil)
    #expect(routes == [.commandPalette, .focusComposer])
    #expect(focus.currentRegion() == .inspector, "geometry places the web view in the inspector")
}

@Test @MainActor func commandLLeavesWebContentInAnArtifactWindow() throws {
    let main = shownWindow()
    defer { main.close() }
    let focus = KeyboardFocus()
    anchor(.content, NSRect(x: 0, y: 0, width: 900, height: 600), focus: focus, in: main)
    let viewer = shownWindow(width: 500)
    defer { viewer.close() }
    let close = NSButton(frame: NSRect(x: 10, y: 550, width: 40, height: 30))
    viewer.contentView?.addSubview(close)
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 500, height: 540))
    viewer.contentView?.addSubview(web)
    #expect(viewer.makeFirstResponder(web))
    let router = KeyboardRouter()
    router.focus = focus
    router.perform = { _ in Issue.record("viewer keys never run main-window routes"); return true }
    let escape = try key("\u{1b}", 53, in: viewer)
    #expect(router.handle(escape) === escape, "Escape stays with the page")
    let controlTab = try key("\t", 48, .control, in: viewer)
    #expect(router.handle(controlTab) === controlTab, "⌃⇥ stays with the page")
    #expect(viewer.firstResponder === web)
    #expect(router.handle(try key("l", 37, .command, in: viewer)) == nil)
    // Focus left the web view: for the window's own controls, or the window itself when buttons take no focus
    // (Keyboard navigation off), so Escape and Return reach its default buttons again.
    let responder = viewer.firstResponder
    #expect(responder !== web)
    if let view = responder as? NSView { #expect(!KeyboardInputGuard.isEmbedded(view)) }
}

@Test func terminalSurfacesAreRecognizedByTheirViewClass() {
    final class AppTerminalView: NSView {}
    final class TerminalSurfaceView: NSView {}
    #expect(KeyboardInputGuard.isTerminal(AppTerminalView()))
    #expect(!KeyboardInputGuard.isTerminal(TerminalSurfaceView()))
    #expect(!KeyboardInputGuard.isTerminal(NSView()))
}

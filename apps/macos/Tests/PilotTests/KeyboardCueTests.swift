import AppKit
import SwiftUI
import Testing
@testable import Pilot

private func chord(_ characters: String, _ modifiers: NSEvent.ModifierFlags = [], keyCode: UInt16 = 0) -> KeyboardChord {
    KeyboardChord(characters: characters, keyCode: keyCode, modifiers: modifiers)
}

private let tab: UInt16 = KeyboardChord.tabKeyCode
private let escape: UInt16 = KeyboardChord.escapeKeyCode

@Test @MainActor func onlyNavigationKeysShowTheKeyboardCue() {
    // Browsing outside text: arrows, Return, Tab, Home/End and ⌥-arrows navigate.
    for key in [chord("\u{f701}", keyCode: 125), chord("\r", keyCode: 36), chord("\t", keyCode: tab),
                chord("\t", .shift, keyCode: tab), chord("\u{f700}", .option, keyCode: 126), chord("\u{f729}", keyCode: 115)] {
        #expect(KeyboardCue.navigates(key, context: .navigation, fieldEditor: false))
    }
    // Letters and digits are not navigation keys, even outside text: there are no letter shortcuts.
    for key in [chord("j", keyCode: 38), chord("k", keyCode: 40), chord("g", keyCode: 5), chord("e", keyCode: 14),
                chord("1", keyCode: 18)] {
        #expect(!KeyboardCue.navigates(key, context: .navigation, fieldEditor: false))
    }
    // Menu shortcuts are not navigation.
    #expect(!KeyboardCue.navigates(chord("n", .command), context: .navigation, fieldEditor: false))
    #expect(!KeyboardCue.navigates(chord("k", .command), context: .navigation, fieldEditor: false))
    // ⌃⇥ is not an app shortcut: it shows nothing over text or embedded content.
    for context in [KeyboardInputContext.navigation, .text, .embedded] {
        #expect(!KeyboardCue.navigates(chord("\t", .control, keyCode: tab), context: context, fieldEditor: false))
        #expect(!KeyboardCue.navigates(chord("\t", [.control, .shift], keyCode: tab), context: context, fieldEditor: false))
    }
    // Typing and editing keys in an editor never show it, including the composer's Tab completion.
    for key in [chord("g", keyCode: 5), chord("j", keyCode: 38), chord("\u{f701}", keyCode: 125), chord("\r", keyCode: 36),
                chord("\t", keyCode: tab), chord("a", .command), chord("\u{1b}", .shift, keyCode: escape)] {
        #expect(!KeyboardCue.navigates(key, context: .text, fieldEditor: false))
    }
    // Leaving a field does: Tab out of a single-line field, Escape back to the page.
    #expect(KeyboardCue.navigates(chord("\t", keyCode: tab), context: .text, fieldEditor: true))
    #expect(KeyboardCue.navigates(chord("\t", .shift, keyCode: tab), context: .text, fieldEditor: true))
    #expect(KeyboardCue.navigates(chord("\u{1b}", keyCode: escape), context: .text, fieldEditor: false))
    // Terminal and web content keep every other key.
    for key in [chord("\u{f701}", keyCode: 125), chord("\t", keyCode: tab), chord("\u{1b}", keyCode: escape), chord("j", keyCode: 38)] {
        #expect(!KeyboardCue.navigates(key, context: .embedded, fieldEditor: false))
    }
}

@MainActor
private func cueWindow() -> NSWindow {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.titled],
                          backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
    // Key events resolve their window by number, which needs it on screen.
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    return window
}

@MainActor
private func key(_ characters: String, keyCode: UInt16, modifiers: NSEvent.ModifierFlags = [], in window: NSWindow) -> NSEvent? {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
                     windowNumber: window.windowNumber, context: nil, characters: characters,
                     charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode)
}

@MainActor
private func click(in window: NSWindow) -> NSEvent? {
    NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 10, y: 10), modifierFlags: [], timestamp: 0,
                       windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
}

@Test @MainActor func clicksHideTheCueAndKeyboardNavigationRestoresIt() throws {
    let window = cueWindow()
    defer { window.close() }
    let root = try #require(window.contentView)
    let cue = KeyboardCue()
    let router = KeyboardRouter()
    router.cue = cue
    router.focus = KeyboardFocus()
    router.perform = { _ in false }

    let editor = NSTextView(frame: NSRect(x: 0, y: 0, width: 200, height: 40))
    root.addSubview(editor)
    let table = NSTableView(frame: NSRect(x: 0, y: 100, width: 200, height: 200))
    // A table without columns refuses first responder, unlike the sidebar's outline.
    table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("title")))
    root.addSubview(table)

    // Click-only use never shows it.
    let down = try #require(click(in: window))
    #expect(router.handlePointer(down) === down, "clicks are delivered unchanged")
    #expect(window.makeFirstResponder(table))
    #expect(!cue.visible)

    // Typing in an editor never shows it, even keys that navigate elsewhere.
    #expect(window.makeFirstResponder(editor))
    for event in [try #require(key("g", keyCode: 5, in: window)), try #require(key("j", keyCode: 38, in: window)),
                  try #require(key("\u{f701}", keyCode: 125, modifiers: [.function, .numericPad], in: window)),
                  try #require(key("\t", keyCode: KeyboardChord.tabKeyCode, in: window))] {
        _ = router.handle(event)
    }
    #expect(!cue.visible)

    // Keyboard navigation: an arrow in the list.
    #expect(window.makeFirstResponder(table))
    _ = router.handle(try #require(key("\u{f701}", keyCode: 125, modifiers: [.function, .numericPad], in: window)))
    #expect(cue.visible)

    // A click hides it, and focus arriving after the click (SwiftUI moves it asynchronously) keeps it hidden:
    // only key presses turn the cue on, never a responder change.
    _ = router.handlePointer(down)
    #expect(!cue.visible)
    #expect(window.makeFirstResponder(editor))
    #expect(window.makeFirstResponder(table))
    #expect(!cue.visible)

    // A letter in the list is not navigation, so the cue stays hidden.
    _ = router.handle(try #require(key("j", keyCode: 38, in: window)))
    #expect(!cue.visible)
    // The next navigation key restores it: an arrow in the list, or Escape out of an editor.
    _ = router.handle(try #require(key("\u{f701}", keyCode: 125, modifiers: [.function, .numericPad], in: window)))
    #expect(cue.visible)
    _ = router.handlePointer(down)
    #expect(window.makeFirstResponder(editor))
    _ = router.handle(try #require(key("\u{1b}", keyCode: KeyboardChord.escapeKeyCode, in: window)))
    #expect(cue.visible)
}

@MainActor
private func centre(_ view: some View) throws -> NSColor {
    let renderer = ImageRenderer(content: ZStack { Color.white; view }.frame(width: 120, height: 40)
        .environment(\.colorScheme, .light))
    let bitmap = NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
    return try #require(bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)?.usingColorSpace(.deviceRGB))
}

@Test @MainActor func listRowsDrawTheQuietFillOnlyWithTheCue() throws {
    func row(_ highlight: KeyboardListHighlight) -> some View {
        Color.clear.keyboardListItem("a") {}.environment(\.keyboardListHighlight, highlight)
    }
    let plain = try centre(row(KeyboardListHighlight()))
    // Highlighted with focus from a click: the target is kept, nothing is drawn.
    let clicked = try centre(row(KeyboardListHighlight(id: "a", focused: true, showsCue: false)))
    let keyboard = try centre(row(KeyboardListHighlight(id: "a", focused: true, showsCue: true)))
    let other = try centre(row(KeyboardListHighlight(id: "b", focused: true, showsCue: true)))
    let selected = try centre(Color.clear.background(Theme.selected))
    #expect(clicked == plain)
    #expect(other == plain)
    // Visible, neutral, and fainter than a real selection.
    #expect(keyboard.redComponent < plain.redComponent - 0.01)
    #expect(keyboard.redComponent > selected.redComponent + 0.005)
    #expect(abs(keyboard.redComponent - keyboard.blueComponent) < 0.01)
    #expect(KeyboardListHighlight(id: "a", focused: true, showsCue: true).decorates("a"))
    #expect(!KeyboardListHighlight(id: "a", focused: true, showsCue: false).decorates("a"))
}

@Test @MainActor func chatRowsKeepTheirGreySelectionAfterAClick() throws {
    func chat(_ highlight: KeyboardListHighlight) -> some View {
        Color.clear.keyboardListItem("a", target: .session(id: "a", reference: nil)) {}
            .environment(\.keyboardListHighlight, highlight)
    }
    let plain = try centre(chat(KeyboardListHighlight()))
    let selected = try centre(Color.clear.background(Theme.selected))
    // Highlighted by a click (no keyboard cue), by the keyboard, or kept while the list is unfocused: the same grey.
    #expect(try centre(chat(KeyboardListHighlight(id: "a", focused: true, showsCue: false))) == selected)
    #expect(try centre(chat(KeyboardListHighlight(id: "a", focused: true, showsCue: true))) == selected)
    #expect(try centre(chat(KeyboardListHighlight(id: "a", focused: false, showsCue: false))) == selected)
    #expect(try centre(chat(KeyboardListHighlight(id: "b", focused: true, showsCue: true))) == plain)
}

@Test @MainActor func transcriptHighlightIsAQuietFillOnlyWithTheCue() throws {
    func message(_ highlight: TranscriptHighlight) -> some View {
        Color.clear.background(TranscriptRowHighlight(id: "m")).environment(\.transcriptHighlight, highlight)
    }
    let plain = try centre(message(TranscriptHighlight()))
    #expect(try centre(message(TranscriptHighlight(id: "m", showsCue: false))) == plain)
    #expect(try centre(message(TranscriptHighlight(id: "other", showsCue: true))) == plain)
    let keyboard = try centre(message(TranscriptHighlight(id: "m", showsCue: true)))
    #expect(keyboard.redComponent < plain.redComponent - 0.01)
    #expect(abs(keyboard.redComponent - keyboard.blueComponent) < 0.01)
}

@Test func keyboardHighlightIsFainterThanSelectionInBothAppearances() {
    for name in [NSAppearance.Name.aqua, .darkAqua] {
        NSAppearance(named: name)?.performAsCurrentDrawingAppearance {
            let fill = NSColor(Theme.keyboardHighlight).usingColorSpace(.sRGB)
            let selection = NSColor(Theme.selected).usingColorSpace(.sRGB)
            #expect((fill?.alphaComponent ?? 1) > 0)
            #expect((fill?.alphaComponent ?? 1) < (selection?.alphaComponent ?? 0))
            #expect(fill.map { abs($0.redComponent - $0.blueComponent) < 0.01 } == true, "neutral, never the accent")
        }
    }
}

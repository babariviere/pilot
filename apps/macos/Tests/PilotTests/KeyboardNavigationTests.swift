import AppKit
import PilotCore
import SwiftUI
import Testing
import WebKit
@testable import Pilot

private func chord(_ characters: String, _ modifiers: NSEvent.ModifierFlags = [], keyCode: UInt16 = 0) -> KeyboardChord {
    KeyboardChord(characters: characters, keyCode: keyCode, modifiers: modifiers)
}

private let controlTab = chord("\t", .control, keyCode: KeyboardChord.tabKeyCode)

@Test func reservedRegionAndComposerKeysWorkEverywhere() {
    for context in [KeyboardInputContext.navigation, .text, .embedded] {
        #expect(KeyboardRoute.decide(controlTab, context: context, pending: false) == .focusNextRegion)
        #expect(KeyboardRoute.decide(chord("\t", [.control, .shift], keyCode: 48), context: context, pending: false)
            == .focusPreviousRegion)
        #expect(KeyboardRoute.decide(chord("l", .command), context: context, pending: false) == .focusComposer)
    }
    // Plain Tab and Shift-Tab keep moving between controls.
    #expect(KeyboardRoute.decide(chord("\t", keyCode: 48), context: .navigation, pending: false) == .pass)
    #expect(KeyboardRoute.decide(chord("\t", .shift, keyCode: 48), context: .text, pending: false) == .pass)
}

@Test func embeddedContentKeepsEveryOtherKey() {
    #expect(KeyboardRoute.decide(chord("k", .command), context: .embedded, pending: false) == .commandPalette)
    #expect(KeyboardRoute.decide(chord("j", .command), context: .embedded, pending: false) == .toggleTerminal)
    for key in [chord("c", .control), chord("d", .control), chord("g"), chord("j"), chord("?", .shift),
                chord("\u{1b}", keyCode: KeyboardChord.escapeKeyCode), chord("w", .command)] {
        #expect(KeyboardRoute.decide(key, context: .embedded, pending: false) == .pass)
    }
}

@Test func plainLettersNavigateOnlyOutsideText() {
    #expect(KeyboardRoute.decide(chord("g"), context: .navigation, pending: false) == .beginSequence)
    #expect(KeyboardRoute.decide(chord("j"), context: .navigation, pending: false) == .move(down: true))
    #expect(KeyboardRoute.decide(chord("K", .shift), context: .navigation, pending: false) == .pass)
    #expect(KeyboardRoute.decide(chord("k"), context: .navigation, pending: false) == .move(down: false))
    #expect(KeyboardRoute.decide(chord("?", .shift), context: .navigation, pending: false) == .showShortcuts)
    for key in [chord("g"), chord("j"), chord("k"), chord("?", .shift)] {
        #expect(KeyboardRoute.decide(key, context: .text, pending: false) == .pass)
    }
    #expect(KeyboardRoute.decide(chord("g", .command), context: .navigation, pending: false) == .pass)
}

@Test func sequencesTakeOneLetterAndNeverReachEditors() {
    #expect(KeyboardRoute.decide(chord("h"), context: .navigation, pending: true) == .go("h"))
    #expect(KeyboardRoute.decide(chord("H"), context: .navigation, pending: true) == .go("h"))
    #expect(KeyboardRoute.decide(chord("\u{1b}", keyCode: KeyboardChord.escapeKeyCode), context: .navigation,
                                 pending: true) == .cancelSequence(deliver: false))
    #expect(KeyboardRoute.decide(chord("1"), context: .navigation, pending: true) == .cancelSequence(deliver: true))
    // Focus moved into an editor after G: the letter is text, delivered once.
    #expect(KeyboardRoute.decide(chord("h"), context: .text, pending: true) == .cancelSequence(deliver: true))
    #expect(GoDestination(key: "h") == .home && GoDestination(key: "T") == .tasks && GoDestination(key: "z") == nil)
    #expect(Set(GoDestination.allCases.map(\.key)).count == GoDestination.allCases.count)
}

@Test func everyGoDestinationRoundTripsThroughItsKey() {
    for destination in GoDestination.allCases {
        #expect(GoDestination(key: destination.key) == destination)
        #expect(GoDestination(key: Character(destination.key.uppercased())) == destination)
    }
    #expect(GoDestination(key: "c") == .control)
    #expect(GoDestination.control.title == "Control")
    #expect(GoDestination.control.keys == "G then C")
}

@MainActor
private func makeWindow() -> NSWindow {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    return window
}

@Test @MainActor func inputGuardReadsTheAppKitFirstResponder() throws {
    let window = makeWindow()
    defer { window.close() }
    let root = try #require(window.contentView)
    let editor = NSTextView(frame: NSRect(x: 0, y: 0, width: 200, height: 40))
    let label = NSTextView(frame: NSRect(x: 0, y: 50, width: 200, height: 40))
    label.isEditable = false
    let field = NSTextField(frame: NSRect(x: 0, y: 100, width: 200, height: 24))
    let web = WKWebView(frame: NSRect(x: 300, y: 0, width: 300, height: 300))
    let inner = NSView(frame: NSRect(x: 0, y: 0, width: 10, height: 10))
    web.addSubview(inner)
    for view in [editor, label, field, web] as [NSView] { root.addSubview(view) }

    #expect(window.makeFirstResponder(editor))
    #expect(KeyboardInputGuard.context(for: window.firstResponder) == .text)
    #expect(window.makeFirstResponder(label))
    #expect(KeyboardInputGuard.context(for: window.firstResponder) == .navigation)
    // A focused text field edits through the window's field editor.
    #expect(window.makeFirstResponder(field))
    #expect(KeyboardInputGuard.context(for: window.firstResponder) == .text)
    #expect(KeyboardInputGuard.context(for: inner) == .embedded)
    #expect(KeyboardInputGuard.context(for: web) == .embedded)
    #expect(KeyboardInputGuard.context(for: nil) == .navigation)
    // Marked text (IME composition) is text even in a view that is otherwise not editable.
    editor.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0),
                         replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(editor.hasMarkedText())
    #expect(KeyboardInputGuard.context(for: editor) == .text)
}

@MainActor
private final class RegionFixture {
    let window = makeWindow()
    let focus = KeyboardFocus()
    var editors: [KeyboardRegion: NSTextView] = [:]
    var anchors: [KeyboardRegion: KeyboardRegionAnchor.AnchorView] = [:]

    /// Sidebar on the left, the page on the right with the composer at its bottom, as in the main window.
    init(regions: [KeyboardRegion] = [.sidebar, .content, .composer]) {
        let frames: [KeyboardRegion: NSRect] = [
            .sidebar: NSRect(x: 0, y: 0, width: 200, height: 600),
            .content: NSRect(x: 200, y: 0, width: 500, height: 600),
            .composer: NSRect(x: 220, y: 10, width: 460, height: 100),
            .inspector: NSRect(x: 700, y: 0, width: 200, height: 600),
        ]
        let root = window.contentView!
        for region in regions {
            let frame = frames[region]!
            let anchor = KeyboardRegionAnchor.AnchorView(frame: frame)
            anchor.region = region
            anchor.focus = focus
            root.addSubview(anchor)
            anchors[region] = anchor
            let editor = NSTextView(frame: NSRect(x: frame.minX + 10, y: frame.maxY - 60, width: 100, height: 40))
            root.addSubview(editor)
            editors[region] = editor
        }
    }

    var responderRegion: KeyboardRegion? {
        editors.first { $0.value === window.firstResponder }?.key
    }
}

@Test @MainActor func regionsCycleInOrderSkippingAbsentOnes() throws {
    let fixture = RegionFixture()
    defer { fixture.window.close() }
    #expect(fixture.focus.visibleRegions == [.sidebar, .content, .composer])
    #expect(fixture.focus.cycle(forward: true))
    #expect(fixture.responderRegion == .sidebar)
    #expect(fixture.focus.currentRegion() == .sidebar)
    #expect(fixture.focus.cycle(forward: true))
    #expect(fixture.responderRegion == .content, "the page's own view, not the composer inside it")
    #expect(fixture.focus.cycle(forward: true))
    #expect(fixture.responderRegion == .composer)
    #expect(fixture.focus.currentRegion() == .composer)
    #expect(fixture.focus.cycle(forward: true))
    #expect(fixture.responderRegion == .sidebar, "wraps around")
    #expect(fixture.focus.cycle(forward: false))
    #expect(fixture.responderRegion == .composer)

    // A hidden region is skipped.
    fixture.anchors[.content]?.isHidden = true
    #expect(fixture.focus.visibleRegions == [.sidebar, .composer])
    #expect(fixture.focus.cycle(forward: true))
    #expect(fixture.responderRegion == .sidebar)
}

@Test @MainActor func regionHandlersRunBeforeTheNativeFallback() throws {
    let fixture = RegionFixture()
    defer { fixture.window.close() }
    var asked = 0
    let id = UUID()
    fixture.focus.addHandler(id, for: .composer) {
        asked += 1
        return fixture.window.makeFirstResponder(fixture.editors[.composer])
    }
    #expect(fixture.focus.focus(.composer))
    #expect(asked == 1)
    #expect(fixture.responderRegion == .composer)
    // A handler that cannot take focus leaves the region's first key view to do so.
    fixture.focus.removeHandler(id)
    fixture.focus.addHandler(UUID(), for: .sidebar) { false }
    #expect(fixture.focus.focus(.sidebar))
    #expect(fixture.responderRegion == .sidebar)
    // No region on screen: nothing to focus, nothing changes.
    #expect(!fixture.focus.focus(.inspector))
    #expect(fixture.responderRegion == .sidebar)
}

private func keyEvent(_ characters: String, keyCode: UInt16, modifiers: NSEvent.ModifierFlags = [],
                      window: NSWindow) -> NSEvent? {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
                     windowNumber: window.windowNumber, context: nil, characters: characters,
                     charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode)
}

@Test @MainActor func routerConsumesReservedKeysAndLeavesTypingToTheEditor() throws {
    let fixture = RegionFixture()
    defer { fixture.window.close() }
    let window = fixture.window
    let router = KeyboardRouter()
    var routes: [KeyboardRoute] = []
    router.focus = fixture.focus
    router.perform = { route in
        routes.append(route)
        return true
    }
    let composer = try #require(fixture.editors[.composer])
    #expect(window.makeFirstResponder(composer))

    // Typing in the composer: letters reach the editor untouched, and no sequence starts.
    let g = try #require(keyEvent("g", keyCode: 5, window: window))
    #expect(router.handle(g) === g)
    #expect(!fixture.focus.sequenceIsPending)
    #expect(routes.isEmpty)
    // Ctrl-Tab is reserved even while editing.
    let tab = try #require(keyEvent("\t", keyCode: 48, modifiers: .control, window: window))
    #expect(router.handle(tab) == nil)
    #expect(routes == [.focusNextRegion])

    // Browsing: G then H goes Home without either letter reaching the view.
    let list = NSTableView(frame: NSRect(x: 0, y: 300, width: 150, height: 200))
    window.contentView?.addSubview(list)
    #expect(window.makeFirstResponder(list))
    #expect(router.handle(g) == nil)
    #expect(fixture.focus.sequenceIsPending)
    #expect(fixture.focus.pendingSequence)
    let h = try #require(keyEvent("h", keyCode: 4, window: window))
    #expect(router.handle(h) == nil)
    #expect(routes.last == .go("h"))
    #expect(!fixture.focus.pendingSequence)
    // J becomes a Down arrow for the focused list.
    let j = try #require(keyEvent("j", keyCode: 38, window: window))
    let arrow = try #require(router.handle(j))
    #expect(arrow.keyCode == 125)
    #expect(arrow.charactersIgnoringModifiers == "\u{f701}")

    // Other windows, such as Settings or the shortcut reference, keep their own keys.
    let other = makeWindow()
    defer { other.close() }
    let elsewhere = try #require(keyEvent("\t", keyCode: 48, modifiers: .control, window: other))
    #expect(router.handle(elsewhere) === elsewhere)
    #expect(routes.count == 2)
}

@Test @MainActor func goDestinationsNeverGuessAProjectOrMission() {
    let defaults = UserDefaults(suiteName: "keyboard-go-\(UUID().uuidString)")!
    let model = AppModel(projectFolderDefaults: defaults)
    let project = Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)
    model.client.loadFixture(projects: [project], sessions: [
        SessionSummary(id: "a", title: "a", cwd: "/tmp", projectId: "p1", createdAt: 1, updatedAt: 2, state: "idle"),
    ])
    model.selectedSessionId = "a"
    #expect(!model.canGo(to: .overview))
    #expect(!model.canGo(to: .tasks))
    model.go(to: .overview)
    model.go(to: .brief)
    #expect(model.selectedSessionId == "a")
    #expect(model.performKeyboardRoute(.go("i")))
    #expect(model.showingInbox && model.selectedSessionId == nil)
    model.go(to: .archive)
    #expect(model.showingArchive && !model.showingInbox)
    model.focus(on: "p1")
    #expect(model.canGo(to: .overview))
    model.go(to: .overview)
    #expect(model.selectedProjectId == "p1")
    model.go(to: .home)
    #expect(model.currentSelection == .home)
    // Unknown letters do nothing but are still consumed, so they never type into a list.
    #expect(model.performKeyboardRoute(.go("z")))
    #expect(model.currentSelection == .home)
    // No terminal without an open Build chat.
    #expect(!model.performKeyboardRoute(.toggleTerminal))
}

@Test @MainActor func goToControlNeedsTheControlChatAndWidensAProjectScope() {
    let defaults = UserDefaults(suiteName: "keyboard-go-control-\(UUID().uuidString)")!
    let model = AppModel(projectFolderDefaults: defaults)
    let project = Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)
    let chat = SessionSummary(id: "a", title: "a", cwd: "/tmp", projectId: "p1", createdAt: 1, updatedAt: 2, state: "idle")
    model.client.loadFixture(projects: [project], sessions: [chat])
    model.selectedSessionId = "a"
    #expect(!model.canGo(to: .control))
    #expect(model.performKeyboardRoute(.go("c")))
    #expect(model.selectedSessionId == "a")

    var control = SessionSummary(id: "ctl", title: "Control", cwd: "", createdAt: 1, updatedAt: 3, state: "idle",
                                 mode: .ask, pinned: true)
    control.control = true
    model.client.loadFixture(projects: [project], sessions: [chat, control])
    model.focus(on: "p1")
    #expect(model.sidebarScope == "p1")
    #expect(model.canGo(to: .control))
    #expect(model.performKeyboardRoute(.go("c")))
    #expect(model.selectedSessionId == "ctl")
    #expect(model.sidebarScope == nil)
}

@Test func shortcutReferenceListsRegionAndGoKeys() {
    let keys = Dictionary(uniqueKeysWithValues: KeyboardShortcuts.groups.flatMap(\.entries).map { ($0.title, $0.keys) })
    #expect(keys["Focus next region"] == "⌃⇥")
    #expect(keys["Focus previous region"] == "⌃⇧⇥")
    #expect(keys["Focus composer or question"] == "⌘L")
    #expect(keys["Home"] == "G then H")
    #expect(keys["Mission Tasks"] == "G then T")
    #expect(!keys.values.contains { $0.contains("F6") || $0.contains("fn") })
}

@Test @MainActor func paletteLabelsActionsForTheHighlightedChatOnly() throws {
    let defaults = UserDefaults(suiteName: "keyboard-target-\(UUID().uuidString)")!
    let model = AppModel(projectFolderDefaults: defaults)
    model.client.loadFixture(projects: [], sessions: [
        SessionSummary(id: "open", title: "Open chat", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "idle"),
        SessionSummary(id: "row", title: "Highlighted chat", cwd: "/tmp", createdAt: 1, updatedAt: 3, state: "idle"),
    ])
    model.selectedSessionId = "open"
    let catalog = CommandPaletteCatalog(model: model, openSettings: {}, openKeyboardShortcuts: {})
    #expect(catalog.targetActions() == nil)
    model.keyboardTarget = .session(id: "row", reference: nil)
    let target = try #require(catalog.targetActions())
    #expect(target.title == "Highlighted: Highlighted chat")
    #expect(target.entries.contains { $0.item.title == "Pin" })
    #expect(target.entries.allSatisfy { $0.item.id.hasPrefix("target:") })
    // The open chat's actions are listed already; no second group.
    model.keyboardTarget = .session(id: "open", reference: nil)
    #expect(catalog.targetActions() == nil)
    // A chat that went away has no actions.
    model.keyboardTarget = .session(id: "gone", reference: nil)
    #expect(catalog.targetActions() == nil)
}

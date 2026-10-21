import AppKit
import PilotCore
import SwiftUI
import Testing
import WebKit
@testable import Pilot

private func chord(_ characters: String, _ modifiers: NSEvent.ModifierFlags = [], keyCode: UInt16 = 0) -> KeyboardChord {
    KeyboardChord(characters: characters, keyCode: keyCode, modifiers: modifiers)
}

@Test func composerKeyWorksEverywhereAndControlTabIsNotReserved() {
    for context in [KeyboardInputContext.navigation, .text, .embedded] {
        // ⌃⇥ and ⌃⇧⇥ reach the focused view (a terminal, web content, or AppKit's own key view loop).
        #expect(KeyboardRoute.decide(chord("\t", .control, keyCode: 48), context: context) == .pass)
        #expect(KeyboardRoute.decide(chord("\t", [.control, .shift], keyCode: 48), context: context) == .pass)
        #expect(KeyboardRoute.decide(chord("l", .command), context: context) == .focusComposer)
    }
    // Plain Tab and Shift-Tab keep moving between controls.
    #expect(KeyboardRoute.decide(chord("\t", keyCode: 48), context: .navigation) == .pass)
    #expect(KeyboardRoute.decide(chord("\t", .shift, keyCode: 48), context: .text) == .pass)
}

@Test func embeddedContentKeepsEveryOtherKey() {
    #expect(KeyboardRoute.decide(chord("k", .command), context: .embedded) == .commandPalette)
    #expect(KeyboardRoute.decide(chord("j", .command), context: .embedded) == .toggleTerminal)
    for key in [chord("c", .control), chord("d", .control), chord("g"), chord("j"), chord("?", .shift),
                chord("\u{1b}", keyCode: KeyboardChord.escapeKeyCode), chord("w", .command)] {
        #expect(KeyboardRoute.decide(key, context: .embedded) == .pass)
    }
}

/// No Vim-style keys: unmodified letters, digits and punctuation reach the focused view in every context, including
/// the former G, J, K, ?, E, T, L and D, so typing, IME and type-select are never intercepted.
@Test func plainKeysAlwaysReachTheFocusedView() {
    let letters = "abcdefghijklmnopqrstuvwxyz".map { chord(String($0)) }
    let others = [chord("1"), chord("0"), chord("/"), chord("?", .shift), chord("G", .shift), chord("K", .shift),
                  chord("j", .option), chord("\u{1b}", keyCode: KeyboardChord.escapeKeyCode), chord("\r", keyCode: 36),
                  chord("\u{f701}", keyCode: 125), chord("\u{f700}", keyCode: 126), chord("\t", keyCode: 48)]
    for context in [KeyboardInputContext.navigation, .text, .embedded] {
        for key in letters + others {
            #expect(KeyboardRoute.decide(key, context: context) == .pass, "\(key.characters) in \(context)")
        }
    }
    // Menu shortcuts stay menu key equivalents, not routes read before the focused view.
    for key in [chord("g", .command), chord("k", .command), chord("j", .command), chord("?", [.command, .shift])] {
        #expect(KeyboardRoute.decide(key, context: .navigation) == .pass)
    }
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

@Test @MainActor func regionsFocusTheirOwnViewsSkippingAbsentOnes() throws {
    let fixture = RegionFixture()
    defer { fixture.window.close() }
    #expect(fixture.focus.visibleRegions == [.sidebar, .content, .composer])
    #expect(fixture.focus.focus(.sidebar))
    #expect(fixture.responderRegion == .sidebar)
    #expect(fixture.focus.currentRegion() == .sidebar)
    #expect(fixture.focus.focus(.content))
    #expect(fixture.responderRegion == .content, "the page's own view, not the composer inside it")
    #expect(fixture.focus.focus(.composer))
    #expect(fixture.responderRegion == .composer)
    #expect(fixture.focus.currentRegion() == .composer)

    // A hidden region cannot take focus.
    fixture.anchors[.content]?.isHidden = true
    #expect(fixture.focus.visibleRegions == [.sidebar, .composer])
    #expect(!fixture.focus.focus(.content))
    #expect(fixture.responderRegion == .composer)
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

    // Typing in the composer: letters reach the editor untouched.
    let g = try #require(keyEvent("g", keyCode: 5, window: window))
    #expect(router.handle(g) === g)
    #expect(routes.isEmpty)
    // ⌃⇥ is not reserved: the editor (or AppKit's key view loop) gets it.
    let tab = try #require(keyEvent("\t", keyCode: 48, modifiers: .control, window: window))
    #expect(router.handle(tab) === tab)
    // ⌘L is reserved even while editing.
    let commandL = try #require(keyEvent("l", keyCode: 37, modifiers: .command, window: window))
    #expect(router.handle(commandL) == nil)
    #expect(routes == [.focusComposer])

    // Browsing a list: letters still reach it unchanged (type-select, VoiceOver), and nothing waits for a second key.
    let list = NSTableView(frame: NSRect(x: 0, y: 300, width: 150, height: 200))
    window.contentView?.addSubview(list)
    #expect(window.makeFirstResponder(list))
    for (letter, code) in [("g", UInt16(5)), ("h", 4), ("j", 38), ("k", 40), ("e", 14), ("t", 17), ("d", 2)] {
        let event = try #require(keyEvent(letter, keyCode: code, window: window))
        #expect(router.handle(event) === event, "\(letter) reaches the list")
    }
    let question = try #require(keyEvent("?", keyCode: 44, modifiers: .shift, window: window))
    #expect(router.handle(question) === question)
    // Arrows and Return are the list's own, delivered unchanged.
    let down = try #require(keyEvent("\u{f701}", keyCode: 125, modifiers: [.function, .numericPad], window: window))
    #expect(router.handle(down) === down)
    #expect(routes == [.focusComposer])

    // Other windows, such as Settings or the shortcut reference, keep their own keys.
    let other = makeWindow()
    defer { other.close() }
    let elsewhere = try #require(keyEvent("l", keyCode: 37, modifiers: .command, window: other))
    #expect(router.handle(elsewhere) === elsewhere)
    #expect(routes.count == 1)
}

@Test @MainActor func goMenuDestinationsNeverGuessAProjectOrMission() {
    let defaults = UserDefaults(suiteName: "keyboard-go-\(UUID().uuidString)")!
    let model = AppModel(projectFolderDefaults: defaults)
    let project = Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)
    model.client.loadFixture(projects: [project], sessions: [
        SessionSummary(id: "a", title: "a", cwd: "/tmp", projectId: "p1", createdAt: 1, updatedAt: 2, state: "idle"),
        SessionSummary(id: "mission-chat", title: "mission chat", cwd: "/tmp", projectId: "p1",
                       createdAt: 1, updatedAt: 3, state: "idle", missionId: "m1"),
    ])
    model.selectedSessionId = "a"
    #expect(!model.canGo(to: .overview))
    #expect(!model.canGo(to: .tasks))
    #expect(GoDestination.allCases.filter(model.canGo(to:)) == [.home, .inbox, .archive, .slack, .linear])
    model.go(to: .overview)
    model.go(to: .brief)
    #expect(model.selectedSessionId == "a")
    model.go(to: .inbox)
    #expect(model.showingInbox && model.selectedSessionId == nil)
    model.go(to: .archive)
    #expect(model.showingArchive && !model.showingInbox)
    model.focus(on: "p1")
    #expect(model.canGo(to: .overview))
    #expect(!model.canGo(to: .mission))
    model.go(to: .overview)
    #expect(model.selectedProjectId == "p1")
    model.openMission("m1")
    #expect(model.canGo(to: .mission))
    #expect(model.canGo(to: .tasks))
    #expect(model.canGo(to: .brief))
    model.selectedMissionId = nil
    model.selectedSessionId = "mission-chat"
    #expect(model.currentMissionId == "m1")
    #expect(model.canGo(to: .mission))
    model.selectedSessionId = "a"
    #expect(!model.canGo(to: .mission), "changing to a non-mission chat drops the prior target")
    model.go(to: .home)
    #expect(model.currentSelection == .home)
    #expect(!model.canGo(to: .mission))
    #expect(model.canGo(to: .overview), "Home retains the focused project scope for project Overview")
    model.go(to: .mission)
    #expect(model.currentSelection == .home, "a destination that disappeared with the context stays harmless")
    // No terminal without an open Build chat.
    #expect(!model.performKeyboardRoute(.toggleTerminal))
}

@Test @MainActor func goToControlIsUnavailableEvenWithLegacyInventory() {
    let defaults = UserDefaults(suiteName: "keyboard-go-control-\(UUID().uuidString)")!
    let model = AppModel(projectFolderDefaults: defaults)
    let project = Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)
    let chat = SessionSummary(id: "a", title: "a", cwd: "/tmp", projectId: "p1", createdAt: 1, updatedAt: 2, state: "idle")
    model.client.loadFixture(projects: [project], sessions: [chat])
    model.selectedSessionId = "a"
    #expect(!model.canGo(to: .control))
    model.go(to: .control)
    #expect(model.selectedSessionId == "a")

    var control = SessionSummary(id: "ctl", title: "Control", cwd: "", createdAt: 1, updatedAt: 3, state: "idle",
                                 mode: .ask, pinned: true)
    control.control = true
    model.client.loadFixture(projects: [project], sessions: [chat, control])
    model.focus(on: "p1")
    #expect(model.sidebarScope == "p1")
    #expect(!model.canGo(to: .control))
    model.go(to: .control)
    #expect(model.selectedSessionId != "ctl")
    #expect(model.sidebarScope == "p1")
}

@Test func shortcutReferenceListsFocusKeysAndNoLetterShortcuts() {
    let keys = Dictionary(uniqueKeysWithValues: KeyboardShortcuts.groups.flatMap(\.entries).map { ($0.title, $0.keys) })
    #expect(keys["Focus next region"] == nil && keys["Focus previous region"] == nil)
    #expect(!KeyboardShortcuts.groups.flatMap(\.entries).contains { $0.keys.contains("⌃⇥") })
    #expect(keys["Focus composer or question"] == "⌘L")
    #expect(keys["Focus the sidebar, page or inspector"] == "⌘K, then Focus…")
    #expect(keys["Open command palette"] == "⌘K")
    #expect(keys["Back"] == "⌘←" && keys["Forward"] == "⌘→")
    #expect(keys["Open latest pull request"] == "⇧⌘P")
    #expect(keys["Confirm merge of latest open pull request"] == "⇧⌘M")
    #expect(keys["Open a control: /model, /mode, /terminal, /changes, /artifacts, /help"] == "/ then ↩")
    #expect(!keys.values.contains { $0.contains("F6") || $0.contains("fn") })
    // No G sequences, J/K, bare ? or single-letter row actions.
    #expect(!keys.values.contains { $0.contains("G then") || $0.contains("J / K") })
    func hasBareLetter(_ keys: String) -> Bool {
        let characters = Array(keys)
        return characters.indices.contains { index in
            guard characters[index].isUppercase else { return false }
            let before = index > 0 ? characters[index - 1] : " "
            let after = index + 1 < characters.count ? characters[index + 1] : " "
            return !"⌘⌃⌥⇧".contains(before) && !before.isLetter && !after.isLetter
        }
    }
    #expect(!keys.values.contains { $0 == "?" || hasBareLetter($0) }, "\(keys.values.sorted())")
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

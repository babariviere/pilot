import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@MainActor
private func items(_ ids: [String], opened: @escaping (String) -> Void = { _ in }) -> [KeyboardListItem] {
    ids.map { id in KeyboardListItem(id: id, target: nil) { opened(id) } }
}

@Test @MainActor func highlightFollowsItsRowByIdAcrossRefreshes() {
    let list = KeyboardListState()
    list.update(items(["a", "b", "c"]))
    #expect(list.highlighted == nil, "nothing is highlighted until the list is used")
    list.move(by: 1)
    #expect(list.highlighted == "a")
    list.move(by: 1)
    #expect(list.highlighted == "b")
    // A new row above, as when a chat starts working: the highlight stays on b.
    list.update(items(["new", "a", "b", "c"]))
    #expect(list.highlighted == "b")
    // b leaves: the row now at its place takes the highlight, and nothing runs.
    var opened: [String] = []
    list.update(items(["new", "a", "c"]) { opened.append($0) })
    #expect(list.highlighted == "c")
    #expect(opened.isEmpty)
    // The last row leaves: the new last row.
    list.update(items(["new", "a"]))
    #expect(list.highlighted == "a")
    list.update([])
    #expect(list.highlighted == nil)
}

@Test @MainActor func movementStopsAtTheEndsAndReturnOpensTheHighlightedRow() {
    let list = KeyboardListState()
    var opened: [String] = []
    list.update(items(["a", "b", "a", "c"]) { opened.append($0) })
    #expect(list.items.map(\.id) == ["a", "b", "c"], "duplicates keep their first place")
    list.move(by: -1)
    #expect(list.highlighted == "c", "upward from nothing starts at the end")
    list.move(by: 5)
    #expect(list.highlighted == "c")
    list.moveToEnd(false)
    #expect(list.highlighted == "a")
    list.move(by: -1)
    #expect(list.highlighted == "a")
    list.highlightedItem?.activate()
    #expect(opened == ["a"])
    list.highlighted = "gone"
    list.highlightFirstIfNeeded()
    #expect(list.highlighted == "a")
}

@Test @MainActor func rowsReportThemselvesInViewOrder() throws {
    _ = NSApplication.shared
    let list = KeyboardListState()
    var opened: [String] = []
    let view = ScrollView {
        VStack {
            Text("Header")
            ForEach(["one", "two"], id: \.self) { id in
                Text(id).keyboardListItem(id) { opened.append(id) }
            }
            VStack { Text("three").keyboardListItem("three", target: .session(id: "s3", reference: nil)) { opened.append("three") } }
        }
        .keyboardList(state: list)
    }
    let hosting = NSHostingView(rootView: view)
    hosting.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
    let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = hosting
    for _ in 0..<20 where list.items.count < 3 {
        hosting.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    #expect(list.items.map(\.id) == ["one", "two", "three"])
    #expect(list.items.last?.target == .session(id: "s3", reference: nil))
    list.moveToEnd(true)
    list.highlightedItem?.activate()
    #expect(opened == ["three"])
}

@Test @MainActor func arrowingThroughANativeListKeepsAppearingComposersFromTakingFocus() throws {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.titled],
                          backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    let root = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
    window.contentView = root
    let focus = KeyboardFocus()
    let anchor = KeyboardRegionAnchor.AnchorView(frame: NSRect(x: 0, y: 0, width: 200, height: 400))
    anchor.region = .sidebar
    anchor.focus = focus
    root.addSubview(anchor)
    let table = NSTableView(frame: NSRect(x: 0, y: 0, width: 200, height: 400))
    root.addSubview(table)
    #expect(window.makeFirstResponder(table))
    #expect(!focus.isBrowsingList, "a click into the list is not browsing")

    let router = KeyboardRouter()
    router.focus = focus
    router.perform = { _ in false }
    let down = try #require(NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: [.function, .numericPad], timestamp: 0,
        windowNumber: window.windowNumber, context: nil, characters: "\u{f701}", charactersIgnoringModifiers: "\u{f701}",
        isARepeat: false, keyCode: 125))
    #expect(router.handle(down) === down)
    #expect(focus.isBrowsingList)
    let editor = NSTextView(frame: NSRect(x: 220, y: 0, width: 200, height: 40))
    root.addSubview(editor)
    #expect(window.makeFirstResponder(editor))
    #expect(!focus.isBrowsingList, "once focus moved on, composers may focus again")
}

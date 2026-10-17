import AppKit
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func sidebarSelectionKeepsItsNeutralFillWithoutFocusOutlines() throws {
    func render(selected: Bool, active: Bool = true) throws -> NSBitmapImageRep {
        let renderer = ImageRenderer(content: SidebarSelectionBackground(selected: selected)
            .environment(\.controlActiveState, active ? .active : .inactive)
            .frame(width: 300, height: 40))
        return NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
    }
    func colour(_ bitmap: NSBitmapImageRep, x: Int, y: Int) throws -> NSColor {
        try #require(bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB))
    }

    let quiet = try render(selected: false)
    let selected = try render(selected: true)
    let inactive = try render(selected: true, active: false)
    let plainCentre = try colour(quiet, x: 150, y: 20)
    let centre = try colour(selected, x: 150, y: 20)
    #expect(centre.redComponent < plainCentre.redComponent - 0.04)
    #expect(abs(centre.redComponent - centre.blueComponent) < 0.01)
    #expect(try colour(inactive, x: 150, y: 20) == centre)
    // Selection keeps the same neutral edges regardless of window activity.
    #expect(try colour(inactive, x: 11, y: 20) == colour(selected, x: 11, y: 20))
    // Even beyond the rounded selection, the surface must be opaque to hide the native highlight.
    #expect(try colour(selected, x: 0, y: 0).alphaComponent == 1)
}

@MainActor private final class SidebarSelectionFixture: ObservableObject {
    @Published var selection: String? = "a"
    var focused = false
}

private struct SidebarSelectionTestList: View {
    @ObservedObject var fixture: SidebarSelectionFixture
    @FocusState private var focused: Bool

    var body: some View {
        List(selection: $fixture.selection) {
            ForEach(["a", "b", "c"], id: \.self) { id in
                VStack(alignment: .leading, spacing: 3) {
                    Text("Chat \(id)").font(.pilot(.body)).foregroundStyle(Theme.foreground)
                    Text("Project · Coordinator · Idle").font(.pilot(.small)).foregroundStyle(Theme.blocked)
                }
                .tag(id)
                .listRowBackground(SidebarSelectionBackground(selected: fixture.selection == id)
                    // No blue may remain, even when the native table row is emphasized
                    // (the case that previously drew the solid blue selection).
                    .environment(\.controlActiveState, .inactive))
            }
        }
        .listStyle(.sidebar)
        .focused($focused)
        .focusEffectDisabled()
        .scrollContentBackground(.hidden)
        .background(Theme.sidebar)
        .onChange(of: focused) { _, value in fixture.focused = value }
    }
}

@Test @MainActor func sidebarSelectionCoversNativeBlueWithoutLosingKeyboardNavigation() async throws {
    _ = NSApplication.shared
    let fixture = SidebarSelectionFixture()
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 220),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    let host = NSHostingView(rootView: SidebarSelectionTestList(fixture: fixture))
    window.contentView = host
    host.layoutSubtreeIfNeeded()

    func table(in view: NSView) -> NSTableView? {
        if let table = view as? NSTableView { return table }
        return view.subviews.lazy.compactMap { table(in: $0) }.first
    }
    func settle(_ ready: () -> Bool) async -> Bool {
        for _ in 0..<100 {
            host.layoutSubtreeIfNeeded()
            if ready() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return ready()
    }
    #expect(await settle { table(in: host)?.numberOfRows == 3 })
    let table = try #require(table(in: host))
    #expect(window.makeFirstResponder(table))
    #expect(await settle { fixture.focused && table.selectedRow == 0 })
    let down = try #require(NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
        context: nil, characters: String(UnicodeScalar(NSDownArrowFunctionKey)!),
        charactersIgnoringModifiers: String(UnicodeScalar(NSDownArrowFunctionKey)!), isARepeat: false, keyCode: 125))
    table.keyDown(with: down)
    #expect(await settle { fixture.selection == "b" && table.selectedRow == 1 })

    for emphasized in [true, false] {
        table.rowView(atRow: 1, makeIfNecessary: true)?.isEmphasized = emphasized
        host.layoutSubtreeIfNeeded()
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        var bluePixels = 0
        var selectionPixels = 0
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide {
                guard let colour = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                if colour.blueComponent - colour.redComponent > 0.2 { bluePixels += 1 }
                if (0.9..<0.95).contains(colour.redComponent),
                   abs(colour.redComponent - colour.blueComponent) < 0.01 { selectionPixels += 1 }
            }
        }
        #expect(bluePixels == 0)
        #expect(selectionPixels > 1_000)
    }
    #expect(window.makeFirstResponder(nil))
    #expect(await settle { !fixture.focused })
    #expect(fixture.selection == "b")
    // Command-palette/programmatic selection still feeds the same native list binding.
    fixture.selection = "c"
    #expect(await settle { table.selectedRow == 2 })
    fixture.selection = nil
    #expect(await settle { table.selectedRow == -1 })
}

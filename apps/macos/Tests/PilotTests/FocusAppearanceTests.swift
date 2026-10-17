import AppKit
import SwiftUI
import Testing
@testable import Pilot

@Test(arguments: [false, true])
@MainActor func quietFocusSuppressesNativeFieldRingsWithoutDisablingEditing(secure: Bool) async throws {
    _ = NSApplication.shared
    let content = Group {
        if secure { SecureField("Secret", text: .constant("example")) }
        else { TextField("Name", text: .constant("Pilot")) }
    }
    .textFieldStyle(.roundedBorder)
    .padding()
    .quietFocus()
    let host = NSHostingView(rootView: content)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 100),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = host

    func textField(in view: NSView) -> NSTextField? {
        if let field = view as? NSTextField { return field }
        return view.subviews.lazy.compactMap { textField(in: $0) }.first
    }
    for _ in 0..<50 {
        host.layoutSubtreeIfNeeded()
        if textField(in: host) != nil { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    let field = try #require(textField(in: host))
    #expect(field.isEditable)
    #expect(field.isEnabled)
    #expect(window.makeFirstResponder(field), "ring suppression must not disable keyboard focus")
    #expect(field.currentEditor() is NSTextView)
    #expect(field.focusRingType == .none)
}

@Test @MainActor func nativeFocusSuppressionTracksControlsAndDetachesWithItsWindow() {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 120),
                          styleMask: [.titled], backing: .buffered, defer: false)
    let otherWindow = NSWindow(contentRect: window.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    otherWindow.isReleasedWhenClosed = false
    defer { window.close(); otherWindow.close() }
    let field = NSTextField(frame: NSRect(x: 10, y: 10, width: 200, height: 24))
    let otherField = NSTextField(frame: field.frame)
    let secondField = NSTextField(frame: NSRect(x: 10, y: 45, width: 200, height: 24))
    let button = NSButton(title: "Action", target: nil, action: nil)
    let anchor = FocusRingSuppressionView()
    window.contentView?.addSubview(field)
    window.contentView?.addSubview(secondField)
    window.contentView?.addSubview(button)
    window.contentView?.addSubview(anchor)
    otherWindow.contentView?.addSubview(otherField)
    field.focusRingType = .exterior
    otherField.focusRingType = .exterior

    #expect(otherWindow.makeFirstResponder(otherField))
    otherWindow.update()
    #expect(otherField.focusRingType == .exterior, "a scene must not change another window's controls")
    #expect(window.makeFirstResponder(field))
    window.update()
    #expect(field.focusRingType == .none)
    #expect(field.currentEditor() is NSTextView)

    secondField.focusRingType = .exterior
    #expect(window.makeFirstResponder(secondField))
    window.update()
    #expect(secondField.focusRingType == .none, "fields sharing the same native editor must both suppress their rings")
    secondField.focusRingType = .exterior
    window.update()
    #expect(secondField.focusRingType == .none, "a native refresh must not restore a focused control's ring")
    button.focusRingType = .exterior
    #expect(window.makeFirstResponder(button))
    window.update()
    #expect(button.focusRingType == .none)

    anchor.removeFromSuperview()
    #expect(window.makeFirstResponder(nil))
    field.focusRingType = .exterior
    #expect(window.makeFirstResponder(field))
    window.update()
    #expect(field.focusRingType == .exterior, "detaching the scene must remove its observers")
}

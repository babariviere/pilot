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
    #expect(field.focusRingType == .none)
    #expect(field.isEditable)
    #expect(field.isEnabled)
    #expect(window.makeFirstResponder(field), "ring suppression must not disable keyboard focus")
    #expect(field.currentEditor() is NSTextView)
}

import AppKit
import SwiftUI

/// Passive geometry and effective enabled state for mounted native interaction checks.
/// SwiftUI need not create an NSButton. This view never handles input or owns an action.
struct ControlGeometry: NSViewRepresentable {
    let id: String
    @Environment(\.isEnabled) private var enabled

    func makeNSView(context: Context) -> ControlGeometryView {
        let view = ControlGeometryView()
        view.setAccessibilityElement(false)
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: ControlGeometryView, context: Context) {
        view.identifier = NSUserInterfaceItemIdentifier(id)
        view.controlEnabled = enabled
    }
}

class ControlGeometryView: NSView {
    var controlEnabled = false
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

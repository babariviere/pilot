import AppKit
import NativeTestSupport
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func nativeControlsActivateOnlyEnabledProductionActions() async throws {
    _ = NSApplication.shared
    var clicks = 0
    let host = NSHostingView(rootView: VStack {
        Button("Probe bordered") { clicks += 1 }.buttonStyle(.bordered)
            .background(ControlGeometry(id: "bordered"))
        Button("Probe row") { clicks += 1 }.buttonStyle(RowButtonStyle())
            .background(ControlGeometry(id: "row"))
        Button("Disabled") { clicks += 100 }.background(ControlGeometry(id: "disabled")).disabled(true)
    }.frame(width: 400, height: 200))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200),
        styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    window.orderFrontRegardless(); host.layoutSubtreeIfNeeded(); window.update()
    defer { window.close() }
    try await Task.sleep(for: .milliseconds(100))
    let controls = NativeInput.views(in: host, of: ControlGeometryView.self)
    try #require(controls.count == 3)
    for control in controls {
        #expect(control.controlEnabled == (control.identifier?.rawValue != "disabled"))
        try await NativeInput.click(control)
    }
    #expect(clicks == 2)
}

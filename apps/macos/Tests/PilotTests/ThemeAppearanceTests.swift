import AppKit
import SwiftUI
import Testing
@testable import Pilot

private func hex(_ color: Color, in name: NSAppearance.Name) -> UInt32? {
    var value: UInt32?
    NSAppearance(named: name)?.performAsCurrentDrawingAppearance {
        guard let rgb = NSColor(color).usingColorSpace(.sRGB) else { return }
        let r = UInt32((rgb.redComponent * 255).rounded()), g = UInt32((rgb.greenComponent * 255).rounded())
        let b = UInt32((rgb.blueComponent * 255).rounded())
        value = r << 16 | g << 8 | b
    }
    return value
}

@Test func themeTokensResolvePerAppearance() {
    #expect(hex(Theme.background, in: .aqua) == 0xFFFFFF)
    #expect(hex(Theme.background, in: .darkAqua) == 0x1E1E1E)
    #expect(hex(Theme.foreground, in: .aqua) == 0x262626)
    #expect(hex(Theme.foreground, in: .darkAqua) == 0xE8E8E8)
    // Primary actions invert, and their text follows.
    #expect(hex(Theme.primary, in: .darkAqua) == 0xE8E8E8)
    #expect(hex(Theme.onPrimary, in: .darkAqua) == hex(Theme.background, in: .darkAqua))
}

@Test func appKitConversionsKeepTheDynamicColour() {
    // Attributed text built once still follows later appearance changes.
    let converted = Color(nsColor: NSColor(Theme.foreground))
    #expect(hex(converted, in: .aqua) == 0x262626)
    #expect(hex(converted, in: .darkAqua) == 0xE8E8E8)
}

@Test func appearanceModesMapToNativeAppearances() {
    #expect(AppearanceMode.system.nsAppearance == nil)
    #expect(AppearanceMode.light.nsAppearance?.name == .aqua)
    #expect(AppearanceMode.dark.nsAppearance?.name == .darkAqua)
}

import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func inlineArtifactLayoutUsesTheAvailableWidthWhenResized() {
    _ = NSApplication.shared
    for width: CGFloat in [320, 760, 1000, 1200] {
        let view = NSHostingView(rootView: InlineArtifactLayout {
            Color.blue
        }.fixedSize(horizontal: false, vertical: true).frame(width: width))
        view.frame = NSRect(x: 0, y: 0, width: width, height: 900)
        view.layoutSubtreeIfNeeded()
        #expect(view.fittingSize == ArtifactViewerLayout.inlineSize(availableWidth: width))
    }
}

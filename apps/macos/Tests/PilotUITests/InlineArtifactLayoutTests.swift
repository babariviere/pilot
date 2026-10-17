import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func inlineArtifactLayoutKeepsTheReadingColumnWhenResized() {
    _ = NSApplication.shared
    for width: CGFloat in [320, 760, 1000, 1200] {
        var proposed: CGFloat?
        let view = NSHostingView(rootView: InlineArtifactLayout {
            GeometryReader { geometry in Color.blue.onAppear { proposed = geometry.size.width } }
        }.fixedSize(horizontal: false, vertical: true).frame(width: width))
        view.frame = NSRect(x: 0, y: 0, width: width, height: 900)
        view.layoutSubtreeIfNeeded()
        let expected = ArtifactViewerLayout.inlineSize(availableWidth: width)
        #expect(expected.width == min(width, 760))
        #expect(view.fittingSize.height == expected.height)
        // The card's content is laid out at the column width, never wider.
        if let proposed { #expect(proposed == expected.width) }
    }
}

@Test @MainActor func inlineArtifactLayoutHonorsContentInBothDirections() {
    _ = NSApplication.shared
    let view = NSHostingView(rootView: InlineArtifactLayout(contentSize: CGSize(width: 1650, height: 700)) {
        Color.blue
    }.fixedSize(horizontal: false, vertical: true).frame(width: 1800))
    view.frame = NSRect(x: 0, y: 0, width: 1800, height: 1600)
    view.layoutSubtreeIfNeeded()
    #expect(view.fittingSize == CGSize(width: 1800, height: 700))
}

@Test @MainActor func artifactRowsUseTheSameReadableColumnAsText() {
    _ = NSApplication.shared
    let reference = ArtifactReference(id: "column-test", sessionId: "test", title: "Column", revision: 1)
    for width: CGFloat in [320, 760, 1000, 1400] {
        // The offscreen card reserves its viewport without needing a renderer or a daemon.
        let view = NSHostingView(rootView: RowView(row: .artifact(id: "artifact", reference: reference))
            .fixedSize(horizontal: false, vertical: true).frame(width: width))
        view.frame = NSRect(x: 0, y: 0, width: width, height: 900)
        view.layoutSubtreeIfNeeded()
        #expect(view.fittingSize.height == ArtifactViewerLayout.inlineSize(availableWidth: min(width, Theme.column)).height)
    }
}

@Test @MainActor func measuredInlineArtifactLayoutHugsShortContentAtNarrowAndWideWidths() {
    _ = NSApplication.shared
    for width: CGFloat in [320, 760, 1200] {
        for height: CGFloat in [1, 120, 240, 2000] {
            let content = CGSize(width: 240, height: height)
            let view = NSHostingView(rootView: InlineArtifactLayout(contentSize: content) {
                Color.blue
            }.fixedSize(horizontal: false, vertical: true).frame(width: width))
            view.frame = NSRect(x: 0, y: 0, width: width, height: 1800)
            view.layoutSubtreeIfNeeded()
            #expect(view.fittingSize == CGSize(width: width, height: min(720, max(48, height))))
        }
    }
}

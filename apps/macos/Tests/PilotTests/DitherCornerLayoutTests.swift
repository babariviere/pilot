import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func statusCornersStayInsideTheirSurface() throws {
    // Include rows shorter and narrower than the fixed bitmap, plus the larger question tray.
    let surfaces: [(CGSize, Double, CGFloat)] = [
        (CGSize(width: 280, height: 40), 1, Theme.Radius.row),
        (CGSize(width: 60, height: 24), 1, Theme.Radius.row),
        (CGSize(width: 320, height: 80), 2.5, Theme.Radius.tray),
    ]
    let margin: CGFloat = 12
    for (size, extent, radius) in surfaces {
        for outset in [EdgeInsets(), EdgeInsets(top: -3, leading: 0, bottom: -3, trailing: -6)] {
            let maskRenderer = ImageRenderer(content: Color.clear
                .frame(width: size.width, height: size.height)
                .background {
                    RoundedRectangle(cornerRadius: radius).fill(.white).padding(outset)
                }
                .padding(margin))
            let maskImage = try #require(maskRenderer.cgImage)
            let mask = NSBitmapImageRep(cgImage: maskImage)
            for signal in SessionSignal.allCases {
                let renderer = ImageRenderer(content: Color.clear
                    .frame(width: size.width, height: size.height)
                    .ditherCorner(signal, outset: outset, cornerRadius: radius, extent: extent)
                    .padding(margin))
                let image = try #require(renderer.cgImage)
                #expect(image.width == Int(size.width + 2 * margin))
                #expect(image.height == Int(size.height + 2 * margin))
                let pixels = NSBitmapImageRep(cgImage: image)
                var drawn = 0
                var escaped = 0
                for y in 0 ..< image.height {
                    for x in 0 ..< image.width {
                        guard let alpha = pixels.colorAt(x: x, y: y)?.alphaComponent, alpha > 0.02 else { continue }
                        drawn += 1
                        if (mask.colorAt(x: x, y: y)?.alphaComponent ?? 0) < 0.02 { escaped += 1 }
                    }
                }
                #expect(drawn > 0, "The corner must remain visible")
                #expect(escaped == 0, "\(signal), \(size), extent \(extent)")
            }
        }
    }
}

@Test @MainActor func inboxCornersKeepTheRowsOwnBoundsAndFullRestingSize() throws {
    let margin: CGFloat = 12
    for size in [CGSize(width: 280, height: 40), CGSize(width: 60, height: 24), CGSize(width: 400, height: 64)] {
        for scheme in [ColorScheme.light, .dark] {
            for signal in SessionSignal.allCases {
                // Compare the Inbox wrapper with an ordinary, full-sized corner clipped to the row itself.
                // Reduce Motion renders the same resting bitmap without requiring an AppKit animation layer.
                let inbox = ImageRenderer(content: Color.clear.frame(width: size.width, height: size.height)
                    .inboxCorner(signal).padding(margin)
                    .environment(\.accessibilityReduceMotion, true).environment(\.colorScheme, scheme))
                let reference = ImageRenderer(content: Color.clear.frame(width: size.width, height: size.height)
                    .ditherCorner(signal, outset: EdgeInsets()).padding(margin)
                    .environment(\.accessibilityReduceMotion, true).environment(\.colorScheme, scheme))
                let image = try #require(inbox.cgImage)
                let referenceImage = try #require(reference.cgImage)
                try #require(image.width == Int(size.width + 2 * margin), "No padding outside the row")
                try #require(image.height == Int(size.height + 2 * margin))
                let pixels = NSBitmapImageRep(cgImage: image)
                let expected = NSBitmapImageRep(cgImage: referenceImage)
                var different = 0
                var drawn = 0
                var escaped = 0
                for y in 0 ..< image.height {
                    for x in 0 ..< image.width {
                        if pixels.colorAt(x: x, y: y) != expected.colorAt(x: x, y: y) { different += 1 }
                        guard (pixels.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.02 else { continue }
                        drawn += 1
                        if x < Int(margin) || x >= Int(margin + size.width)
                            || y < Int(margin) || y >= Int(margin + size.height) { escaped += 1 }
                    }
                }
                #expect(different == 0, "Inbox corners must not be permanently shrunk or receded")
                #expect(drawn > 0)
                #expect(escaped == 0, "No sidebar outsets on Inbox rows")
            }
        }
    }
}

private struct InboxGutterFixture: View {
    let decorated: Bool
    let highlighted: Bool
    let height: CGFloat

    private var row: some View {
        Button {} label: {
            HoverRow(verticalPadding: 7) { _ in
                InboxRowLabel(title: "") {
                    Color.clear.frame(height: 10)
                } trailing: {
                    // A marker in the actual action slot lets the test measure its trailing inset, without
                    // depending on text rasterization or SF Symbol metrics on a particular macOS release.
                    Color.red.frame(width: 8, height: 8)
                }
            }
        }
        .rowButtonStyle()
        .frame(height: height)
        .keyboardListItem("row", target: .session(id: "row", reference: nil)) {}
        .environment(\.keyboardListHighlight, KeyboardListHighlight(id: highlighted ? "row" : nil))
    }

    var body: some View {
        if decorated { row.inboxCorner(nil) } else { row }
    }
}

@Test @MainActor func inboxGutterStaysInsideSelectionAndDoesNotMoveActionsOnHighlight() throws {
    let width = 280
    let margin = 12
    for height in [40, 64] {
        for decorated in [false, true] {
            for highlighted in [false, true] {
                let renderer = ImageRenderer(content: InboxGutterFixture(decorated: decorated, highlighted: highlighted,
                                                                         height: CGFloat(height))
                    .frame(width: CGFloat(width)).padding(CGFloat(margin)).environment(\.colorScheme, .light))
                let image = try #require(renderer.cgImage)
                #expect(image.width == width + 2 * margin)
                #expect(image.height == height + 2 * margin)
                let pixels = NSBitmapImageRep(cgImage: image)
                var actionRight = 0
                for y in 0 ..< image.height {
                    for x in 0 ..< image.width {
                        guard let color = pixels.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
                              color.alphaComponent > 0.9, color.redComponent > 0.9,
                              color.greenComponent < 0.1, color.blueComponent < 0.1 else { continue }
                        actionRight = max(actionRight, x + 1)
                    }
                }
                // Only 24 pt beyond HoverRow's ordinary 8 pt inset, not a whole bitmap's worth of space.
                #expect(actionRight == margin + width - 8 - (decorated ? 24 : 0))
                let gutter = try #require(pixels.colorAt(x: margin + width - 12, y: margin + height / 2))
                #expect((gutter.alphaComponent > 0.9) == highlighted,
                        "Selection must cover the gutter too; it is not padding outside the button")
            }
        }
    }
}

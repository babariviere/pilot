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
            for signal in [SessionSignal.failed, .readyToMerge] {
                // Compare the Inbox wrapper with an ordinary, full-sized corner clipped to the row itself.
                // Steady states use SwiftUI bitmaps; ImageRenderer cannot capture the moving states' AppKit
                // layers. Their full-sized and receded frames are covered by DitherCornerTests.
                let inbox = ImageRenderer(content: Color.clear.frame(width: size.width, height: size.height)
                    .inboxCorner(signal).padding(margin)
                    .environment(\.colorScheme, scheme))
                let reference = ImageRenderer(content: Color.clear.frame(width: size.width, height: size.height)
                    .ditherCorner(signal, outset: EdgeInsets()).padding(margin)
                    .environment(\.colorScheme, scheme))
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

private final class InboxRowMeasurements {
    var sizes: [String: CGSize] = [:]
}

/// Record actual placement, not a bitmap's inferred colour or an intermediate layout proposal.
private struct InboxRowMeasurement: Layout {
    let name: String
    let measurements: InboxRowMeasurements

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews[0].sizeThatFits(proposal)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        measurements.sizes[name] = bounds.size
        subviews[0].place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(bounds.size))
    }
}

private struct InboxGutterFixture: View {
    let measurements: InboxRowMeasurements
    let decorated: Bool
    let highlighted: Bool
    let height: CGFloat
    var home = false

    private var label: some View {
        HoverRow(verticalPadding: 7) { _ in
            InboxRowMeasurement(name: "content", measurements: measurements) {
                InboxRowLabel(title: "A project") {
                    Text("Metadata").font(.pilot(.caption))
                } trailing: {
                    Color.clear.frame(width: 8, height: 8)
                }
            }
        }
    }

    private var row: some View {
        // Home decorates inside its selection; Inbox decorates outside. Measure the surface whose bounds
        // keyboardListItem uses for its selection, which must include the row's entire trailing gutter.
        InboxRowMeasurement(name: "selection", measurements: measurements) {
            Group {
                if decorated, home { label.inboxCorner(nil) } else { label }
            }
            .frame(height: height)
        }
        .keyboardListItem("row", target: .session(id: "row", reference: nil)) {}
        .environment(\.keyboardListHighlight, KeyboardListHighlight(id: highlighted ? "row" : nil))
    }

    var body: some View {
        if decorated, !home { row.inboxCorner(nil) } else { row }
    }
}

@Test(arguments: [false, true]) @MainActor
func inboxAndHomeGutterStaysInsideSelectionAndDoesNotMoveTrailingContent(home: Bool) throws {
    _ = NSApplication.shared
    let width: CGFloat = 280
    for height in [40.0, 64.0] {
        for decorated in [false, true] {
            for highlighted in [false, true] {
                let measurements = InboxRowMeasurements()
                let hosting = NSHostingView(rootView: InboxGutterFixture(measurements: measurements, decorated: decorated,
                    highlighted: highlighted, height: height, home: home).frame(width: width, height: height))
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                                      styleMask: .borderless, backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                defer { window.close() }
                window.contentView = hosting
                window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
                window.orderFrontRegardless()
                for _ in 0..<4 {
                    hosting.layoutSubtreeIfNeeded()
                    RunLoop.main.run(until: Date().addingTimeInterval(0.01))
                }
                let selection = try #require(measurements.sizes["selection"])
                let content = try #require(measurements.sizes["content"])
                #expect(abs(selection.width - width) < 0.5, "The gutter must remain inside the selection")
                #expect(abs(selection.height - height) < 0.5)
                // Two ordinary 8 pt insets, plus just 24 pt of trailing room on decorated rows. The same
                // content width when highlighted keeps the action/timestamp aligned instead of moving it.
                #expect(abs(content.width - (width - 16 - (decorated ? 24 : 0))) < 0.5)
            }
        }
    }
}

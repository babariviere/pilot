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

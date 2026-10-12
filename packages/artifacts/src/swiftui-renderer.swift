import AppKit
import SwiftUI

/// Measure intrinsic height at a bounded width before allocating a bitmap. A fixed-size or
/// unbounded authored view cannot make the renderer allocate an arbitrarily large image.
private struct ArtifactContentLayout: Layout {
    let maximum: CGSize

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let measured = subviews.first?.sizeThatFits(ProposedViewSize(width: maximum.width, height: nil)) ?? .zero
        func bounded(_ value: CGFloat, _ limit: CGFloat) -> CGFloat {
            value.isFinite ? min(limit, max(1, ceil(value))) : limit
        }
        return CGSize(width: bounded(measured.width, maximum.width), height: bounded(measured.height, maximum.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews {
            subview.place(at: bounds.origin, anchor: .topLeading,
                          proposal: ProposedViewSize(width: bounds.width, height: nil))
        }
    }
}

/// Standalone entry point, compiled together with the agent's ArtifactView.
/// ImageRenderer draws offscreen without screen-recording permission or a visible window.
@main
struct PilotArtifactRenderer {
    @MainActor
    static func main() throws {
        let arguments = CommandLine.arguments
        let width = Double(arguments[1])!
        let height = Double(arguments[2])!
        let view = ArtifactContentLayout(maximum: CGSize(width: width, height: height)) {
            ArtifactView().environment(\.colorScheme, .light)
        }.clipped()
        let renderer = ImageRenderer(content: view)
        renderer.proposedSize = ProposedViewSize(width: width, height: nil)
        renderer.scale = 2
        guard let image = renderer.cgImage else {
            throw NSError(domain: "PilotArtifact", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "SwiftUI could not render ArtifactView"])
        }
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "PilotArtifact", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "SwiftUI could not encode the preview"])
        }
        try data.write(to: URL(fileURLWithPath: arguments[3]))
    }
}

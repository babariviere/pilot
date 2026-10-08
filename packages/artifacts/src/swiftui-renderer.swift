import AppKit
import SwiftUI

/// Standalone entry point, compiled together with the agent's ArtifactView.
/// ImageRenderer draws offscreen without screen-recording permission or a visible window.
@main
struct PilotArtifactRenderer {
    @MainActor
    static func main() throws {
        let arguments = CommandLine.arguments
        let width = Double(arguments[1])!
        let height = Double(arguments[2])!
        let view = ArtifactView()
            .environment(\.colorScheme, .light)
            .frame(width: width, height: height)
            .background(Color(nsColor: .windowBackgroundColor))
        let renderer = ImageRenderer(content: view)
        renderer.proposedSize = ProposedViewSize(width: width, height: height)
        renderer.scale = 1
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

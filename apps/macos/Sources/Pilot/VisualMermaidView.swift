import AppKit
import MermaidRender
import PilotCore
import PilotVisualsKit
import SwiftUI

/// A Mermaid node: the chat's diagram block (native MermaidKit drawing, sized from its natural size and shrunk to the
/// column and 480 pt, with the web renderer when the native one can't read the source faithfully). The model lays
/// the source out with the tree; a tree restored from memory lays it out here, off the main thread, first.
struct VisualMermaidView: View {
    let source: String
    let model: VisualArtifactModel
    @State private var prepared: NativeMermaidLayout??

    private var layout: NativeMermaidLayout?? { model.mermaidLayouts[source] ?? prepared }

    var body: some View {
        Group {
            if let layout {
                InlineDiagramBlock(kind: .mermaid, text: source, native: layout).id(source)
            } else {
                Color.clear.frame(height: InlineDiagramLayout.cachedHeight(kind: .mermaid, source: source) ?? 180)
            }
        }
        .frame(maxWidth: .infinity)
        .task(id: source) {
            guard model.mermaidLayouts[source] == nil else { return }
            let source = source
            let layout = await Task.detached(priority: .userInitiated) { NativeMermaid.layout(source) }.value
            guard !Task.isCancelled else { return }
            model.remember(layout, for: source)
            prepared = .some(layout)
        }
    }
}

/// A Mermaid node drawn once for screenshots: the native drawing at its fitted size, or the source when only the web
/// renderer could draw it.
struct VisualMermaidStill: View {
    let source: String
    let model: VisualArtifactModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if let layout = model.mermaidLayouts[source] ?? NativeMermaid.layout(source),
           let image = MermaidRenderer.image(diagram: layout.diagram, theme: NativeMermaid.theme(dark: colorScheme == .dark)) {
            NativeDiagramFrame(natural: layout.natural) {
                Image(nsImage: image).resizable().interpolation(.high)
            }
        } else {
            CodeBlock(language: "mermaid", text: source)
        }
    }
}

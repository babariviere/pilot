import Foundation

/// Host layout defaults for new and already-saved documents, without changing revisions.
public enum ArtifactPreviewDocument {
    public static func document(_ revision: ArtifactRevision) -> String {
        guard revision.kind == .image || revision.kind == .swiftui else {
            // Saved artifacts predate the centered Mermaid default. Keep this low-specificity
            // and before author styles so intentional custom layouts still take precedence.
            let diagrams = "<style id=\"pilot-artifact-diagram-layout\">:where(.mermaid) > svg{display:block;margin-inline:auto}</style>"
            return ArtifactSandboxPolicy.document(diagrams + revision.html)
        }
        // SwiftUI snapshots represent the renderer's default 800 × 600 logical viewport.
        // Images use intrinsic dimensions. Both shrink proportionally, never enlarge.
        let maxWidth = revision.kind == .swiftui ? "min(100vw,800px)" : "100vw"
        let maxHeight = revision.kind == .swiftui ? "min(100vh,600px)" : "100vh"
        // Important rules override the old full-viewport image CSS in saved revisions.
        let sizing = """
        <style id="pilot-artifact-preview-sizing">
        html,body{margin:0!important;padding:0!important;min-height:100vh!important}
        body{display:grid!important;place-items:center!important}
        img{display:block!important;width:auto!important;height:auto!important;max-width:\(maxWidth)!important;max-height:\(maxHeight)!important;object-fit:contain!important}
        </style>
        """
        return ArtifactSandboxPolicy.document(revision.html + sizing)
    }
}

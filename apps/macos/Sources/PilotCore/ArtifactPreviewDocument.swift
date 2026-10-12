import Foundation

/// Host layout defaults for new and already-saved documents, without changing revisions.
public enum ArtifactPreviewDocument {
    public static func document(_ revision: ArtifactRevision, inline: Bool = false) -> String {
        guard revision.kind == .image || revision.kind == .swiftui else {
            // Saved artifacts predate the centered layout defaults. Keep these low-specificity
            // and before author styles so intentional custom layouts still take precedence.
            return ArtifactSandboxPolicy.document(centeredLayout + revision.html + (inline ? chatLayout : ""))
        }
        // New SwiftUI PNGs carry their logical content size; old snapshots retain their
        // 800 × 600 viewport. Images use intrinsic dimensions. Never enlarge either.
        let maxWidth = revision.kind == .swiftui ? "min(100vw,var(--pilot-image-width,800px))" : "100vw"
        let maxHeight = revision.kind == .swiftui ? "min(100vh,var(--pilot-image-height,600px))" : "100vh"
        // Important rules override the old full-viewport image CSS in saved revisions.
        let sizing = """
        <style id="pilot-artifact-preview-sizing">
        html,body{margin:0!important;padding:0!important;min-height:100vh!important}
        body{display:grid!important;place-items:center!important}
        img{display:block!important;width:auto!important;height:auto!important;max-width:\(maxWidth)!important;max-height:\(maxHeight)!important;object-fit:contain!important}
        </style>
        """
        return ArtifactSandboxPolicy.document(revision.html + sizing + (inline ? chatLayout : ""))
    }

    /// Inline artifacts are content, not a separate page. Override the saved page shell, while
    /// retaining authored backgrounds and layouts inside it. Expanded viewers stay unchanged.
    static let chatLayout = """
    <style id="pilot-artifact-chat-layout">
    html,body{background:transparent!important;margin:0!important;padding:0!important;text-align:left!important}
    body{place-items:start!important}
    :where(.mermaid) > svg{margin-inline:0}
    :where(body, #artifact-root) > :where(*){margin-inline:0}
    </style>
    """

    /// Mirrors the centering defaults in packages/artifacts/src/render.ts. Top-level content
    /// narrower than the viewport (fixed-width cards, charts, SVG and canvas) sits centered.
    static let centeredLayout = "<style id=\"pilot-artifact-diagram-layout\">"
        + ":where(.mermaid) > svg{display:block;margin-inline:auto}"
        + ":where(body, #artifact-root) > :where(*){margin-inline:auto}"
        + ":where(body, #artifact-root) > :where(svg, canvas){display:block}</style>"
}

import Foundation

/// Isolated diagram HTML. The host may read the ready promise and height, but no native bridge is needed.
public enum InlineDiagramDocument {
    public static func document(kind: MarkdownDiagramKind, source: String, expanded: Bool = false) -> String {
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let oversized = source.utf8.count > 512 * 1024
        // Do not embed oversized input. Report the error through the same asynchronous API as render errors.
        let encoded = oversized ? "" : Data(source.utf8).base64EncodedString()
        let library = kind == .mermaid ? " pilot-artifact://library/mermaid" : ""
        let render = kind == .mermaid ? #"""
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.onload = resolve;
          script.onerror = () => reject(new Error('Unable to load the bundled Mermaid library.'));
          script.src = 'pilot-artifact://library/mermaid';
          document.head.appendChild(script);
        });
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          // Protect the entire flowchart config as well as top-level keys from init directives/frontmatter.
          secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart'],
          suppressErrorRendering: true
        });
        const result = await mermaid.render('pilot-inline-diagram', source);
        svg = result.svg;
        // WebKit's HTML serializer omits the xlink declaration on Mermaid links.
        // Supply the namespace in a detached XML wrapper, then serialize only its SVG child.
        if (/<!doctype\b/i.test(svg)) throw new Error('SVG doctypes are not allowed.');
        const wrapped = new DOMParser().parseFromString(
          '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' + svg + '</svg>',
          'image/svg+xml'
        );
        const output = wrapped.documentElement.firstElementChild;
        if (wrapped.getElementsByTagNameNS('*', 'parsererror').length ||
            wrapped.documentElement.children.length !== 1 || !output || output.localName !== 'svg') {
          throw new Error('Invalid Mermaid SVG document.');
        }
        svg = new XMLSerializer().serializeToString(output);
        """# : ""
        return #"""
        <!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-\#(nonce)'\#(library); style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; media-src 'none'">
        <meta http-equiv="x-dns-prefetch-control" content="off">
        <meta name="color-scheme" content="light">
        <style>
        html { background: white; color-scheme: light; }
        body { margin: 0; padding: 12px; background: white; }
        img { display: block; max-width: 100%; height: auto; margin: auto; }
        \#(expanded ? "img { width: 100%; }" : "")
        </style>
        <body><img id="diagram" alt="Diagram">
        <script nonce="\#(nonce)">
        (() => {
          const image = document.getElementById('diagram');
          window.pilotDiagramHeight = () => image.getBoundingClientRect().height + 24;
          const sourceBase64 = '\#(encoded)';
          const oversized = \#(oversized ? "true" : "false");

          function svgImageURL(svg) {
            // Parse only in a detached XML document. Never insert any SVG nodes into the HTML DOM.
            if (/<!doctype\b/i.test(svg)) throw new Error('SVG doctypes are not allowed.');
            const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
            const root = parsed.documentElement;
            if (parsed.doctype || parsed.getElementsByTagNameNS('*', 'parsererror').length ||
                !root || root.localName !== 'svg' ||
                (root.namespaceURI !== null && root.namespaceURI !== 'http://www.w3.org/2000/svg')) {
              throw new Error('Invalid SVG document.');
            }
            // Common Markdown snippets omit xmlns. Normalize the detached root before image serialization.
            if (root.namespaceURI === null) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            // Mermaid often emits width="100%". Images need intrinsic dimensions, not percentages.
            const width = (root.getAttribute('width') || '').trim();
            const height = (root.getAttribute('height') || '').trim();
            const relative = value => !value || value.endsWith('%');
            if (relative(width) || relative(height)) {
              const box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
              if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
                root.setAttribute('width', String(box[2]));
                root.setAttribute('height', String(box[3]));
              } else if (relative(width) && relative(height)) {
                root.setAttribute('width', '640');
                root.setAttribute('height', '360');
                root.setAttribute('viewBox', '0 0 640 360');
              }
            }
            const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(parsed));
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 8192) {
              binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
            }
            // Image-mode SVG disables scripts, event handlers and external resources, including Mermaid output.
            return 'data:image/svg+xml;base64,' + btoa(binary);
          }

          window.pilotDiagramReady = (async () => {
            if (oversized) throw new Error('Diagram source exceeds the 512 KB limit.');
            const source = new TextDecoder('utf-8', { fatal: true }).decode(
              Uint8Array.from(atob(sourceBase64), character => character.charCodeAt(0))
            );
            let svg = source;
            \#(render)
            const url = svgImageURL(svg);
            await new Promise((resolve, reject) => {
              image.onload = resolve;
              image.onerror = () => reject(new Error('Unable to display the diagram image.'));
              image.src = url;
            });
            return { error: null, height: window.pilotDiagramHeight() };
          })().catch(error => ({
            error: error instanceof Error ? error.message : String(error),
            height: window.pilotDiagramHeight()
          }));
        })();
        </script></body>
        """#
    }
}

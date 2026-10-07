# Artifacts

Session-owned, project-indexed images, HTML/JavaScript and React/JSX documents. This package owns preparation,
offline libraries, revision storage and optional agent-side browser previews. It does not run generated
code in Node or grant artifacts native capabilities.

## Authoring

Use `artifact({action: "create", ...})` with `title`, `kind`, `source` and optional `libraries`. For changes, use
`artifact({action: "get", id})`, then `artifact({action: "update", id, ...})` with the complete replacement
document and `expectedRevision`. `artifact({action: "list"})` returns compact summaries for the current
session. Publication results contain pinned references; the transcript also receives a passive
`pilot.artifact` publication entry, including when a tool is invoked through codemode. A sidebar entry
always opens the latest revision.

### Images

Publish a plain PNG, JPEG, GIF or WebP image directly, without authoring HTML:

```js
await tools.artifact({
  action: "create",
  title: "Generated image",
  kind: "image",
  source: "/tmp/generated.png",
});
```

`source` may be an absolute file path, a path relative to the session working directory, or a base64
`data:image/...` URL. Images are limited to 16 MiB decoded and do not use libraries. Remote URLs and
SVG are not accepted for this kind. The tool embeds the image bytes, so saved revisions remain visible
if the original file is removed. Create/update results contain only the pinned reference, not base64.
Get returns the saved data URL. Images fit the inline preview and the larger, screen-sized viewer.

### HTML

Request libraries by name. The runtime injects their scripts before the document, without a CDN:

```js
await tools.artifact({
  action: "create",
  title: "Build times",
  kind: "html",
  libraries: ["echarts"],
  source: `<div id="chart" style="height:320px"></div>
    <script>
      const chart = echarts.init(document.getElementById("chart"));
      chart.setOption({xAxis:{data:["Before","After"]},yAxis:{},
        series:[{type:"bar",data:[120,45]}]});
      window.addEventListener("resize", () => chart.resize());
    </script>`,
});
```

| Library | HTML global | JSX import |
| --- | --- | --- |
| React | `React` | `react` |
| ReactDOM | `ReactDOM` (including `createRoot`) | `react-dom`, `react-dom/client` |
| Mermaid | `mermaid` | `mermaid` |
| ECharts | `echarts` | `echarts` |
| Motion | `motion` | `motion`, `motion/react` |
| D3 (opt-in) | `d3` | `d3` |
| Three.js (opt-in) | `THREE` | `three` |

ReactDOM automatically includes React; their globals share one runtime. CSS, SVG, Canvas,
`requestAnimationFrame` and WebGL can be used directly. Respect reduced-motion preferences. Libraries
are pinned in `package.json`; `artifactLibraries` exposes their versions to the agent. Mermaid's KaTeX
dependency is overridden to a patched release in the root manifest.

Shared CSS uses Pilot's light palette and exposes `--pilot-background`, `--pilot-foreground`,
`--pilot-muted`, `--pilot-muted-foreground`, `--pilot-border`, `--pilot-primary`, and `--pilot-radius`.
Custom artifact styles can override these variables.

### React

Provide one JSX/TSX module exporting a default component. Mounting and JSX compilation are provided:

```js
await tools.artifact({
  action: "create",
  title: "Animated counter",
  kind: "react",
  source: `import {useState} from "react";
    import {motion} from "motion/react";
    export default function Counter() {
      const [count, setCount] = useState(0);
      return <motion.button whileTap={{scale:0.9}} onClick={()=>setCount(count+1)}>
        Count: {count}
      </motion.button>;
    }`,
});
```

Only the imports listed above (plus React's JSX runtime) are accepted in generated source. No relative
files, package installs, CDN imports, Tailwind, or arbitrary npm modules. Use inline styles or a `<style>`
element for custom CSS. For HTML images, use embedded data URLs. Artifact revisions save the source
and prepared HTML, not temporary workspace files.

## Verification

`artifact({action: "preview", ...})` renders a draft without saving it, returning PNG image content,
console messages and content height. When using codemode, display the structured `screenshot` with
`image`, not `text`.

Install Chromium once with `npm run artifacts:browser`. Installation is never triggered by a model tool.
For an installed release app without npm, run its bundled Node explicitly:

```sh
runtime="/Applications/Pilot.app/Contents/Resources/runtime"
"$runtime/node/bin/node" "$runtime/node_modules/playwright/cli.js" install chromium
```

This optional, user-triggered installation uses the user's browser cache, not the signed app bundle.
Browser previews use a fresh profile and an in-memory resource handler that denies external requests.
Runtime messages are bounded, viewport dimensions are limited, and previews time out. Animated pages
are sampled shortly after loading; a screenshot is not proof of every interactive state.

## Storage and security

Files live at `$PILOT_HOME/sessions/<sessionId>/artifacts/<artifactId>/`. Numbered JSON revisions are
immutable after publication; an atomic `latest.json` points to the latest committed one. The session's
single worker serializes writes. Unpublished files left by a crash are not exposed. Native tools remain
replay-unsafe, so a crash after publication can leave an artifact with an interrupted tool result.

The app uses an isolated nonpersistent WebKit view, a restrictive CSP, a fail-closed request blocker and
a read-only allowlisted library scheme handler. Network, app origins, filesystem access, native message
handlers, frames, popups, forms, workers and permission dialogs are unavailable. Interactions run locally;
there is intentionally no artifact-to-agent action bridge in this first version.

WebRTC and WebTransport constructors are locked off at document start in every frame. These APIs
need a separate capability guard because CSP and ordinary request interception do not cover WebRTC
STUN/TURN sockets. Browser regression tests include a localhost UDP listener and empty-iframe probes.

# Artifacts

Session-owned, project-indexed images, HTML/JavaScript, React/JSX and standalone SwiftUI documents.
This package owns preparation, offline libraries, revision storage and agent-side previews. Generated
JavaScript never runs in Node; SwiftUI runs only in disposable native sandbox processes.

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

React and ReactDOM are not bundled into each revision. The compiled module imports them from the shared
`react` and `react-dom` library scripts, which are added to the revision's libraries automatically (a
trivial component is about 3 KB instead of about 290 KB). Other imports, such as `motion/react`, are
bundled and share the same React globals.

### SwiftUI

Provide self-contained Swift declarations with a zero-argument `ArtifactView`:

```js
await tools.artifact({
  action: "create",
  title: "Native card",
  kind: "swiftui",
  source: `struct ArtifactView: View {
    var body: some View {
      VStack(alignment: .leading, spacing: 12) {
        Text("Preview").font(.title)
        Text("Native SwiftUI layout with fixture data")
      }.padding(24)
    }
  }`,
});
```

Requires macOS 14+ with Swift Command Line Tools installed (`xcode-select --install`) and
`/usr/bin/sandbox-exec` available. SwiftUI, AppKit and Foundation imports are provided. No project
modules, package dependencies, `@main` or `#Preview`. Avoid `@State`, whose macro plugin is absent
from Command Line Tools; use `@StateObject` holders if needed. Source is limited to 512 KiB UTF-8;
offline JavaScript libraries are not supported.

Create/update compile and render an 800x600 static PNG, saving the original Swift source and an
offline image document. Existing viewers can display it without a Swift toolchain or recompilation;
Source shows the editable Swift code. Draft preview supports custom viewport dimensions using the
same width/height options as browser previews. Content height is the fixed viewport height, not a
scroll measurement. No Chromium installation is needed for SwiftUI.

Swift's SDK module cache is only valid at the path where it was built, so compiles run in two fixed,
lock-protected slot directories under `~/Library/Caches/Pilot/swiftui/<toolchain>` (override with
`PILOT_SWIFTUI_CACHE`). The first compile in a slot builds its module cache from trusted warm-up source
(the cold cost, often 30 seconds or more). Every compile then gets a private APFS clone of that cache,
which takes a compile from about 35 seconds to about 1.5 seconds. Untrusted code never writes to the
shared cache. When both slots are busy, a compile falls back to a cold temporary directory. Rendered
results are also cached in memory by toolchain, viewport and source, so a preview followed by
publication of the same source compiles once.

Previews are standalone layout prototypes, not project-aware builds or interactive apps. Use fixture
data and label that distinction when showing UI changes. Compiler failures include bounded diagnostics;
successful draft previews include compiler warnings and runtime output in `consoleMessages`.
The offscreen SwiftUI `ImageRenderer` does not capture embedded AppKit/WebKit views; use native SwiftUI
layout primitives for prototypes and inspect the screenshot for unsupported controls.

Native integration checks are opt-in because they require a macOS toolchain and cold SDK builds:

```sh
PILOT_SWIFTUI_TESTS=1 node --import tsx --test packages/artifacts/src/swiftui.test.ts
```

## Verification

Pilot-only system guidance encourages agents to publish explanatory diagrams when useful, preferring
simple Mermaid diagrams with a short explanation. It is included only when the artifact tool is
available, including through codemode. Normal Pi sessions are unchanged; this project's `AGENTS.md`
also asks agents to show user-visible UI changes with artifacts.

`artifact({action: "preview", ...})` renders a draft without saving it, returning PNG image content,
console messages and content height. When using codemode, display the structured `screenshot` with
`image`, not `text`.

Preview is optional, never a prerequisite for publication. The tool advertises and accepts the preview
action only if Chromium or the macOS Swift toolchain is installed when the session opens. Browser
previews require Chromium; native SwiftUI previews use the Swift toolchain independently. Without
Chromium, agents can still create, update and view browser artifacts, and should not ask for a browser
installation to publish diagrams. After installing a renderer, reopen the session to enable its previews.

To enable HTML, React and image draft previews, install Chromium once with `npm run artifacts:browser`.
SwiftUI uses the native renderer instead. Installation is never triggered by a model tool.
For an installed release app without npm, run its bundled Node explicitly:

```sh
runtime="/Applications/Pilot.app/Contents/Resources/runtime"
"$runtime/node/bin/node" "$runtime/node_modules/playwright/cli.js" install chromium
```

This optional, user-triggered installation uses the user's browser cache, not the signed app bundle.
Browser previews use a fresh profile and an in-memory resource handler that denies external requests.
Runtime messages are bounded, viewport dimensions are limited, and previews time out. Animated pages
are sampled shortly after loading; a screenshot is not proof of every interactive state.

One headless Chromium is kept warm for 60 seconds after the last preview, and each preview gets a new
isolated browser context. A browser that crashes, or whose context does not close after a timeout, is
replaced. When Chromium is installed, HTML and React `create`/`update` also render once after
publishing and return page errors as `warnings` in the result. These diagnostics never block or undo a
publication. Updates without `expectedRevision` succeed, with a warning.

## Libraries

Release bundles prebuild every library with `npm run artifacts:libraries` (run by
`apps/macos/scripts/bundle-runtime.sh`) into `dist/libraries`, with a manifest of library and esbuild
versions and checksums. pilotd serves a prebuilt file only if its key and checksum match, and otherwise
builds the library once per process. Library responses carry an `ETag` and `Cache-Control: no-cache`.
The app keeps one in-memory copy per library, revalidates it with `If-None-Match` at most every 30
seconds, and coalesces concurrent loads. If pilotd is briefly unreachable, an already-loaded copy is
still served. Revisions record `libraryVersions`, so drift after a library upgrade can be detected. Only
the current version of each library is shipped, so older revisions render with it.

## Storage and security

SwiftUI compilation (including compiler plugins) and rendering both use deny-by-default macOS sandbox
profiles. They may read the system SDK, libraries and fonts, and their own private temporary directory;
only that directory is writable. Network access and workspace/user-file reads are denied. Runtime
subprocesses are denied, environment variables are stripped, output is bounded, and the whole operation
has a five-minute deadline (cold SDK compilation can take minutes), with rendering limited to 15 seconds.
Cancellation terminates compiler/helper descendants and removes temporary files. Native artifact code
never loads into the running Pilot app. The sandbox is required; there is no unsandboxed fallback.
Saved revisions contain PNG pixels, not native executables.

Files live at `$PILOT_HOME/sessions/<sessionId>/artifacts/<artifactId>/`. Numbered JSON revisions are
immutable after publication; an atomic `latest.json` points to the latest committed one. The session's
single worker serializes writes. Unpublished files left by a crash are not exposed. Native tools remain
replay-unsafe, so a crash after publication can leave an artifact with an interrupted tool result.
Each file and its directory are fsynced around the rename, so power loss cannot leave an empty revision.
Listing skips (and logs) an unreadable `latest.json` instead of failing the whole session or project.
Image revisions store their bytes once, in `source`; the image document is rebuilt when read.

The app uses an isolated nonpersistent WebKit view, a restrictive CSP, a fail-closed request blocker and
a read-only allowlisted library scheme handler. Network, app origins, filesystem access, native message
handlers, frames, popups, forms, workers and permission dialogs are unavailable. Interactions run locally;
there is intentionally no artifact-to-agent action bridge in this first version.

WebRTC and WebTransport constructors are locked off at document start in every frame. These APIs
need a separate capability guard because CSP and ordinary request interception do not cover WebRTC
STUN/TURN sockets. Browser regression tests include a localhost UDP listener and empty-iframe probes.

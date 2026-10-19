# Native visual artifacts

`kind: "visual"` is the **first choice** for charts, stats, tables, small dashboards, controls (tabs, toggles,
sliders, buttons), Mermaid diagrams (`ui.mermaid`) and 2D drawings or animations (`ui.canvas`). Pilot draws visuals natively in the chat: light and
dark, the chat's fonts, selectable text and no web page. Use HTML or React only for what visuals can't express: custom
layouts, rich documents, wide content and web libraries such as d3 force graphs or three.js. For GLSL effects
inside a visual, use `ui.shader`; a standalone shader artifact suits a shader on its own.

The API is in [visual.d.ts](visual.d.ts). A visual is a **plain JavaScript function** defined in your codemode script
and published as its text with `String(visual)` (tool arguments are JSON, so a function passed directly arrives
empty). Pass the data separately as `data`, any JSON up to 1 MiB, never spliced into the code.

```js
// 1. Gather data with any tool in the same script: a database query, Linear issues, files.
const rows = JSON.parse(await tools.read({ path: "latency.json" })); // [{ region, p95, p99 }, ...]

// 2. Define the visual: setup runs once, then it returns the view.
function visual({ ui, state, data }) {
  const s = state({ metric: "p95" });
  return () =>
    ui.column({ gap: 16 }, [
      ui.text("Latency by region", { size: "lg", weight: 600 }),
      ui.tabs({ options: ["p95", "p99"], value: s.metric, onChange: (v) => (s.metric = v) }),
      ui.chart({
        type: "bar", height: 220, unit: "ms",
        x: data.map((d) => d.region),
        series: [{ name: s.metric, values: data.map((d) => d[s.metric]) }],
      }),
    ]);
}

// 3. Publish. Publication runs the visual and fails with "line N: message"; fix it here and publish again.
try {
  const { artifact, check } = await tools.artifact({
    action: "create", kind: "visual", title: "Latency", source: String(visual), data: rows,
  });
  text(check); // nodes, controls, interactions, canvas draws and any console.log lines
} catch (error) {
  // "Visual check failed. Nothing was published. line 10: chart series "p95" value 2 must be a finite number
  // or null, got bad"
  text(error.message);
}
```

## Rules

- **The view is pure.** Handlers only assign to state; the view runs again after each one. `state()` only works
  during setup, and its values must be JSON. `data` is frozen.
- **Sandboxed and deterministic.** No `fetch`, timers, modules or files: gather everything with tools first and pass
  it as `data`. `Math.random` is seeded from the artifact id and `Date` is fixed.
- **Style with tokens.** Colors are token names (`text`, `muted`, `accent`, `success`, `warning`, `danger`,
  `border`, `chart1`...`chart6`), text sizes are steps (`xs`...`xl`). Layout nodes have no fills, borders or
  shadows: visuals sit on the chat, not in cards.
- **Size for the chat.** Design for the 760 pt column; aim for about 160-600 pt for compact visuals. Taller visuals
  grow with their content and scroll with the chat, without an overall height cap. Give charts an explicit
  `height` (80-480); canvases and shaders also keep their explicit heights.
- **Keys.** Give children that move or appear conditionally a `key`, unique among siblings.

## Canvas

`ui.canvas` draws with a pen when Swift Charts can't express the picture: gauges, timelines, diagrams of a few
hundred shapes, small animations. Colors are tokens here too.

```js
ui.canvas({
  height: 160, animated: true, label: "Request rate",
  draw: (g, { width, height, t, pointer }) => {
    const points = [];
    for (let x = 0; x <= width; x += 6) points.push(x, height / 2 + Math.sin(x / 40 + t * 2) * 40);
    g.path(points, { stroke: "chart1", width: 2 });
    if (pointer) g.text(pointer.x + 8, 12, Math.round(pointer.x) + " req/s", { size: "xs", baseline: "top" });
  },
})
```

`draw` runs again on resize and pointer moves and, when `animated`, every display frame while the canvas is visible
(`t` is seconds; it stays 0 under Reduce Motion). It may read state but never assign it, and must finish within 8 ms:
two slow frames in a row stop the canvas with the error. Keep frames to a few thousand commands.

## Mermaid

`ui.mermaid(source)` draws a Mermaid diagram natively at its natural size, shrunk to fit the column and 480 pt;
readers expand it to zoom. Use it for flowcharts, sequence, class, state and ER diagrams, alone or beside other
nodes. The source must start with a diagram type (`flowchart`, `sequenceDiagram`...), at most 20 KiB.

```js
function visual({ ui }) {
  return () =>
    ui.column({ gap: 12 }, [
      ui.text("Request path", { size: "lg", weight: 600 }),
      ui.mermaid(`flowchart LR
  A[Request] --> B{Cached?}
  B -->|yes| C[Reply]
  B -->|no| D[Render] --> C`),
    ]);
}
```

Pilot draws the diagram with Mermaid in a web view instead when its native renderer can't read it faithfully.

## Shader

`ui.shader` draws a Shadertoy-style `mainImage` with Metal, as wide as the column. The GLSL is the same as a shader
artifact's ([shaders.md](shaders.md)): GLSL ES 3.00 without `#version`, `iResolution`, `iTime`, `iTimeDelta`,
`iFrame` and `iMouse` declared (`iMouse.xy` is the pointer while it is over the shader). Each `inputs` entry adds a
`float` uniform of that name, set from state on every view:

```js
ui.shader({
  height: 200, label: "Plasma", inputs: { speed: s.speed },
  glsl: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float v = sin(uv.x * 6.0 + iTime * speed) + sin(length(uv) * 9.0 - iTime);
  fragColor = vec4(0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + v), 1.0);
}`,
})
```

It animates while visible (`animated: false` draws once) and shows a still frame at `iTime` 0 under Reduce Motion.
Publication compiles every shader the views show with glslang and translates it to Metal; errors name the shader and
the line in its GLSL. Keep per-pixel work modest: it runs on the reader's GPU every frame.

## Publication check

Before saving, Pilot runs the function, renders the first view, validates the tree (known nodes and props, token
names, finite numbers, one series value per x, unique keys) and exercises every control once (each tab, both toggle
states, slider min and max, each button; up to 24 interactions). It draws every canvas at widths 760 and 360, with and
without a pointer, and at `t` 0 and 1.5 when animated, and compiles every shader. The first failure comes back as an
error with the line inside your function (or shader) and what triggered it. Nothing is saved until the check passes,
so catch the error, fix the function or the data and publish again in the same script.

| Limit | Value |
| --- | --- |
| Source | 256 KiB |
| `data` | 1 MiB of JSON |
| Heap | 32 MiB |
| Setup, view | 250 ms each |
| Handler | 100 ms |
| Canvas draw | 8 ms; 20,000 commands |
| Tree | 5,000 nodes, 64 KiB of text |
| State | 64 KiB of JSON |

## Revising

`get` returns `source` and `data`. To revise, define the function again in the script and `update` with
`source: String(visual)`, `data` and `expectedRevision`; the same function can be republished with new data.
`preview` does not render visuals: `create` and `update` run the check instead.

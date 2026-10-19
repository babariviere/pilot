# Native visual artifacts

`kind: "visual"` is the **first choice** for charts, stats, tables, small dashboards and controls (tabs, toggles,
sliders, buttons). Pilot draws visuals natively in the chat: light and dark, the chat's fonts, selectable text and no
web page. Use HTML or React only for what visuals can't express: custom layouts, rich documents, wide content and web
libraries such as Mermaid, d3 force graphs or three.js. 2D canvas and shader nodes are not available yet; use a shader
artifact for GLSL.

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
  text(check); // nodes, controls, interactions and any console.log lines
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
- **Size for the chat.** Design for the 760 pt column and about 160-600 pt of height; give charts an explicit
  `height` (80-480). Taller visuals scroll inside above 720 pt.
- **Keys.** Give children that move or appear conditionally a `key`, unique among siblings.

## Publication check

Before saving, Pilot runs the function, renders the first view, validates the tree (known nodes and props, token
names, finite numbers, one series value per x, unique keys) and exercises every control once (each tab, both toggle
states, slider min and max, each button; up to 24 interactions). The first failure comes back as an error with the
line inside your function and what triggered it. Nothing is saved until the check passes, so catch the error, fix the
function or the data and publish again in the same script.

| Limit | Value |
| --- | --- |
| Source | 256 KiB |
| `data` | 1 MiB of JSON |
| Heap | 32 MiB |
| Setup, view | 250 ms each |
| Handler | 100 ms |
| Tree | 5,000 nodes, 64 KiB of text |
| State | 64 KiB of JSON |

## Revising

`get` returns `source` and `data`. To revise, define the function again in the script and `update` with
`source: String(visual)`, `data` and `expectedRevision`; the same function can be republished with new data.
`preview` does not render visuals: `create` and `update` run the check instead.

# Native visual artifacts

`kind: "visual"` is the **first choice** for charts, stats, tables, small dashboards, controls (tabs, toggles,
sliders, buttons), UI mockups and design alternatives, Mermaid diagrams (`ui.mermaid`) and 2D drawings or animations
(`ui.canvas`). Pilot draws visuals natively in the chat: light and dark, the chat's fonts, selectable text and no web
page. HTML, React and SwiftUI authoring and preview are removed; existing sources remain read-only.
Shader rendering is deferred in Pilot Next, including `ui.shader`. Use layout, typography and vectors for mockups.

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
- **Tokens are defaults, not restrictions.** Token colors (`text`, `muted`, `accent`, `success`, `warning`,
  `danger`, `border`, `chart1`...`chart6`) and text steps (`xs`...`xl`) follow the chat and its light and dark
  mode; data visuals read best with them and without cards. Any color also takes a literal `"#rrggbb"` (or `#rgb`,
  `#rgba`, `#rrggbbaa`), and text any size in points. Mockups use surfaces: see UI mockups below.
- **Size for the chat.** Design for the 760 pt column; aim for about 160-600 pt for compact visuals. Taller visuals
  grow with their content and scroll with the chat, without an overall height cap. Give charts an explicit
  `height` (80-480); canvases and shaders also keep their explicit heights.
- **Keys.** Give children that move or appear conditionally a `key`, unique among siblings.

## UI mockups

Use a visual for UI proposals, screens and side-by-side alternatives, not just data. Layout nodes (`column`, `row`,
`grid`) take **surface** props, and text, icons and vectors take their own styling, so a mockup is real layout and
real text, not a canvas of painted labels. Tokens are convenient defaults, not restrictions: pick the palette, type
and geometry the design needs. Literal colors stay the same in light and dark mode, so a mockup looks like itself in
either; use tokens for the captions around it.

```js
function visual({ ui, state }) {
  const s = state({ plan: "team" });
  const plans = [
    { id: "solo", name: "Solo", price: 9, perks: ["1 project", "Email support"] },
    { id: "team", name: "Team", price: 29, perks: ["Unlimited projects", "Shared workspaces", "Priority support"] },
  ];
  const logo = ui.vector({
    width: 32,
    height: 32,
    label: "Logo",
    draw: (g) => {
      g.rect(0, 0, 32, 32, { fill: "#4f46e5", radius: 9 });
      g.path("M9 22V10l7 7 7-7v12", { stroke: "#ffffff", width: 2.5 });
    },
  });
  return () =>
    ui.column({ padding: 24, radius: 20, gap: 18, color: "#e2e8f0", shadow: "lg",
      fill: { from: "#0f172a", to: "#1e1b4b", angle: 135 } }, [
      ui.row({ gap: 12, align: "center" }, [logo, ui.text("Pick a plan", { size: 24, weight: 700, font: "display" })]),
      ui.row({ gap: 14, align: "start" }, plans.map((p) => {
        const on = s.plan === p.id;
        return ui.column({ key: p.id, grow: 1, minWidth: 200, padding: 16, radius: 14, gap: 8,
          fill: on ? "#312e81" : "#ffffff0d", border: on ? "#818cf8" : "#ffffff1f", borderWidth: on ? 2 : 1,
          onClick: () => (s.plan = p.id) }, [
          ui.row({ justify: "between", align: "center" }, [
            ui.text(p.name, { size: 15, weight: 600 }),
            on && ui.icon("circle-check", { size: 18, color: "#a5b4fc" }),
          ]),
          ui.row({ gap: 4, align: "baseline" }, [
            ui.text("$" + p.price, { size: 30, weight: 800 }),
            ui.text("/ month", { size: 13, color: "#94a3b8" }),
          ]),
          p.perks.map((perk) => ui.row({ key: perk, gap: 6, align: "center" }, [
            ui.icon("check", { size: 14, color: "#34d399" }),
            ui.text(perk, { size: 13 }),
          ])),
        ]);
      })),
    ]);
}
```

What you can express:

- **Layout.** Stacks and grids with `gap`, `align`, `justify`, `wrap` (rows) and `span` (grid cells); `padding`;
  `width`/`height` in points or `"fill"`, `min`/`max` sizes and `grow` to share free space. Rows wrap by default, so
  side-by-side alternatives stack on a narrow window; pass `wrap: false` to keep a toolbar on one line. A point
  `width` holds in a narrower parent: put a fixed desktop window in a `scroll: "x"` row.
- **Layers.** `x`, `y`, `right` or `bottom` take a node out of the flow and place it over its parent: badges,
  overlays, labels centred on a ring (`{ x: 0, y: 0, right: 0, bottom: 0, align: "center", justify: "center" }`).
  Give the parent a size for a fixed stage. `clip` clips to rounded bounds; `scroll: "x"` or `"y"` scrolls overflow.
- **Surfaces.** `fill` (color or linear gradient), `border` and `borderWidth`, `radius`, `shadow` (`"sm"`, `"md"`,
  `"lg"` or `{ x, y, blur, spread, color }`), `opacity`, and `color`, the default for text and icons inside.
- **Type.** `size` in points (6-200) or steps, `weight` 100-900, `font` `"ui"` (Inter), `"display"` (Inter Display)
  or `"mono"` (JetBrains Mono), `lineHeight`, `lines`, `italic`; spans restyle runs.
- **Icons and vectors.** `ui.icon(name)` draws one of the app's bundled Lucide icons (`IconName` in visual.d.ts).
  `ui.vector` draws logos, avatars, rings, illustrations and custom glyphs with the canvas pen, including SVG path
  data: `g.path("M4 12h16M12 4v16", { stroke: "#0f172a", width: 2 })`. See Vector below.
- **Artboards and alternatives.** Fixed-size columns are artboards: a phone (390 x 844), a tablet or a window. Put
  alternatives side by side in a wrapping row, and drive their width, palette or screen from state with a slider,
  toggle or tabs. Any surface with `onClick` is pressable (pointer, or Enter/Space when focused): tab bars, list
  rows, cards. Its handler only assigns to state, like every control's.

Two complete examples render in the app's own checks: [mockup-mobile.js](mockup-mobile.js) (two phone directions
with a working tab bar and a width slider) and [mockup-desktop.js](mockup-desktop.js) (a desktop window with a
sidebar, KPI sparklines and a release list, a light/dark window toggle and a responsive width slider). Each file is
one visual function: read it, adapt it and publish it with `String(visual)`.

Not supported, so don't promise them: images, photos or other assets inside a visual (publish an image artifact
beside it), fonts other than the three above, hover, pressed or drag states and transitions on surfaces (use
`ui.canvas` for pointer-driven or animated drawing), editable text fields, per-side borders, several shadows,
radial gradients, blur, rotation of layout nodes, letter spacing and text transforms (change the string instead).
The legacy macOS app does not draw icons, vectors or surface styling.

## Vector

`ui.vector({ width, height, label, draw })` records a fixed drawing while the view renders: the same pen as a canvas,
in `width` x `height` units, shown at that size and shrunk proportionally in a narrower parent. Pilot plans it once
and paints it natively, with no further calls into the visual, so use it freely for logos, avatars, progress rings,
sparklines and decorative shapes. All vectors in one view share 20,000 commands. Use `ui.canvas` instead for
drawings that follow the pointer, animate or fill the column's width.

```js
ui.vector({
  width: 120, height: 120, label: "Weekly goal, 74%",
  draw: (g, { width }) => {
    const c = width / 2;
    g.arc(c, c, c - 2, 0, Math.PI * 2, { fill: "#d1fae5", inner: c - 14 });
    g.arc(c, c, c - 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * 0.74, { fill: "#10b981", inner: c - 14 });
    g.path("M44 60l11 11 22-24", { stroke: "#047857", width: 6 });
  },
})
```

`g.path` takes SVG path data (`M L H V C S Q T A Z`, lowercase relative), so icon and logo paths can be pasted in;
its subpaths fill together with the nonzero rule, so cut-outs stay open. Every pen color, here and in canvases, also
takes a literal color.

## Canvas

`ui.canvas` draws with a pen when charts can't express the picture: gauges, timelines, diagrams of a few
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

`ui.mermaid(source)` accepts a bounded native flowchart subset, at most20KiB UTF-8:
`flowchart`/`graph` plus `TD`, `TB`, `BT`, `LR` or `RL`; ASCII letter-led IDs;
plain Unicode labels in `[]`, `()` or `{}`; `-->`/`---` and optional `|edge label|`.
Chains and newline/semicolon statements are supported. Limits:48nodes,96edges,
24ranks; node labels48graphemes (16 in diamonds), edge labels24. Use explicit
Source/Expand controls to inspect the natural-size diagram.

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

Check/publication rejects malformed syntax as **Invalid Mermaid**, unvalidated
grammar as **Unsupported Mermaid**, and over-limit input separately. No browser
fallback. Sequence/class/state/ER, cycles/self/parallel links, subgraphs, styles,
click actions, directives, HTML/Markdown labels and escapes are unsupported.
Previously stored sources remain inspectable; this does not certify their syntax.

## Shader

This existing API is retained for compatibility. Shader rendering is unavailable in Pilot Next;
do not use it for Next mockups. This reference does not enable a shader or browser fallback.

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
names and literal colors, icon names, finite numbers, one series value per x, unique keys, every vector's drawing)
and exercises every control once (each tab, both toggle states, slider min and max, each button and pressable
surface; up to 24 interactions). It draws every canvas at widths 760 and 360 (or its own narrower width), with and
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
| Vectors | 20,000 commands per view, together |
| Tree | 5,000 nodes, 64 KiB of text |
| State | 64 KiB of JSON |

## Revising

`get` returns `source` and `data`. To revise, define the function again in the script and `update` with
`source: String(visual)`, `data` and `expectedRevision`; the same function can be republished with new data.
There is no screenshot preview host: `create` and `update` run the check instead.

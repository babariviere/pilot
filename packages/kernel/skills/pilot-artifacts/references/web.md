# HTML and React artifacts

Source must be self-contained and at most **512 KiB UTF-8**. Tailwind is not available: use inline CSS or `<style>` tags, not external stylesheets or utility classes.

Pilot supplies a light palette and the system font through CSS variables you may use or override: `--pilot-background`, `--pilot-foreground`, `--pilot-muted`, `--pilot-muted-foreground`, `--pilot-border`, `--pilot-primary`, `--pilot-radius`.

In chat, previews share the prose column, left-aligned on a transparent, unpadded page, and readers use them in place (click, type, scroll). Design for the **760 pt column** (narrower with the window): content reflows to that width and is never scaled. Aim for about **160–600 pt** of height. Cards hug their content up to 720 pt and scroll inside beyond that, so avoid full-viewport layouts (`100vh`, fixed full-screen panels). Wide or tall work belongs in the expanded viewer. Use inner elements for intentional panels or backgrounds. Expanded previews keep their page layout.

Bundled, pinned offline libraries: `react`, `react-dom`, `mermaid`, `echarts`, `motion`, `d3` and `three`. Nothing needs downloading.

## HTML

Use ordinary inline `<script>` tags, not package imports. `libraries` exposes the globals `echarts`, `mermaid`, `motion`, `d3` and `THREE` (from `three`): for example `echarts.init(el)`, `motion.animate()`, `d3.select()`, `new THREE.Scene()`.

```js
await tools.artifact({
  action: "create",
  title: "Chart",
  kind: "html",
  libraries: ["echarts"],
  source: `<div id="chart" style="height:320px"></div>
<script>
echarts.init(document.getElementById("chart")).setOption({
  xAxis: {type: "category", data: ["A", "B"]},
  yAxis: {}, series: [{type: "bar", data: [2, 5]}]
});
</script>`,
});
```

Diagrams use `kind: "html"` with `libraries: ["mermaid"]`:

```html
<pre class="mermaid">graph TD; A-->B</pre>
<script>mermaid.initialize({startOnLoad:true});</script>
```

## React

Provide a JSX/TSX module with a default-export component. Pilot mounts it; do not mount it yourself. Allowed imports: `react`, `react-dom` (including `react-dom/client`), `mermaid`, `echarts`, `motion` (including `motion/react`), `d3` and `three`.

```js
await tools.artifact({
  action: "create",
  title: "Counter",
  kind: "react",
  source: `import {useState} from "react";
export default function App() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>Count: {n}</button>;
}`,
});
```

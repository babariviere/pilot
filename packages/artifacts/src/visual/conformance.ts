/**
 * Conformance cases for visual hosts. The kernel's tests run them and keep
 * packages/protocol/fixtures/visual/conformance.json current; the app's helper replays the same file and must
 * produce the same trees, changed keys, state, canvas drawings and errors.
 */
import type { VisualTree } from "./schema.ts";
import { type VisualDrawInput, VisualFailure, type VisualSession } from "./session.ts";

type ArtifactData = null | boolean | number | string | ArtifactData[] | { [key: string]: ArtifactData };

interface Case {
	name: string;
	source: string;
	data: ArtifactData;
	/** Artifact id, the seed text passed to load(). */
	id: string;
	now: number;
	/** Saved state passed to load(). */
	state?: string;
	events?: Array<{ id: string; value: ArtifactData }>;
	/** Canvas draws after the last event. */
	draws?: Array<{ id: string; input: VisualDrawInput }>;
}

interface ErrorCase {
	name: string;
	source: string;
	data: ArtifactData;
	/** Events to send after the first view; the error may come from any step. */
	events?: Array<{ id: string; value: ArtifactData }>;
	/** Canvas draws after the first view, before the events. */
	draws?: Array<{ id: string; input: VisualDrawInput }>;
	/** The per-frame draw limit for this case, when it must not depend on the engine's speed. Default 8 ms. */
	drawMs?: number;
}

export interface ConformanceFile {
	api: 1;
	/** The QuickJS-NG release the cases were produced with. Hosts embed the same release. */
	engine: string;
	cases: Array<
		Omit<Case, "events" | "draws"> & {
			steps: Array<{ event?: { id: string; value: ArtifactData }; changed?: string[]; tree: VisualTree }>;
			/** state() after the last step. */
			finalState: string;
			/** Each draw's input and the commands it recorded (DRAW_FORMAT in runtime.js). */
			drawings?: Array<{ id: string; input: VisualDrawInput; commands: number; ops: number[]; strings: string[] }>;
		}
	>;
	/** The first error, formatted "line N: message" like the pre-check reports it. Seed text "", now 0. */
	errors: Array<ErrorCase & { error: string }>;
}

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

const everyNode = `function visual({ ui, state, data }) {
  const s = state({ tab: "bar", on: true, level: 40, clicks: 0 });
  return () =>
    ui.column({ gap: 12, align: "start" }, [
      ui.text(["Release ", ui.span("1.54", { weight: 600, color: "accent", mono: true }), " is ", ui.span("ready", { italic: true, strike: false })], { size: "lg", weight: 500, color: "text", align: "start", lines: 2 }),
      ui.row({ gap: 8, align: "baseline", justify: "between" }, [
        ui.stat({ label: "Builds", value: data.builds, unit: "runs", delta: "+12%", tone: "success", caption: "last 7 days" }),
        ui.stat({ key: "p95", label: "p95", value: "184", unit: "ms" }),
        ui.space(),
      ]),
      ui.grid({ columns: 2, gap: 8 }, [ui.text("Left", { color: "muted", size: "sm" }), ui.text("Right", { mono: true, italic: true, size: "xs" })]),
      ui.table({ key: "table", columns: ["Region", { label: "p95", align: "end" }], rows: [["eu", 120], ["us", null]] }),
      ui.tabs({ options: ["bar", { value: "line", label: "Line" }, "area", "scatter"], value: s.tab, onChange: (v) => (s.tab = v) }),
      ui.chart({
        type: s.tab, height: 200, unit: "ms", xLabel: "Day", yLabel: "Latency", yMin: 0, yMax: 400,
        stacked: s.tab === "bar" || s.tab === "area" ? true : undefined,
        x: s.tab === "scatter" ? [1, 2, 3] : ["Mon", "Tue", "Wed"],
        series: [{ name: "p95", values: [120, null, 180], color: "chart2" }, { name: "p99", values: [200, 210, 260] }],
      }),
      ui.rule(),
      ui.space({ size: 24 }),
      ui.space(4),
      ui.link("Dashboard", { href: "https://example.com/dash" }),
      ui.toggle({ key: "on", label: "Live", value: s.on, onChange: (v) => (s.on = v) }),
      ui.slider({ label: "Level", min: 0, max: 100, step: 10, value: s.level, unit: "%", onChange: (v) => (s.level = v) }),
      ui.row([
        ui.button({ label: "Clicked " + s.clicks, primary: true, onClick: () => s.clicks++ }),
        ui.button({ label: "Disabled", disabled: true, onClick: () => (s.clicks = 100) }),
      ]),
      "Plain strings become text",
      s.on && ui.text("Live is on"),
    ]);
}`;

const latency = `function visual({ ui, state, data }) {
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
}`;

const deterministic = `({ ui, state }) => {
  const s = state({ rolls: [] });
  return () => ui.column([
    ui.text("now " + Date.now() + " " + new Date().toISOString() + " perf " + performance.now()),
    ui.text("random " + Math.random().toFixed(6) + " " + Math.random().toFixed(6)),
    ui.text("rolls " + s.rolls.join(",")),
    ui.button({ label: "Roll", onClick: () => { s.rolls = [...s.rolls, Math.floor(Math.random() * 6) + 1]; console.log("rolled", s.rolls); } }),
    ui.text(typeof WeakRef + " " + typeof FinalizationRegistry),
  ]);
}`;

const shader = `function visual({ ui, state }) {
  const s = state({ speed: 1 });
  return () => ui.column([
    ui.slider({ label: "Speed", min: 0, max: 4, value: s.speed, onChange: (v) => (s.speed = v) }),
    ui.shader({ key: "plasma", height: 200, animated: true, label: "Plasma", inputs: { speed: s.speed, glow: 0.5 }, glsl: "void mainImage(out vec4 fragColor, in vec2 fragCoord) {\\n  fragColor = vec4(fragCoord / iResolution.xy, 0.5 + 0.5 * sin(iTime * speed), glow);\\n}" }),
  ]);
}`;

const diagram = `function visual({ ui, state }) {
  const s = state({ detail: false });
  return () => ui.column([
    ui.toggle({ label: "Detail", value: s.detail, onChange: (v) => (s.detail = v) }),
    ui.mermaid(s.detail ? "flowchart LR\\n  A[Request] --> B{Cached?}\\n  B -->|yes| C[Reply]\\n  B -->|no| D[Render] --> C" : "flowchart LR\\n  A[Request] --> C[Reply]", { key: "flow" }),
    ui.mermaid("---\\ntitle: Turn\\n---\\n%% a comment\\nsequenceDiagram\\n  User->>Agent: ask\\n  Agent-->>User: answer"),
  ]);
}`;

const regions = [
	{ region: "eu", p95: 120, p99: 180 },
	{ region: "us", p95: 140, p99: 210 },
	{ region: "ap", p95: 190, p99: 260 },
];

const canvas = `function visual({ ui, state }) {
  const s = state({ bars: 3 });
  return () => ui.column([
    ui.slider({ label: "Bars", min: 1, max: 6, step: 1, value: s.bars, onChange: (v) => (s.bars = v) }),
    ui.canvas({ key: "plot", height: 160, animated: true, label: "Bars and a ring", draw: (g, { width, height, t, pointer }) => {
      g.rect(0, 0, width, height, { stroke: "border", width: 1, radius: 6 });
      for (let i = 0; i < s.bars; i++)
        g.rect(12 + i * 40, height - 20 - i * 15, 30, 20 + i * 15, { fill: "chart" + (i + 1), stroke: "text", opacity: 0.75, width: 0.5 });
      g.save();
      g.translate(width - 80, height / 2);
      g.rotate(t * 2);
      g.scale(1.5, 0.5);
      g.opacity(0.5);
      g.arc(0, 0, 30, 0, 3, { fill: "accent", inner: 18 });
      g.arc(0, 0, 34, 1, 2, { stroke: "warning", width: 3 });
      g.restore();
      g.circle(width / 2, 30, 8 + t, { fill: "success" });
      g.line(0, height, width, 0, { stroke: "muted", width: 2 });
      g.path([[10, 10], [40, 25], [70, 10]], { stroke: "danger", close: true, fill: "danger", opacity: 0.25 });
      g.path([100, 10, 130, 30, 160, 10], { stroke: "chart6" });
      g.text(width / 2, height - 4, "t = " + t, { color: "muted", size: "xs", weight: 600, align: "center", baseline: "bottom", mono: true, opacity: 0.9 });
      g.text(4, 4, 42, { baseline: "top" });
      if (pointer) g.circle(pointer.x, pointer.y, 4, { stroke: "accent" });
    } }),
  ]);
}`;

export const CASES: Case[] = [
	{
		name: "every node and prop",
		source: everyNode,
		data: { builds: 42 },
		id: "00000000-0000-4000-8000-000000000001",
		now: NOW,
		events: [
			{ id: "0.4", value: "scatter" },
			{ id: "0.10", value: false },
			{ id: "0.11", value: 33.4 },
			{ id: "0.11", value: 1000 },
			{ id: "0.12.0", value: null },
			{ id: "0.12.1", value: null },
		],
	},
	{
		name: "doc example",
		source: latency,
		data: regions,
		id: "00000000-0000-4000-8000-000000000002",
		now: NOW,
		events: [{ id: "0.1", value: "p99" }],
	},
	{
		name: "restored state",
		source: latency,
		data: regions,
		id: "00000000-0000-4000-8000-000000000002",
		now: NOW,
		state: '[{"metric":"p99","stale":true}]',
	},
	{
		name: "restored state ignores values of another type",
		source: latency,
		data: regions,
		id: "00000000-0000-4000-8000-000000000002",
		now: NOW,
		state: '[{"metric":7}]',
	},
	{
		name: "deterministic globals",
		source: deterministic,
		data: null,
		id: "00000000-0000-4000-8000-000000000003",
		now: NOW,
		events: [
			{ id: "0.3", value: null },
			{ id: "0.3", value: null },
		],
	},
	{
		name: "static view returned directly",
		source: '({ ui }) => ui.text("Hello")',
		data: null,
		id: "00000000-0000-4000-8000-000000000004",
		now: NOW,
	},
	{
		name: "canvas drawing",
		source: canvas,
		data: null,
		id: "00000000-0000-4000-8000-000000000005",
		now: NOW,
		events: [{ id: "0.0", value: 4 }],
		draws: [
			{ id: "0.1", input: { width: 760, height: 160, t: 0 } },
			{ id: "0.1", input: { width: 360, height: 160, t: 1.5, pointer: { x: 180, y: 80 } } },
		],
	},
	{
		name: "shader inputs follow state",
		source: shader,
		data: null,
		id: "00000000-0000-4000-8000-000000000006",
		now: NOW,
		events: [{ id: "0.0", value: 2.5 }],
	},
	{
		name: "mermaid diagrams",
		source: diagram,
		data: null,
		id: "00000000-0000-4000-8000-000000000007",
		now: NOW,
		events: [{ id: "0.0", value: true }],
	},
];

const lines = (...parts: string[]) => parts.join("\n");

export const ERRORS: ErrorCase[] = [
	{ name: "not a function", source: "42", data: null },
	{ name: "two expressions", source: "function a() {}, function b() {}", data: null },
	{ name: "async function", source: 'async ({ ui }) => () => ui.text("x")', data: null },
	{ name: "syntax error", source: lines("({ ui }) => {", '  return () => ui.text("x";', "}"), data: null },
	{ name: "unknown prop", source: lines("({ ui }) => () =>", '  ui.text("x", { colour: "red" })'), data: null },
	{ name: "color token", source: lines("({ ui }) => () =>", '  ui.text("x", { color: "red" })'), data: null },
	{
		name: "duplicate key",
		source: lines(
			"({ ui }) => () => ui.column([",
			'  ui.text("a", { key: 1 }),',
			'  ui.text("b", { key: "1" }),',
			"])",
		),
		data: null,
	},
	{ name: "not a node", source: '({ ui }) => () => ui.column([{ type: "text" }])', data: null },
	{
		name: "series length",
		source: lines(
			"({ ui, state, data }) => {",
			'  const s = state({ metric: "p95" });',
			"  return () => ui.column([",
			'    ui.tabs({ options: ["p95", "p99"], value: s.metric, onChange: (v) => (s.metric = v) }),',
			"    ui.chart({",
			'      type: "bar",',
			"      x: data.labels,",
			"      series: [{ name: s.metric, values: data[s.metric] }],",
			"    }),",
			"  ]);",
			"}",
		),
		data: { labels: ["eu", "us", "ap", "sa"], p95: [1, 2, 3, 4], p99: [5, 6, 7] },
		events: [{ id: "0.0", value: "p99" }],
	},
	{
		name: "table row length",
		source: lines("({ ui }) => () => ui.table({", '  columns: ["a", "b"],', "  rows: [[1]],", "})"),
		data: null,
	},
	{
		name: "state in view",
		source: lines(
			"({ ui, state }) => {",
			"  const s = state({ n: 0 });",
			"  return () => {",
			"    s.n = 1;",
			'    return ui.text("x");',
			"  };",
			"}",
		),
		data: null,
	},
	{
		name: "state outside setup",
		source: lines("({ ui, state }) => () => {", "  state({ n: 0 });", '  return ui.text("x");', "}"),
		data: null,
	},
	{
		name: "state must be JSON",
		source: lines(
			"({ ui, state }) => {",
			"  const s = state({ n: 0 });",
			'  return () => ui.button({ label: "x", onClick: () => { s.n = () => 1; } });',
			"}",
		),
		data: null,
		events: [{ id: "0", value: null }],
	},
	{
		name: "tabs value",
		source: '({ ui }) => () => ui.tabs({ options: ["a"], value: "b", onChange() {} })',
		data: null,
	},
	{
		name: "slider range",
		source: "({ ui }) => () => ui.slider({ min: 0, max: 10, value: 11, onChange() {} })",
		data: null,
	},
	{ name: "link scheme", source: '({ ui }) => () => ui.link("x", { href: "file:///etc/passwd" })', data: null },
	...drawErrors(),
	{ name: "mermaid type", source: '({ ui }) => () =>\n  ui.mermaid("A --> B")', data: null },
	{ name: "mermaid source", source: "({ ui }) => () => ui.mermaid(42)", data: null },
	{
		name: "mermaid too long",
		source: '({ ui }) => () => ui.mermaid("graph TD\\n" + "A-->B\\n".repeat(4000))',
		data: null,
	},
	{
		name: "shader without mainImage",
		source: lines("({ ui }) => () =>", '  ui.shader({ glsl: "void main() {}" })'),
		data: null,
	},
	{
		name: "shader input name",
		source: '({ ui }) => () => ui.shader({ glsl: "void mainImage(out vec4 c, in vec2 p) {}", inputs: { "a-b": 1 } })',
		data: null,
	},
	{
		name: "shader input value",
		source:
			'({ ui }) => () => ui.shader({ glsl: "void mainImage(out vec4 c, in vec2 p) {}", inputs: { speed: "fast" } })',
		data: null,
	},
	{
		name: "shader too long",
		source: '({ ui }) => () => ui.shader({ glsl: "void mainImage(out vec4 c, in vec2 p) {}" + " ".repeat(16384) })',
		data: null,
	},
	{ name: "script error", source: lines("({ ui, data }) => () =>", "  ui.text(data.missing.field)"), data: {} },
	{
		name: "handler error",
		source: lines(
			"({ ui }) => () => ui.button({",
			'  label: "x",',
			'  onClick: () => { throw new Error("boom"); },',
			"})",
		),
		data: null,
		events: [{ id: "0", value: null }],
	},
	{
		name: "data is frozen",
		source: lines("({ ui, data }) => {", "  data.x = 1;", '  return () => ui.text("x");', "}"),
		data: {},
	},
	{
		name: "too many nodes",
		// Root + 5000 occurrences exceed the 5000-node budget by exactly one.
		// Reuse an unkeyed leaf to avoid builder allocations racing the deadline.
		source: "({ ui }) => () => ui.column(Array(5000).fill(ui.rule()))",
		data: null,
	},
	{ name: "too much text", source: '({ ui }) => () => ui.text("x".repeat(70000))', data: null },
];

/** Run a case through a session and record what a host must reproduce. */
function drawErrors(): ErrorCase[] {
	const draw = (name: string, ...body: string[]): ErrorCase => ({
		name,
		source: lines(
			"({ ui, state }) => {",
			"  const s = state({ n: 0 });",
			"  return () => ui.canvas({ draw: (g, f) => {",
			...body.map((line) => `    ${line}`),
			"  } });",
			"}",
		),
		data: null,
		draws: [{ id: "0", input: { width: 300, height: 100, t: 0 } }],
	});
	return [
		{ name: "canvas without draw", source: "({ ui }) => () => ui.canvas({ height: 100 })", data: null },
		{ name: "canvas height", source: "({ ui }) => () => ui.canvas({ height: 1000, draw() {} })", data: null },
		draw("draw style", 'g.rect(0, 0, 10, 10, { fill: "chart1", color: "red" });'),
		draw("draw color", 'g.circle(5, 5, 5, { fill: "#f00" });'),
		draw("draw needs paint", "g.rect(0, 0, 10, 10);"),
		draw("draw coordinate", 'g.rect(0, f.missing, 10, 10, { fill: "text" });'),
		draw("draw line fill", 'g.line(0, 0, 10, 10, { fill: "text" });'),
		draw("draw path points", 'g.path([1, 2, 3], { stroke: "text" });'),
		draw("draw restore", "g.restore();"),
		draw("draw text", "g.text(0, 0, {}, {});"),
		draw("draw changes state", "s.n = 1;"),
		{ ...draw("draw commands", "for (let i = 0; i < 20001; i++) g.translate(1, 0);"), drawMs: 5000 },
		draw("draw time", "for (;;);"),
		{
			name: "pen outside draw",
			source: lines(
				"({ ui }) => {",
				"  let pen;",
				"  return () => ui.column([",
				"    ui.canvas({ draw: (g) => { pen = g; } }),",
				'    ui.button({ label: "x", onClick: () => pen.rect(0, 0, 1, 1, { fill: "text" }) }),',
				"  ]);",
				"}",
			),
			data: null,
			draws: [{ id: "0.0", input: { width: 300, height: 100, t: 0 } }],
			events: [{ id: "0.1", value: null }],
		},
		{
			name: "draw unknown canvas",
			source: '({ ui }) => () => ui.text("x")',
			data: null,
			draws: [{ id: "0", input: { width: 300, height: 100, t: 0 } }],
		},
	];
}

/** Run a case through a session and record what a host must reproduce. */
export function runCase(session: VisualSession, value: Case): ConformanceFile["cases"][number] {
	session.load(value.source, JSON.stringify(value.data), value.state);
	const steps: ConformanceFile["cases"][number]["steps"] = [{ tree: session.render().tree }];
	for (const event of value.events ?? []) {
		const changed = session.event(event.id, event.value);
		steps.push({ event, changed, tree: session.render().tree });
	}
	const drawings = value.draws?.map(({ id, input }) => ({ id, input, ...session.draw(id, input) }));
	const { events: _events, draws: _draws, ...rest } = value;
	return { ...rest, steps, finalState: session.state(), ...(drawings ? { drawings } : {}) };
}

/** Run an error case through a session; returns the error as "line N: message". */
export function runErrorCase(session: VisualSession, value: ErrorCase): string {
	try {
		session.load(value.source, JSON.stringify(value.data));
		session.render();
		for (const draw of value.draws ?? []) session.draw(draw.id, draw.input, value.drawMs);
		for (const event of value.events ?? []) {
			session.event(event.id, event.value);
			session.render();
		}
	} catch (error) {
		if (error instanceof VisualFailure) return error.report;
		throw error;
	}
	throw new Error(`Expected ${value.name} to fail`);
}

/**
 * Conformance cases for visual hosts. The kernel's tests run them and keep
 * packages/protocol/fixtures/visual/conformance.json current; the app's helper replays the same file and must
 * produce the same trees, changed keys, state and errors.
 */
import type { VisualTree } from "./schema.ts";
import { VisualFailure, type VisualSession } from "./session.ts";

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
}

interface ErrorCase {
	name: string;
	source: string;
	data: ArtifactData;
	/** Events to send after the first view; the error may come from any step. */
	events?: Array<{ id: string; value: ArtifactData }>;
}

export interface ConformanceFile {
	api: 1;
	/** The QuickJS-NG release the cases were produced with. Hosts embed the same release. */
	engine: string;
	cases: Array<
		Omit<Case, "events"> & {
			steps: Array<{ event?: { id: string; value: ArtifactData }; changed?: string[]; tree: VisualTree }>;
			/** state() after the last step. */
			finalState: string;
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

const regions = [
	{ region: "eu", p95: 120, p99: 180 },
	{ region: "us", p95: 140, p99: 210 },
	{ region: "ap", p95: 190, p99: 260 },
];

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
	{ name: "canvas", source: "({ ui }) => () => ui.canvas({ height: 100, draw() {} })", data: null },
	{ name: "shader", source: '({ ui }) => () => ui.shader({ glsl: "" })', data: null },
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
		source: "({ ui }) => () => ui.column(Array.from({ length: 5001 }, () => ui.rule()))",
		data: null,
	},
	{ name: "too much text", source: '({ ui }) => () => ui.text("x".repeat(70000))', data: null },
];

/** Run a case through a session and record what a host must reproduce. */
export function runCase(session: VisualSession, value: Case): ConformanceFile["cases"][number] {
	session.load(value.source, JSON.stringify(value.data), value.state);
	const steps: ConformanceFile["cases"][number]["steps"] = [{ tree: session.render().tree }];
	for (const event of value.events ?? []) {
		const changed = session.event(event.id, event.value);
		steps.push({ event, changed, tree: session.render().tree });
	}
	const { events: _events, ...rest } = value;
	return { ...rest, steps, finalState: session.state() };
}

/** Run an error case through a session; returns the error as "line N: message". */
export function runErrorCase(session: VisualSession, value: ErrorCase): string {
	try {
		session.load(value.source, JSON.stringify(value.data));
		session.render();
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { runVisualCheck } from "./check.ts";
import { checkVisual, VisualCheckError, validateVisualWrite } from "./index.ts";
import { VISUAL_LIMITS } from "./schema.ts";
import { visualRuntime } from "./session.ts";

/** Run the check on this thread, without a worker. */
async function run(source: string, data: unknown = null) {
	return runVisualCheck({
		wasm: await loadQuickJSWasm(),
		runtime: await visualRuntime(),
		source,
		data: JSON.stringify(data),
		seed: "artifact",
		now: 0,
	});
}

function failed(result: Awaited<ReturnType<typeof run>>): string {
	assert.equal(result.ok, false, JSON.stringify(result));
	return (result as { error: string }).error;
}

const latency = `function visual({ ui, state, data }) {
  const s = state({ metric: "p95" });
  return () =>
    ui.column({ gap: 16 }, [
      ui.text("Latency by region", { size: "lg", weight: 600 }),
      ui.tabs({ options: ["p95", "p99"], value: s.metric, onChange: (v) => (s.metric = v) }),
      ui.chart({
        type: "bar", height: 220, unit: "ms",
        x: data.labels,
        series: [{ name: s.metric, values: data[s.metric] }],
      }),
    ]);
}`;

test("a chart series that breaks after a tab change reports the line and the interaction", async () => {
	const result = await run(latency, { labels: ["eu", "us", "ap", "sa"], p95: [1, 2, 3, 4], p99: [5, 6, 7] });
	assert.equal(failed(result), 'line 10: chart series "p99" has 3 values for 4 labels (after tabs "metric" = "p99")');
});

test("every control is exercised once: each other tab, toggles both ways, slider ends, buttons", async () => {
	const result = await run(`({ ui, state }) => {
  const s = state({ tab: "a", on: false, level: 5, clicks: 0 });
  return () => ui.column([
    ui.tabs({ options: ["a", "b", "c"], value: s.tab, onChange: (v) => (s.tab = v) }),
    ui.toggle({ label: "On", value: s.on, onChange: (v) => (s.on = v) }),
    ui.slider({ min: 0, max: 10, value: s.level, onChange: (v) => (s.level = v) }),
    ui.button({ label: "Click", onClick: () => { s.clicks++; console.log("clicked", s.clicks); } }),
    ui.button({ label: "Off", disabled: true, onClick: () => { throw new Error("never"); } }),
  ]);
}`);
	assert.ok(result.ok, JSON.stringify(result));
	assert.deepEqual(result.report, { nodes: 6, controls: 5, interactions: 2 + 2 + 2 + 1, logs: ["clicked 1"] });
	assert.equal(result.engine, "quickjs-ng 0.17.0");
});

test("controls revealed by an interaction are exercised in that context", async () => {
	const result = await run(`({ ui, state }) => {
  const s = state({ advanced: false, n: 0 });
  return () => ui.column([
    ui.toggle({ label: "Advanced", value: s.advanced, onChange: (v) => (s.advanced = v) }),
    s.advanced && ui.button({ key: "boom", label: "Explode", onClick: () => {
      s.n = undefined;
    } }),
  ]);
}`);
	assert.equal(
		failed(result),
		'line 6: state.n must be JSON, got undefined (after toggle "advanced" = true, button "boom")',
	);
});

test("interactions stop at the cap", async () => {
	const result = await run(
		`({ ui, state }) => { const s = state({ n: 0 }); return () => ui.row(Array.from({ length: 30 }, (_, i) => ui.button({ label: "B" + i, onClick: () => s.n++ }))); }`,
	);
	assert.ok(result.ok);
	assert.equal(result.report.interactions, VISUAL_LIMITS.interactions);
	assert.equal(result.report.controls, 30);
});

test("setup, view and handler time limits interrupt with their phase and line", async () => {
	// QuickJS reports an interrupt at the looping function, not always at the loop's own line.
	assert.match(failed(await run("() => {\n  for (;;);\n}")), /^line \d: the visual function took longer than 250 ms$/);
	assert.match(
		failed(await run("({ ui }) => () => {\n  while (true) {}\n}")),
		/^line \d: the view took longer than 250 ms$/,
	);
	assert.match(
		failed(await run('({ ui }) => () => ui.button({ label: "Spin", onClick: () => {\n  for (;;);\n} })')),
		/^line \d: the handler took longer than 100 ms \(after button "Spin"\)$/,
	);
});

test("memory and tree limits fail with plain messages", async () => {
	assert.match(
		failed(await run('() => {\n  const a = [];\n  for (;;) a.push("x".repeat(4096));\n}')),
		/used more than 32 MiB of memory/,
	);
	assert.equal(
		failed(await run("({ ui }) => () => ui.column(Array.from({ length: 5001 }, () => ui.rule()))")),
		"the view has more than 5000 nodes",
	);
});

test("console output is kept, bounded in lines and length", async () => {
	const result = await run(
		`({ ui }) => { for (let i = 0; i < 60; i++) console.log(i === 0 ? "x".repeat(600) : { i }); return () => ui.text("x"); }`,
	);
	assert.ok(result.ok);
	assert.equal(result.report.logs.length, VISUAL_LIMITS.logLines);
	assert.equal(result.report.logs[0], `${"x".repeat(500)}…`);
	assert.equal(result.report.logs[1], '{"i":1}');
});

test("canvas and shader nodes are not supported yet", async () => {
	assert.equal(failed(await run("({ ui }) => () =>\n  ui.canvas({})")), "line 2: canvas nodes are not yet supported");
	assert.equal(failed(await run("({ ui }) => () =>\n  ui.shader({})")), "line 2: shader nodes are not yet supported");
});

test("publication limits and source shape are checked before the engine starts", () => {
	assert.throws(() => validateVisualWrite(`() => "${"x".repeat(VISUAL_LIMITS.sourceBytes)}"`, null), /256 KiB/);
	assert.throws(() => validateVisualWrite("() => null", "x".repeat(VISUAL_LIMITS.dataBytes)), /1 MiB/);
	assert.throws(() => validateVisualWrite("<div>chart</div>", null), /String\(visual\)/);
	assert.throws(() => validateVisualWrite("() => null", { big: 1n }), /data must be JSON/);
	assert.equal(validateVisualWrite("  function visual() {}", undefined), "null");
	assert.equal(validateVisualWrite("async () => null", [1, "a"]), '[1,"a"]');
	assert.equal(validateVisualWrite("x => x", {}), "{}");
});

test("the worker check reports errors with console output and accepts valid visuals", async () => {
	await assert.rejects(
		checkVisual({
			source:
				'function visual({ ui }) {\n  console.log("building");\n  return () => ui.text("x", { colour: "red" });\n}',
			data: "null",
			id: "a",
		}),
		(error: unknown) =>
			error instanceof VisualCheckError &&
			error.message ===
				'Visual check failed. Nothing was published. line 3: text: unknown prop "colour" (allowed: key, size, weight, color, mono, italic, align, lines)\nconsole output:\nbuilding',
	);
	await assert.rejects(
		checkVisual({ source: "() => {\n  const f = (n) => f(n + 1) + 1;\n  return f(0);\n}", data: "null", id: "a" }),
		/line 2: RangeError: Maximum call stack size exceeded/,
	);
	const visual = await checkVisual({
		source: latency,
		data: JSON.stringify({ labels: ["a"], p95: [1], p99: [2] }),
		id: "a",
	});
	assert.deepEqual(visual, {
		api: 1,
		engine: "quickjs-ng 0.17.0",
		check: { nodes: 4, controls: 1, interactions: 1, logs: [] },
	});
});

test("an aborted check stops its worker", async () => {
	const controller = new AbortController();
	const pending = checkVisual({ source: "() => () => null", data: "null", id: "a" }, { signal: controller.signal });
	controller.abort(new Error("stop"));
	await assert.rejects(pending, /stop/);
});

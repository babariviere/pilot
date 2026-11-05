import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { type TestContext, test } from "node:test";
import threads from "node:worker_threads";
import { checkVisual, type VisualCheckObserver } from "./index.ts";

const input = { source: "function visual() {}", data: "null", id: "fixture" };
const loaded = { wasm: {}, runtime: "fixture runtime" };
const successful = {
	ok: true,
	engine: "fixture-engine",
	report: { nodes: 1, controls: 0, interactions: 0, draws: 0, logs: [] },
	shaders: [{ glsl: "fixture shader", inputs: [], name: "fixture" }],
	translations: [{ msl: "fixture metal", entry: "main" }],
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
class FixtureWorker extends EventEmitter {
	joining = deferred<void>();
	joined = deferred<number>();
	terminate = () => {
		this.joining.resolve();
		return this.joined.promise;
	};
}
function workers(t: TestContext) {
	const instances: FixtureWorker[] = [];
	const created = [deferred<FixtureWorker>(), deferred<FixtureWorker>()];
	t.mock.method(
		threads,
		"Worker",
		class extends FixtureWorker {
			constructor() {
				super();
				instances.push(this);
				created[instances.length - 1]!.resolve(this);
			}
		},
	);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return { instances, created };
}
function trace() {
	const stages: string[] = [];
	const observer: VisualCheckObserver = {
		stage: (stage, state) => stages.push(`${stage}:${state}`),
		initial: () => {},
	};
	return { stages, observer };
}

test("loading lies outside the initial worker timer; cancellation still joins the load", async (t) => {
	const w = workers(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const load = deferred<typeof loaded>();
	const controller = new AbortController();
	const { stages, observer } = trace();
	let settled = false;
	const running = checkVisual(input, { load: () => load.promise, timeoutMs: 7, signal: controller.signal, observer });
	const checked = assert.rejects(
		running.finally(() => {
			settled = true;
		}),
		{ name: "AbortError" },
	);
	t.mock.timers.tick(30_000);
	controller.abort();
	await Promise.resolve();
	assert.equal(settled, false);
	assert.equal(w.instances.length, 0);
	load.resolve(loaded);
	await checked;
	assert.deepEqual(stages, ["loading:started", "loading:unavailable", "loading:joined"]);
});

test("loading failure is unavailable and never starts a worker", async (t) => {
	const w = workers(t);
	const { stages, observer } = trace();
	await assert.rejects(
		checkVisual(input, {
			load: async () => {
				throw new Error("WASM missing");
			},
			observer,
		}),
		/WASM missing/,
	);
	assert.deepEqual(stages, ["loading:started", "loading:unavailable", "loading:joined"]);
	assert.equal(w.instances.length, 0);
});

test("initial timer expiry waits for actual worker termination", async (t) => {
	const w = workers(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { stages, observer } = trace();
	let settled = false;
	const running = checkVisual(input, { load: async () => loaded, timeoutMs: 7, observer });
	const checked = assert.rejects(
		running.finally(() => {
			settled = true;
		}),
		/Visual check timed out/,
	);
	const first = await w.created[0]!.promise;
	t.mock.timers.tick(6);
	assert.equal(settled, false);
	t.mock.timers.tick(1);
	await first.joining.promise;
	assert.equal(settled, false);
	assert.equal(stages.includes("initial:joined"), false);
	first.joined.resolve(1);
	await checked;
	assert.ok(stages.includes("initial:failed"));
	assert.ok(stages.includes("initial:joined"));
});

for (const stop of ["timeout", "abort"] as const) {
	test(`later shader ${stop} uses its own stage and joins before rejecting`, async (t) => {
		const w = workers(t);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const controller = new AbortController();
		const { stages, observer } = trace();
		let settled = false;
		const running = checkVisual(input, {
			load: async () => loaded,
			timeoutMs: 7,
			signal: controller.signal,
			observer,
		});
		const checked = assert.rejects(
			running.finally(() => {
				settled = true;
			}),
			stop === "timeout" ? /Shader check timed out/ : { name: "AbortError" },
		);
		const first = await w.created[0]!.promise;
		first.emit("message", successful);
		await first.joining.promise;
		first.joined.resolve(1);
		const shader = await w.created[1]!.promise;
		// The 7ms initial timer is already cleared. It is not a deadline for this stage.
		t.mock.timers.tick(8);
		assert.equal(settled, false);
		if (stop === "timeout") t.mock.timers.tick(10_000 - 8);
		else controller.abort();
		await shader.joining.promise;
		shader.emit("message", { diagnostics: [] }); // Late success cannot undo timeout/abort.
		assert.equal(settled, false);
		assert.equal(stages.includes("glsl:joined"), false);
		shader.joined.resolve(1);
		await checked;
		assert.ok(stages.includes("glsl:unavailable"));
		assert.ok(stages.includes("glsl:joined"));
		assert.equal(stages.includes("glsl:passed"), false);
	});
}

test("cancellation at initial admission cannot miss the listener or release before join", async (t) => {
	const w = workers(t);
	const controller = new AbortController();
	let settled = false;
	const running = checkVisual(input, {
		load: async () => loaded,
		signal: controller.signal,
		observer: {
			stage: (stage, state) => {
				if (stage === "initial" && state === "started") controller.abort();
			},
			initial: () => assert.fail("No late result"),
		},
	});
	const checked = assert.rejects(
		running.finally(() => {
			settled = true;
		}),
		{ name: "AbortError" },
	);
	const first = await w.created[0]!.promise;
	await first.joining.promise;
	first.emit("message", successful);
	assert.equal(settled, false);
	first.joined.resolve(1);
	await checked;
	assert.equal(w.instances.length, 1);
});

for (const stage of ["initial", "glsl"] as const) {
	test(`${stage} termination rejection is not reported as a join`, async (t) => {
		const w = workers(t);
		const { stages, observer } = trace();
		const running = checkVisual(input, { load: async () => loaded, observer });
		const checked = assert.rejects(running, /termination unconfirmed/);
		const first = await w.created[0]!.promise;
		if (stage === "initial")
			first.terminate = async () => {
				throw new Error("termination unconfirmed");
			};
		first.emit("message", successful);
		if (stage === "glsl") {
			await first.joining.promise;
			first.joined.resolve(1);
			const shader = await w.created[1]!.promise;
			shader.terminate = async () => {
				throw new Error("termination unconfirmed");
			};
			shader.emit("message", { diagnostics: [] });
		}
		await checked;
		assert.equal(stages.includes(`${stage}:joined`), false);
	});
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import threads, { type WorkerOptions } from "node:worker_threads";
import { parseStoredVisualRevision } from "@pilot/artifacts";
import { CriticalReviewStore } from "./critical-review-store.ts";
import { CriticalReviewVault } from "./critical-review-vault.ts";
import { deliveryDigest } from "./mission-delivery-evidence.ts";
import { MissionStore } from "./missions.ts";
import { captureRetainedArtifact, type RetainedArtifactHost, reopenRetainedArtifact } from "./retained-artifact.ts";
import { prepareRetainedVisualPrecheck } from "./retained-visual-precheck.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const simple = "\uFEFFfunction visual({ui,data}) {\r\nreturn () => ui.text(data.text);\r\n}";
const shader = `function visual({ui}) {return () => ui.shader({height: 60, glsl: "void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }"});}`;
const options = { now: 1234567, timeoutMs: 30_000 };
const engine = "quickjs-ng 0.17.0";

test("frozen file-module loading never delegates live body reads, unlike builtins", async (t) => {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "retained-loader-")));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const target = pathToFileURL(join(root, "fixture.mjs")).href;
	const unknown = pathToFileURL(join(root, "unknown.mjs")).href;
	// Later disk bodies differ from the frozen bytes. No installed package is touched.
	for (const url of [target, unknown]) await fs.writeFile(new URL(url), 'throw new Error("live body");');
	const source = "export const value = 'frozen';";
	const loader = await fs.readFile(new URL("./retained-visual-loader.mjs", import.meta.url));
	const worker = new threads.Worker(
		`
		const { parentPort, workerData } = require("node:worker_threads");
		const moduleApi = require("node:module");
		let hooks;
		moduleApi.registerHooks = (value) => { hooks = value; return { deregister() {} }; };
		moduleApi.syncBuiltinESMExports();
		(async () => {
			await import(workerData.loader);
			let liveLoads = 0;
			let builtins = 0;
			const forbidden = () => { liveLoads++; throw new Error("live file body loader invoked"); };
			hooks.resolve("./fixture.mjs", {}, () => ({ url: workerData.target, format: "module" }));
			const direct = hooks.load(workerData.target, { format: "module" }, forbidden);
			const resolved = hooks.load(workerData.target, {}, forbidden);
			const unsupported = [];
			for (const [url, format] of [[workerData.target, "commonjs"], [workerData.target, "wasm"], [workerData.unknown, undefined]]) {
				try { hooks.load(url, { format }, forbidden); unsupported.push("accepted"); }
				catch (error) { unsupported.push(error.message); }
			}
			const builtin = hooks.load("node:path", {}, () => { builtins++; return { format: "builtin" }; });
			parentPort.postMessage({ liveLoads, builtins, unsupported, builtin: builtin.format,
				direct: { format: direct.format, source: direct.source.toString(), shortCircuit: direct.shortCircuit },
				resolved: { format: resolved.format, source: resolved.source.toString(), shortCircuit: resolved.shortCircuit } });
			parentPort.close();
		})().catch(error => { throw error; });
	`,
		{
			eval: true,
			execArgv: [],
			workerData: {
				loader: `data:text/javascript;base64,${loader.toString("base64")}`,
				target,
				unknown,
				snapshot: {
					files: [target, unknown].map((url) => ({
						url,
						label: url === target ? "fixture.mjs" : "unknown.mjs",
						bytes: Buffer.from(source),
					})),
				},
			},
		},
	);
	t.after(async () => {
		await worker.terminate();
	});
	const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
		let value: Record<string, unknown> | undefined;
		worker.once("message", (message) => {
			value = message;
		});
		worker.once("error", reject);
		worker.once("exit", (code) =>
			code === 0 && value ? resolve(value) : reject(new Error(`Loader fixture exited ${code}`)),
		);
	});
	assert.equal(result.liveLoads, 0);
	assert.equal(result.builtins, 1);
	assert.equal(result.builtin, "builtin");
	assert.deepEqual(result.direct, { format: "module", source, shortCircuit: true });
	assert.deepEqual(result.resolved, result.direct);
	assert.deepEqual(result.unsupported, Array(3).fill("Unsupported precheck module format"));
});

async function fixture(
	t: TestContext,
	source = simple,
	prepared?: Awaited<ReturnType<typeof prepareRetainedVisualPrecheck>>,
) {
	const executor = prepared ?? (await prepareRetainedVisualPrecheck(options, engine));
	const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "retained-precheck-")));
	const records = new CriticalReviewStore(join(home, "records.sqlite"));
	const vault = new CriticalReviewVault(join(home, "vault"), records);
	const store = new MissionStore(":memory:");
	t.after(async () => {
		await store.durable();
		store.close();
		await records.close();
		await fs.rm(home, { recursive: true, force: true });
	});
	const artifact = {
		id: "12345678-1234-1234-1234-123456789abc",
		revision: 1,
		sessionId: "owner",
		projectId: "project",
		kind: "visual",
		title: "Stored fixture",
		source,
		html: "",
		data: { text: "é😀\r\n" },
		libraries: [],
		createdAt: 17,
		updatedAt: 23,
		visual: { api: 1, engine: "historical-engine-not-current", check: { nodes: 999 } },
	};
	const { source: _source, html: _html, ...metadata } = artifact;
	const observation = {
		reference: { kind: "artifact" as const, artifactId: artifact.id, revision: 1 },
		sourceOwnerSessionId: "owner",
		sha256: deliveryDigest({ metadata, sourceSha256: sha(source) }),
		availability: "retained" as const,
	};
	const header: ReturnType<RetainedArtifactHost["observe"]>["header"] = {
		version: 1,
		hostId: "host",
		daemonLineageId: "lineage",
		projectId: "project",
		missionId: "mission",
		taskId: "task",
		runId: "run",
		coordinatorSessionId: "coordinator",
		ownerSessionId: "owner",
		definitionRevision: 1,
		assignment: {
			version: 1,
			revision: 1,
			intent: "Test visual",
			scope: "Stored fixture",
			criteria: ["limited validator"],
			classification: {
				version: 1,
				effort: "small",
				difficulty: "routine",
				risk: "low",
				uncertainty: "known",
				scope: "bounded",
				role: "explorer",
				deliveryKind: "research",
			},
		},
		contextFence: {
			briefRevision: 1,
			decisionEventId: 1,
			artifactEventId: 1,
			memberEventId: 1,
			coordinatorEventId: 1,
		},
		policyId: "policy",
		submissionId: "submission",
		allocationId: "allocation",
		contextPackageSha256: sha("context"),
		profile: {
			profileId: "profile",
			revision: 1,
			definition: {
				version: 1,
				purpose: "Test",
				rubric: "Test",
				applicableIntents: ["research"],
				modelSelection: { provider: "fixture", model: "never-called" },
				reasoningEffort: null,
				timeLimitMs: 1000,
				outputInterpretation: { kind: "pass-fail", pass: "No issues", fail: "Issues" },
			},
		},
		runtime: {
			buildSha256: sha("review-build"),
			configSha256: sha("review-config"),
			provider: "fixture",
			model: "never-called",
			promptVersion: "1",
			toolSchemaVersion: "1",
			outputSchemaVersion: 1,
		},
	};
	const ref = { artifactId: artifact.id, revision: 1, kind: "visual" as const, sourceOwnerSessionId: "owner" };
	const bytes = Buffer.from(`\uFEFF${JSON.stringify(artifact, null, 2).replaceAll("\n", "\r\n")}`);
	let allowed = true;
	const host: RetainedArtifactHost = {
		vault,
		knownSecrets: [],
		observe: () => {
			if (!allowed) throw new Error("Current access revoked");
			return { header, observation, validator: executor.validator };
		},
		read: async () =>
			parseStoredVisualRevision(bytes, { id: artifact.id, revision: 1, sessionId: "owner", projectId: "project" }),
	};
	const captured = await captureRetainedArtifact(store, host, ref);
	assert.equal(captured.state, "captured");
	if (captured.state !== "captured") throw new Error("Fixture capture partial");
	return {
		executor,
		descriptor: captured.input.descriptor,
		host,
		header,
		input: captured.input,
		revoke: () => {
			allowed = false;
		},
		reopen: (d: unknown, signal?: AbortSignal) => reopenRetainedArtifact(store, host, d, signal),
	};
}

test("real host execution uses sealed derived bytes, frozen configuration and fresh engine", async (t) => {
	const f = await fixture(t);
	const result = await f.executor.run(f.descriptor, f.reopen);
	assert.equal(result.state, "passed", result.reason ?? "");
	assert.equal(result.joined, true);
	assert.equal(result.descriptorSha256, f.input.descriptorSha256);
	assert.equal(result.runId, "run");
	assert.equal(result.configuration.options.now, options.now);
	assert.equal(result.report!.engine, engine);
	assert.equal(result.report!.check.nodes, 1);
	assert.equal(result.sampling.limits.interactions, 24);
	assert.equal(result.sampling.limits.checkedDraws, 96);
	assert.ok(result.stages.some((s) => s.stage === "loading" && s.state === "passed"));
	assert.ok(result.stages.some((s) => s.stage === "initial" && s.state === "joined"));
	assert.ok(result.settledAt >= result.startedAt);
	assert.notEqual(result.startedAt, 17);
	const host = result.execution.find((e) => e.scope === "host")!;
	assert.ok(host.receipt.assets.some((p) => p.label === "quickjs-wasi/quickjs.wasm"));
	assert.ok(host.receipt.assets.some((p) => p.label === "visual/runtime.js"));
	assert.ok(
		result.execution
			.find((e) => e.scope === "initial")!
			.receipt.modules.some((p) => p.label === "visual/check-worker.ts"),
	);
});

test("real shader execution records Metal inside initial worker and later joined GLSL stage", async (t) => {
	const f = await fixture(t, shader);
	const result = await f.executor.run(f.descriptor, f.reopen);
	assert.equal(result.state, "passed", result.reason ?? "");
	assert.equal(result.report!.check.shaders, 1);
	assert.ok(
		result.stages.findIndex((s) => s.stage === "metal" && s.state === "passed") <
			result.stages.findIndex((s) => s.stage === "initial" && s.state === "joined"),
	);
	for (const stage of ["glsl", "metal"])
		assert.ok(result.stages.some((s) => s.stage === stage && s.state === "passed"));
	assert.ok(result.stages.some((s) => s.stage === "glsl" && s.state === "joined"));
	assert.ok(
		result.execution
			.find((e) => e.scope === "initial")!
			.receipt.assets.some((p) => p.label === "naga-wasm/dist/wasm/naga_bg.wasm"),
	);
	assert.ok(
		result.execution
			.find((e) => e.scope === "glsl")!
			.receipt.assets.some((p) => p.label === "glslang-wasm-validator/dist/glslang-validator.wasm"),
	);
});

async function fixtureInstallation(t: TestContext, replace: (path: string, bytes: Buffer) => Buffer) {
	const read = fs.readFile;
	const open = fs.open;
	t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		if (args[0] === process.execPath) return open(...args);
		// In-memory replacement of isolated snapshot reads. Installed files are never written.
		const bytes = await read(args[0]);
		return memoryHandle(replace(String(args[0]), bytes)).handle;
	});
	syncBuiltinESMExports();
	try {
		return await prepareRetainedVisualPrecheck(options, engine);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
}

function memoryHandle(bytes: Buffer, beforeSize = bytes.length, afterSize = beforeSize) {
	const reads: number[] = [];
	let stats = 0;
	let closed = false;
	return {
		reads,
		closed: () => closed,
		handle: {
			stat: async () => ({
				size: ++stats === 1 ? beforeSize : afterSize,
				mtimeMs: 1,
				ctimeMs: 1,
				isFile: () => true,
			}),
			read: async (target: Buffer, offset: number, length: number, position: number) => {
				reads.push(length);
				return { bytesRead: bytes.copy(target, offset, position, position + length), buffer: target };
			},
			close: async () => {
				closed = true;
			},
		},
	};
}

for (const changed of ["growth", "oversize"] as const) {
	test(`snapshot ${changed} refuses with pre-allocation/read bounds and closes its handle`, async (t) => {
		const file = memoryHandle(
			Buffer.from("grew beyond fstat"),
			changed === "growth" ? 4 : 32 * 1024 * 1024 + 1,
			1024 * 1024 * 1024,
		);
		const allocations: number[] = [];
		const alloc = Buffer.alloc;
		t.mock.method(Buffer, "alloc", (size: number) => {
			allocations.push(size);
			return alloc(size);
		});
		t.mock.method(fs, "open", async () => file.handle);
		syncBuiltinESMExports();
		t.after(() => {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		});
		await assert.rejects(
			prepareRetainedVisualPrecheck(options, engine),
			changed === "growth" ? /file changed/ : /installation size/,
		);
		assert.deepEqual(allocations, changed === "growth" ? [5] : []);
		assert.deepEqual(file.reads, changed === "growth" ? [5] : []);
		assert.equal(file.closed(), true);
	});
}

test("package metadata is capped before hydration", async (t) => {
	const open = fs.open;
	const metadata = memoryHandle(Buffer.from("{}"), 64 * 1024 + 1);
	let selected = 0;
	t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		if (String(args[0]).endsWith("/quickjs-wasi/package.json")) {
			selected++;
			return metadata.handle;
		}
		return open(...args);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await assert.rejects(prepareRetainedVisualPrecheck(options, engine), /installation size/);
	assert.equal(selected, 1);
	assert.deepEqual(metadata.reads, []);
	assert.equal(metadata.closed(), true);
});

test("metadata and assets both consume the same remaining byte allowance", async (t) => {
	const metadata = memoryHandle(Buffer.from(JSON.stringify({ name: "quickjs-wasi" }).padEnd(64 * 1024)));
	// Four one-byte code files are captured before this package metadata and synthetic asset.
	const asset = memoryHandle(Buffer.from("fixture asset"), 32 * 1024 * 1024 - 4 - 64 * 1024 + 1);
	t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		if (String(args[0]).endsWith("/quickjs-wasi/package.json")) return metadata.handle;
		if (String(args[0]).endsWith("/budget.wasm")) return asset.handle;
		return memoryHandle(Buffer.from("x")).handle;
	});
	t.mock.method(fs, "opendir", async (path: string) => {
		return {
			async *[Symbol.asyncIterator]() {
				if (path.endsWith("/quickjs-wasi")) yield { name: "budget.wasm", isFile: (): boolean => true };
			},
		};
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await assert.rejects(prepareRetainedVisualPrecheck(options, engine), /installation size/);
	assert.deepEqual(asset.reads, []); // The captured metadata reduced the remaining allowance too.
	assert.equal(asset.closed(), true);
	assert.equal(metadata.closed(), true);
});

test("valid package metadata is parsed from one captured file-handle acquisition", async (t) => {
	let reads = 0;
	await fixtureInstallation(t, (path, bytes) => {
		if (path.endsWith("/quickjs-wasi/package.json")) reads++;
		return bytes;
	});
	assert.equal(reads, 1);
});

test("a growing snapshot file uses small reads and stops at the opened size plus one", async (t) => {
	const size = 128 * 1024;
	const file = memoryHandle(Buffer.alloc(size + 1), size, 1024 * 1024 * 1024);
	t.mock.method(fs, "open", async () => file.handle);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await assert.rejects(prepareRetainedVisualPrecheck(options, engine), /file changed/);
	assert.deepEqual(file.reads, [64 * 1024, 64 * 1024, 1]);
	assert.equal(file.closed(), true);
});

test("file count is checked before opening another selected file", async (t) => {
	let opened = 0;
	let yielded = 0;
	let closed = false;
	t.mock.method(fs, "open", async () => {
		opened++;
		return memoryHandle(Buffer.from("x")).handle;
	});
	t.mock.method(fs, "opendir", async () => ({
		async *[Symbol.asyncIterator]() {
			try {
				for (let i = 0; i < 100_000; i++) {
					yielded++;
					yield { name: "check.ts", isFile: (): boolean => true };
				}
			} finally {
				closed = true;
			}
		},
	}));
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await assert.rejects(prepareRetainedVisualPrecheck(options, engine), /installation size/);
	assert.equal(opened, 4096); // Two bootstrap files and 4094 selected entries.
	assert.equal(yielded, 4095);
	assert.equal(closed, true);
});

test("directory entry budget stops incrementally across roots, including excluded files", async (t) => {
	const opendir = fs.opendir;
	let yielded = 0;
	let closed = 0;
	t.mock.method(fs, "opendir", async (path: string, settings?: { bufferSize?: number }) => {
		const visual = path.endsWith("/src/visual/") || path.endsWith("/src/visual");
		const dependency = path.endsWith("/quickjs-wasi");
		if (!visual && !dependency) return opendir(path, settings);
		assert.equal(settings?.bufferSize, 1);
		return {
			async *[Symbol.asyncIterator]() {
				try {
					for (let i = 0; i < (visual ? 4096 : 100_000); i++) {
						yielded++;
						yield { name: `excluded-${i}.txt`, isFile: (): boolean => true, isDirectory: (): boolean => false };
					}
				} finally {
					closed++;
				}
			},
		};
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await assert.rejects(prepareRetainedVisualPrecheck(options, engine), /directory entry count/);
	assert.equal(yielded, 8193); // Budget plus one bounded sentinel, not the full tree.
	assert.equal(closed, 2);
});

for (const phase of ["loading", "initial", "glsl"] as const) {
	test(`real host cancellation during ${phase} suppresses output and awaits owned exit`, async (t) => {
		const f = await fixture(t, phase === "glsl" ? shader : simple);
		const controller = new AbortController();
		const Worker = threads.Worker;
		let exited = false;
		t.mock.method(
			threads,
			"Worker",
			class extends Worker {
				constructor(url: string | URL, options: WorkerOptions) {
					super(url, options);
					this.on("message", (message) => {
						if (message.type === "stage" && message.stage === phase && message.state === "started")
							controller.abort();
					});
					this.on("exit", () => {
						exited = true;
					});
				}
			},
		);
		syncBuiltinESMExports();
		t.after(() => {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		});
		const result = await f.executor.run(f.descriptor, f.reopen, controller.signal);
		assert.equal(result.state, "cancelled");
		assert.equal(result.report, undefined);
		assert.equal(result.joined, true);
		assert.equal(exited, true);
	});
}

for (const broken of ["load", "initial", "stages", "config", "exit", "join", "format"] as const) {
	test(`isolated ${broken} runtime failure or incomplete trace cannot Pass`, async (t) => {
		const executor = await fixtureInstallation(t, (path, bytes) => {
			if (broken === "load" && path.endsWith("quickjs.wasm")) return Buffer.from("bad WASM");
			if (broken === "initial" && path.endsWith("naga_bg.wasm")) return Buffer.from("bad WASM");
			if (broken === "stages" && path.endsWith("visual/index.ts"))
				return Buffer.from(
					bytes.toString().replace('observer?.stage("glsl", errors.length ? "failed" : "passed", index);', ";"),
				);
			if (broken === "config" && path.endsWith("retained-visual-worker.ts"))
				return Buffer.from(
					bytes.toString().replace("initialWorkerTimeoutOnly: true", "initialWorkerTimeoutOnly: false"),
				);
			if (broken === "exit" && path.endsWith("retained-visual-worker.ts"))
				return Buffer.from(bytes.toString().replace('send({ type: "settled" });', ";"));
			if (broken === "join" && path.endsWith("visual/index.ts"))
				return Buffer.from(bytes.toString().replace('observer?.stage("initial", "joined");', ";"));
			if (broken === "format" && path.endsWith("retained-visual-loader.mjs"))
				return Buffer.from(
					bytes
						.toString()
						.replace("const format = context.format ?? formats.get(url);", 'const format = "commonjs";'),
				);
			return bytes;
		});
		const f = await fixture(t, shader, executor);
		const result = await executor.run(f.descriptor, f.reopen);
		assert.equal(result.state, "unavailable", result.reason ?? "");
		assert.equal(result.report, undefined);
		assert.equal(result.workerExited, true);
		assert.equal(result.joined, broken !== "exit" && broken !== "join" && broken !== "format");
	});
}

test("actual reported engine mismatch cannot Pass", async (t) => {
	const executor = await prepareRetainedVisualPrecheck(options, "not-the-current-engine");
	const f = await fixture(t, simple, executor);
	const result = await executor.run(f.descriptor, f.reopen);
	assert.equal(result.state, "mismatch");
	assert.equal(result.report, undefined);
	assert.equal(result.joined, true);
});

test("actual execution receives the bound clock, derived data and deterministic seed", async (t) => {
	const f = await fixture(
		t,
		`function visual({ui,data}) { return () => {
		console.log(JSON.stringify({ now: Date.now(), random: Math.random(), text: data.text }));
		return ui.text(data.text);
	}; }`,
	);
	const first = await f.executor.run(f.descriptor, f.reopen);
	const second = await f.executor.run(f.descriptor, f.reopen);
	assert.equal(first.state, "passed", first.reason ?? "");
	assert.equal(second.state, "passed", second.reason ?? "");
	assert.deepEqual(first.report!.check.logs, second.report!.check.logs);
	const actual = JSON.parse(first.report!.check.logs[0]!);
	assert.equal(actual.now, options.now);
	assert.equal(actual.text, "é😀\r\n");
	assert.equal(typeof actual.random, "number");
});

test("sample cap is partial, not a passing check", async (t) => {
	const f = await fixture(
		t,
		`function visual({ui}) {return () => ui.row(Array.from({length:30}, (_,i) => ui.button({label:String(i), onClick:()=>{}})));}`,
	);
	const result = await f.executor.run(f.descriptor, f.reopen);
	assert.equal(result.state, "partial", result.reason ?? "");
	assert.equal(result.report!.check.interactions, 24);
	assert.equal(result.joined, true);
});

test("visual failure is recorded, not Pass", async (t) => {
	const f = await fixture(t, 'function visual(){ throw new Error("fixture failure"); }');
	const result = await f.executor.run(f.descriptor, f.reopen);
	assert.equal(result.state, "failed", result.reason ?? "");
	assert.match(result.reason!, /fixture failure/);
	assert.equal(result.joined, true);
});

test("unavailable later shader runtime cannot Pass (corrupt isolated byte snapshot)", async (t) => {
	const executor = await fixtureInstallation(t, (path, bytes) =>
		path.endsWith("glslang-validator.wasm") ? Buffer.from("unavailable fixture wasm") : bytes,
	);
	const f = await fixture(t, shader, executor);
	const result = await executor.run(f.descriptor, f.reopen);
	assert.equal(result.state, "unavailable", result.reason ?? "");
	assert.ok(result.stages.some((s) => s.stage === "glsl" && s.state === "unavailable"));
	assert.ok(result.stages.some((s) => s.stage === "glsl" && s.state === "joined"));
	assert.equal(result.joined, true);
});

test("mismatched config, engine, arguments or revoked final access cannot Pass", async (t) => {
	const f = await fixture(t);
	const altered = structuredClone(f.descriptor);
	altered.validator.configSha256 = "a".repeat(64);
	assert.equal((await f.executor.run(altered, f.reopen)).state, "unavailable");
	const wrong = await prepareRetainedVisualPrecheck(options, "wrong-current-engine");
	assert.equal((await wrong.run(f.descriptor, f.reopen)).state, "mismatch");
	const forged = structuredClone(f.input);
	forged.validationInput = { ...forged.validationInput, dataJSON: '"different"' };
	assert.equal((await f.executor.run(f.descriptor, async () => forged)).state, "mismatch");
	let reads = 0;
	const result = await f.executor.run(f.descriptor, async (...args) => {
		if (++reads === 2) f.revoke();
		return f.reopen(...args);
	});
	assert.equal(result.state, "unavailable");
	assert.equal(result.report, undefined);
	assert.equal(result.joined, true);
});

test("already cancelled preparation returns no result and starts no worker", async (t) => {
	const f = await fixture(t);
	const c = new AbortController();
	c.abort();
	const result = await f.executor.run(f.descriptor, async () => assert.fail("No read after cancellation"), c.signal);
	assert.equal(result.state, "cancelled");
	assert.deepEqual(result.stages, []);
	assert.equal(result.joined, true);
});

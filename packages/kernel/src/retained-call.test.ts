import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type {
	RetainedCallableDelta,
	RetainedCallInput,
	RetainedCallProvider,
	RetainedCallQuery,
	RetainedCallResult,
} from "./retained-call-contract.ts";
import { compareRetainedCalls } from "./retained-call-runner.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Files = Record<string, string | Uint8Array>;
function fixture(before: Files, after: Files) {
	const blobs = { before: new Map<string, Uint8Array>(), after: new Map<string, Uint8Array>() };
	const entries = (files: Files, side: "before" | "after") =>
		Object.entries(files).map(([path, content]) => {
			const bytes = typeof content === "string" ? Buffer.from(content) : content;
			blobs[side].set(path, bytes);
			return {
				path,
				state: "text" as const,
				mode: "100644",
				gitOid: "a".repeat(40),
				bytes: bytes.length,
				sha256: hash(bytes),
			};
		});
	const input: RetainedCallInput = {
		storeId: "a".repeat(64),
		snapshotId: "b".repeat(64),
		status: "complete",
		request: {
			repositoryId: "c".repeat(64),
			requestId: "retained",
			changeId: "k".repeat(32),
			operationId: "d".repeat(128),
			base: { changeId: "l".repeat(32), commitId: "e".repeat(40) },
			head: { changeId: "k".repeat(32), commitId: "f".repeat(40) },
			scope: { kind: "layer" },
			source: "committed",
		},
		before: entries(before, "before"),
		after: entries(after, "after"),
	};
	const reads: string[] = [];
	let admissions = 0;
	const provider: RetainedCallProvider = {
		input,
		authorize: async () => {
			admissions++;
		},
		read: async (ref) => {
			reads.push(`${ref.side}/${ref.path}`);
			return blobs[ref.side].get(ref.path)!;
		},
	};
	return { input, provider, blobs, reads, admissions: () => admissions };
}
async function all(provider: RetainedCallProvider, query: RetainedCallQuery = {}) {
	let result = await compareRetainedCalls(provider, query);
	const rows = [...result.results];
	while (result.page.nextOffset !== null) {
		result = await compareRetainedCalls(provider, {
			...query,
			offset: result.page.nextOffset,
			expectedRevision: result.revision,
		});
		rows.push(...result.results);
	}
	return { ...result, results: rows };
}
function row(result: RetainedCallResult, name: string, path?: string): RetainedCallableDelta {
	const rows = result.results.filter((r) =>
		[...r.before, ...r.after].some((e) => e.name === name && (!path || e.declaration.path === path)),
	);
	assert.equal(rows.length, 1, name);
	return rows[0]!;
}

test("12-file retained pair separates bodies, headers, outgoing multisets and unchanged callers", async () => {
	const before: Files = {
		"a.ts": "export function leaf() { return 1; }",
		"b.js": "export function other() { return 2; }",
		"caller.ts": "import { leaf } from './a.ts'; export function caller() { return leaf(); }",
		"import.ts": "import { leaf as fn } from './a.ts'; export const imported = () => fn();",
		"header.ts": "export function header(x: number = 1): number { return x; }",
		"move.ts": "function target() {} function move() { target();\n }",
		"repeat.ts": "function target() {} function repeat() { target(); }",
		"gone.ts": "export function gone() {}",
		"new.ts": "export const original = function () { return 1; };",
		"cycle.ts": "function cycleA() { cycleB(); } function cycleB() { cycleA(); }",
		"diamond.ts":
			"function root() {} function left() { root(); } function right() { root(); } function top() { left(); right(); }",
		"context.ts": "function context() { const nested = () => 1; return nested(); } class C { method() {} }",
	};
	const after = {
		...before,
		"a.ts": "export function leaf() { return 10; }",
		"import.ts": "import { other as fn } from './b.js'; export const imported = () => fn();",
		"header.ts": "export function header(x: number = 2): number { return x; }",
		"move.ts": "function target() {} function move() {\n  target();\n }",
		"repeat.ts": "function target() {} function repeat() { target(); target(); }",
		"gone.ts": "",
		"new.ts": "export const original = function () { return 1; }; export const added = () => 2;",
	};
	const f = fixture(before, after),
		result = await all(f.provider);
	assert.equal(result.coverage.before.parsed, 12);
	assert.equal(result.coverage.after.parsed, 12);
	assert.equal(result.mode, "source-inferred-not-runtime");
	assert.equal(result.exhaustive, false);
	assert.deepEqual(result.pair.request, f.input.request);
	assert.equal(row(result, "leaf").bodyChanged, true);
	assert.equal(row(result, "leaf").outgoingRelationshipChanged, false);
	assert.equal(row(result, "caller").bodyChanged, false, "callee edit does not modify caller");
	assert.equal(row(result, "caller").outgoingRelationshipChanged, false);
	assert.equal(row(result, "imported").bodyChanged, false);
	assert.equal(row(result, "imported").headerChanged, false);
	assert.equal(row(result, "imported").outgoingRelationshipChanged, true);
	assert.equal(row(result, "header").headerChanged, true);
	assert.equal(row(result, "header").bodyChanged, false);
	assert.equal(row(result, "move").bodyChanged, true);
	assert.equal(row(result, "move").outgoingRelationshipChanged, false);
	assert.equal(row(result, "repeat").outgoingRelationshipChanged, true);
	assert.equal(row(result, "repeat").edges.after.length, 2);
	assert.equal(row(result, "gone").status, "removed");
	assert.equal(row(result, "added").status, "added");
	assert.equal(row(result, "original").status, "matched");
	assert.ok(row(result, "cycleA").edges.after[0]!.cycle);
	assert.ok(row(result, "top").edges.after.every((e) => !e.cycle));
	assert.equal(row(result, "context").outgoingRelationshipChanged, null);
	assert.ok(row(result, "context").edges.after[0]!.unpairedTarget);
	assert.ok(result.coverage.after.unpairedFrames > 12);
});

test("lost resolution is not call removal; ambiguity and unsupported invocation kinds stay unknown", async () => {
	const f = fixture(
		{
			"target.ts": "export function target() {}",
			"main.ts": "import { target } from './target'; export function caller() { target(); }",
		},
		{
			"target.ts": "export function target() {}",
			"target.js": "export function target() {}",
			"main.ts": "import { target } from './target'; export function caller() { target(); }",
		},
	);
	const result = await all(f.provider),
		caller = row(result, "caller");
	assert.equal(caller.bodyChanged, false);
	assert.equal(caller.outgoingRelationshipChanged, null);
	assert.equal(caller.lostResolution, true);
	assert.equal(caller.edges.after[0]!.resolution, "ambiguous");
	assert.match(caller.edges.after[0]!.provenance, /multiple-relative/);
	assert.equal(result.coverage.after.ambiguousCalls, 1);
	const code =
		"function target() {} function shadow(target) { target(); } function reassigned() { target = other; target(); } function dynamic() { obj.member(); obj?.optional(); new Thing(); tag``; }";
	const unknown = await all(fixture({ "a.js": code }, { "a.js": code }).provider);
	assert.equal(unknown.coverage.after.unresolvedCalls, 6);
	for (const name of ["shadow", "reassigned", "dynamic"])
		assert.equal(row(unknown, name).outgoingRelationshipChanged, null);
	const typed = await all(
		fixture(
			{ "a.ts": "function t() {} function f() { t(); }" },
			{ "a.ts": "import type { t } from './types'; function f() { t(); }" },
		).provider,
	);
	assert.equal(row(typed, "f").lostResolution, true);
	const removedCall = await all(
		fixture({ "a.ts": "function t() {} function f() { t(); }" }, { "a.ts": "function t() {} function f() {}" })
			.provider,
	);
	assert.equal(row(removedCall, "f").outgoingRelationshipChanged, true);
	assert.equal(row(removedCall, "f").lostResolution, false);
	const hiddenCandidate = fixture(
		{ "target.ts": "export function t() {}", "main.ts": "import { t } from './target'; function f() { t(); }" },
		{
			"target.ts": "export function t() {}",
			"target.js": "export function t(",
			"main.ts": "import { t } from './target'; function f() { t(); }",
		},
	);
	const hidden = row(await all(hiddenCandidate.provider), "f");
	assert.equal(hidden.edges.after[0]!.resolution, "inferred", "shared resolver still reports its scanned prefix");
	assert.equal(hidden.outgoingRelationshipChanged, null, "omitted candidate cannot certify unchanged relationship");
});

test("correspondence never joins renames, moves, overloads, containers, or declaration-kind changes", async () => {
	const f = fixture(
		{
			"a.ts":
				"function oldName() {} const changed = () => 1; function overloaded(x: number): number; function overloaded(x: number) { return x; }",
			"moved.js": "function moved() {}",
			"duplicate.js": "function duplicate() {} function duplicate() {}",
			"nested.js":
				"class A { same() {} } class B { same() {} } function outer() { function inner() {} return inner(); } outer();",
		},
		{
			"a.ts":
				"function newName() {} function changed() { return 1; } function overloaded(x: number): number; function overloaded(x: number) { return x + 1; }",
			"elsewhere.js": "function moved() {}",
			"duplicate.js": "function duplicate() {} function duplicate() {}",
			"nested.js":
				"class A { same() { return 2; } } class B { same() {} } function outer() { function inner() {} return inner(); } outer();",
		},
	);
	const result = await all(f.provider);
	assert.equal(row(result, "oldName").status, "removed");
	assert.equal(row(result, "newName").status, "added");
	assert.equal(row(result, "moved", "moved.js").status, "removed");
	assert.equal(row(result, "moved", "elsewhere.js").status, "added");
	const changes = result.results.filter((r) => [...r.before, ...r.after].some((e) => e.name === "changed"));
	assert.equal(changes.length, 2);
	assert.ok(changes.every((r) => r.status === "unknown" && r.bodyChanged === null));
	assert.ok(
		result.results
			.filter((r) => [...r.before, ...r.after].some((e) => e.name === "overloaded"))
			.every((r) => r.status === "unknown"),
	);
	assert.equal(row(result, "duplicate").status, "unknown");
	assert.ok(
		!result.results.some((r) => [...r.before, ...r.after].some((e) => e.name === "same" || e.name === "inner")),
	);
	assert.equal(row(result, "outer").bodyChanged, false);
	assert.equal(row(result, "outer").outgoingRelationshipChanged, null);
	assert.ok(result.coverage.after.contextCalls >= 1);
	const methods = await compareRetainedCalls(
		fixture({ "a.js": "class C { method() {} }" }, { "a.js": "class C { method() { return 1; } }" }).provider,
	);
	assert.equal(methods.results.length, 0);
	assert.ok(methods.partialReasons.includes("unsupported-or-ambiguous-callable-correspondence"));
	const mutable = await all(fixture({ "a.ts": "const f = () => 1;" }, { "a.ts": "let f = () => 1;" }).provider);
	assert.equal(row(mutable, "f").status, "unknown", "unsupported binding is not proven callable removal");
	const readded = await all(
		fixture({ "a.ts": "function f() { return 1; }" }, { "a.ts": "function f() { throw new Error('replacement'); }" })
			.provider,
	);
	assert.equal(
		row(readded, "f").status,
		"matched",
		"syntactic correspondence cannot prove continuity through delete/re-add",
	);
	assert.equal(row(readded, "f").bodyChanged, true);
});

test("original BOM/CRLF/non-BMP bytes, UTF-8 and UTF-16 spans survive shifted offsets", async () => {
	const before =
		'\uFEFF// café 😀\r\nexport function café(x = "😀") { return "é😀"; }\r\nconst expression = () => "😀";';
	const after = `\uFEFF// unrelated extra 😀\r\n${before.slice(1)}`;
	const f = fixture({ "a.ts": before }, { "a.ts": after }),
		result = await all(f.provider);
	for (const delta of result.results) {
		assert.equal(delta.bodyChanged, false);
		assert.equal(delta.headerChanged, false);
		for (const e of [...delta.before, ...delta.after])
			for (const span of [e.declaration, e.body!, ...e.header]) {
				const text = span.side === "before" ? before : after,
					bytes = f.blobs[span.side].get(span.path)!;
				assert.equal(span.sha256, hash(bytes));
				const slice = bytes.subarray(span.utf8.start, span.utf8.end);
				assert.equal(hash(slice), span.sha256OfSpan);
				assert.equal(
					Buffer.from(slice).toString("utf8"),
					text.slice(span.utf16.start.offset, span.utf16.end.offset),
				);
				assert.equal(span.utf8.start, Buffer.byteLength(text.slice(0, span.utf16.start.offset)));
			}
	}
	const café = row(result, "café");
	assert.equal(café.before[0]!.declaration.utf16.start.line, 2);
	assert.equal(café.after[0]!.declaration.utf16.start.line, 3);
	assert.notEqual(café.before[0]!.frameId, café.after[0]!.frameId);
});

test("absent, unreadable, invalid, partial and unsupported retained inputs never become empty successes", async () => {
	const f = fixture({ "a.ts": "function f() {}" }, { "a.ts": "function f(" });
	const failed = await all(f.provider);
	assert.equal(row(failed, "f").status, "unknown");
	assert.ok(failed.partialReasons.includes("retained-encoding-or-parse-failed"));
	const partial = fixture({ "a.ts": "function f() {}" }, {});
	partial.input.status = "partial";
	assert.equal(row(await all(partial.provider), "f").status, "unknown");
	const invalid = fixture({ "a.ts": Buffer.from([0xff]) }, { "a.ts": "function f() {}", "rust.rs": "fn f() {}" });
	const result = await all(invalid.provider);
	assert.equal(result.coverage.after.unsupported, 1);
	assert.equal(row(result, "f").status, "unknown");
	for (const state of ["binary", "unavailable"] as const) {
		const omitted = fixture({ "a.ts": "function f() {}" }, { "a.ts": "function f() {}" });
		omitted.input.before[0]!.state = state;
		assert.equal(row(await all(omitted.provider), "f").status, "unknown");
	}
	f.provider.read = async () => {
		throw new Error("No retained blob");
	};
	await assert.rejects(compareRetainedCalls(f.provider), /No retained blob/);
	const corrupt = fixture({ "a.ts": "function f() {}" }, { "a.ts": "function f() {}" });
	corrupt.provider.read = async () => Buffer.from("function g() {}");
	await assert.rejects(compareRetainedCalls(corrupt.provider), /byte hash\/size mismatch/);
	corrupt.input.status = "unavailable";
	await assert.rejects(compareRetainedCalls(corrupt.provider), /pair unavailable/);
});

test("one retained pair/scope and current permission bind every stage/read and returned page", async () => {
	const f = fixture(
		{ "a.ts": "function f() {}", "sub/b.ts": "function b() {}" },
		{ "a.ts": "function f() {}", "sub/b.ts": "function b() {}" },
	);
	const result = await compareRetainedCalls(f.provider);
	assert.equal(f.reads.length, 4);
	assert.equal(new Set(f.reads).size, 4, "one read per side/file");
	assert.equal(f.admissions(), 12, "initial, both stages, before/after each read, final");
	for (const mutate of [
		() => {
			f.input.storeId = "1".repeat(64);
		},
		() => {
			f.input.snapshotId = "2".repeat(64);
		},
		() => {
			f.input.request.scope = { kind: "stack" };
		},
		() => {
			f.input.request.base.commitId = "3".repeat(40);
		},
	]) {
		mutate();
		await assert.rejects(compareRetainedCalls(f.provider, { expectedRevision: result.revision }), /revision changed/);
	}
	assert.equal((await compareRetainedCalls(f.provider, { path: "sub" })).results.length, 1);
	const isolated = fixture(
		{
			"sub/main.ts": "import { target } from '../target'; function f() { target(); }",
			"target.ts": "export function target() {}",
		},
		{
			"sub/main.ts": "import { target } from '../target'; function f() { target(); }",
			"target.ts": "export function target() {}",
		},
	);
	assert.equal(row(await all(isolated.provider, { path: "sub" }), "f").edges.before[0]!.resolution, "unresolved");
	let allowed = true;
	f.provider.authorize = async () => {
		if (!allowed) throw new Error("Custody revoked");
	};
	f.provider.read = async () => {
		allowed = false;
		return Buffer.from("function f() {}");
	};
	await assert.rejects(compareRetainedCalls(f.provider), /Custody revoked/);
	const final = fixture({}, {});
	let count = 0;
	final.provider.authorize = async () => {
		if (++count === 4) throw new Error("Revoked at return");
	};
	await assert.rejects(compareRetainedCalls(final.provider), /Revoked at return/);
});

test("aggregate file/byte/graph/edge/result/page bounds preserve honest partial coverage", async () => {
	const huge = fixture({ "a.ts": "function f() {}" }, { "a.ts": `function f() {}${" ".repeat(512 * 1024)}` });
	assert.equal(row(await all(huge.provider), "f").status, "unknown");
	assert.ok(!huge.reads.includes("after/a.ts"));
	const graph = fixture(
		{ "a.ts": "function f() {}", "z.ts": "function neverScanned() {}" },
		{ "a.ts": `const x = [${"() => 0,".repeat(11000)}];`, "z.ts": "function neverScanned() {}" },
	);
	const limited = await compareRetainedCalls(graph.provider);
	assert.ok(limited.partialReasons.includes("call-graph-record-limit"));
	assert.ok(limited.budget.records <= 20_000);
	assert.equal(row(limited, "neverScanned").status, "unknown", "unvisited manifest entry is not absent");
	const manyCalls = `function t() {} function f() {${"t();".repeat(600)}}`;
	const edges = await compareRetainedCalls(fixture({ "a.ts": manyCalls }, { "a.ts": manyCalls }).provider);
	assert.equal(edges.budget.edges, 1000);
	assert.ok(edges.partialReasons.includes("comparison-edge-limit"));
	assert.equal(row(edges, "f").outgoingRelationshipChanged, null);
	assert.ok(row(edges, "f").edgesOmitted);
	assert.ok(Buffer.byteLength(JSON.stringify(edges)) <= 48 * 1024);
	const many = Array.from({ length: 1100 }, (_, i) => `function f${i}() {}`).join("\n");
	const deltas = await compareRetainedCalls(fixture({ "a.ts": many }, { "a.ts": many }).provider);
	assert.equal(deltas.page.retained, 1000);
	assert.ok(deltas.partialReasons.includes("delta-record-limit"));
	assert.ok(deltas.results.length <= 50 && deltas.page.nextOffset !== null);
	assert.ok(Buffer.byteLength(JSON.stringify(deltas)) <= 48 * 1024);
	const text = `//${" ".repeat(510 * 1024)}\nfunction f() {}`;
	const files = Object.fromEntries(Array.from({ length: 34 }, (_, i) => [`${i}.ts`, text]));
	const bytes = await compareRetainedCalls(fixture(files, files).provider);
	assert.ok(bytes.budget.bytes <= 32 * 1024 * 1024);
	assert.ok(bytes.partialReasons.includes("scan-byte-limit"));
});

test("second-side failures, running/queued cancellation join reads and leave admission usable", async () => {
	const failed = fixture({ "a.ts": "function f() {}" }, { "a.ts": "function f() {}" });
	const original = failed.provider.read;
	failed.provider.read = async (ref, signal) => {
		if (ref.side === "after") throw new Error("Second side unavailable");
		return original(ref, signal);
	};
	await assert.rejects(compareRetainedCalls(failed.provider), /Second side unavailable/);
	const controller = new AbortController();
	let started!: () => void, release!: () => void;
	const reading = new Promise<void>((r) => {
		started = r;
	});
	const held = new Promise<void>((r) => {
		release = r;
	});
	const f = fixture({ "a.ts": "function f() {}" }, {});
	f.provider.read = async () => {
		started();
		await held;
		return Buffer.from("function f() {}");
	};
	let settled = false;
	const run = compareRetainedCalls(f.provider, {}, controller.signal).finally(() => {
		settled = true;
	});
	const rejected = assert.rejects(run, /Stopped/);
	await reading;
	controller.abort(new Error("Stopped"));
	await new Promise((r) => setImmediate(r));
	assert.equal(settled, false, "entered provider read must drain before release");
	release();
	await rejected;
	const pre = AbortSignal.abort(new Error("Queued cancel"));
	await assert.rejects(compareRetainedCalls(fixture({}, {}).provider, {}, pre), /Queued cancel/);
	const hold = () => {
		const provider = fixture({ "a.ts": "function f() {}" }, {}).provider;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		provider.read = async (_ref, signal) => {
			entered();
			return new Promise<Uint8Array>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		};
		const controller = new AbortController();
		return {
			started,
			controller,
			done: assert.rejects(compareRetainedCalls(provider, {}, controller.signal), /release held/),
		};
	};
	const heldA = hold(),
		heldB = hold();
	await Promise.all([heldA.started, heldB.started]);
	const queued = new AbortController();
	const queuedResult = assert.rejects(
		compareRetainedCalls(fixture({}, {}).provider, {}, queued.signal),
		/Cancelled in queue/,
	);
	await new Promise((resolve) => setImmediate(resolve));
	queued.abort(new Error("Cancelled in queue"));
	await queuedResult;
	heldA.controller.abort(new Error("release held"));
	heldB.controller.abort(new Error("release held"));
	await Promise.all([heldA.done, heldB.done]);
	assert.equal((await compareRetainedCalls(fixture({}, {}).provider)).results.length, 0);
});

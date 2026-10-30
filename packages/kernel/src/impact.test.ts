import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { parseDeclarations } from "./exploration-parser.ts";
import { runExploration } from "./exploration-runner.ts";
import { positions } from "./exploration-scan.ts";
import type { ImpactPage, ImpactQuery } from "./impact-contract.ts";
import { scanImpact } from "./impact-scan.ts";
import { SourceReader } from "./source-reader.ts";

async function fixture(t: TestContext, files: Record<string, string>) {
	const source = await mkdtemp(join(tmpdir(), "pilot-impact-"));
	t.after(() => rm(source, { recursive: true, force: true }));
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(source, path)), { recursive: true });
		await writeFile(join(source, path), text);
	}
	const symbol = (path: string, name: string) => {
		const declaration = parseDeclarations(files[path]!, path).find((item) => item.name === name)!;
		assert.ok(declaration, name);
		const { line, column } = positions(files[path]!).span(declaration.start, declaration.start).start;
		return { path, line, column };
	};
	const query = (symbols: ImpactQuery["symbols"], options: Partial<ImpactQuery> = {}): ImpactQuery => ({
		tool: "code_impact",
		symbols,
		depth: 6,
		...options,
	});
	const run = (symbols: ImpactQuery["symbols"], options: Partial<ImpactQuery> = {}) =>
		runExploration({ source }, query(symbols, options));
	return { source, symbol, query, run, files };
}

async function assertWitnesses(page: ImpactPage, source: string) {
	assert.equal(new Set(page.results.map((hit) => hit.frame.id)).size, page.results.length);
	for (const hit of page.results) {
		assert.equal(hit.witness.length, hit.distance);
		assert.equal(hit.witness[0]!.from.id, hit.frame.id);
		assert.equal(hit.witness.at(-1)!.to!.id, hit.rootId);
		assert.ok(page.roots.some((root) => root.id === hit.rootId));
		for (let index = 0; index < hit.witness.length; index++) {
			const edge = hit.witness[index]!;
			assert.ok(["resolved", "inferred"].includes(edge.resolution));
			if (index + 1 < hit.witness.length) assert.equal(edge.to!.id, hit.witness[index + 1]!.from.id);
			for (const location of [edge.site, edge.from.location, edge.to!.location]) {
				const bytes = await readFile(join(source, location.path));
				const text = bytes.toString("utf8");
				assert.equal(location.contentHash, createHash("sha256").update(bytes).digest("hex"));
				assert.equal(
					text.slice(location.snippet.span.start.offset, location.snippet.span.end.offset),
					location.snippet.text,
				);
				assert.equal(
					location.citation,
					`${location.path}:${location.span.start.line}:${location.span.start.column}`,
				);
			}
		}
	}
}

test("one shared scan predicts hand-labeled multi-package callers with exact witnesses", async (t) => {
	const f = await fixture(t, {
		"lib/core.ts": "\uFEFF// 🚀\r\nexport function first() {}\r\nexport const second = () => {};\r\n",
		"app/routes.tsx":
			'import { first, second } from "../lib/core.ts";\nexport function shared() { second(); first(); first(); }\nexport function entry() { shared(); }\nfunction secondOnly() { second(); }\n',
		"other/collision.ts": "function first() {} function unrelated() { first(); }",
	});
	const roots = [f.symbol("lib/core.ts", "first"), f.symbol("lib/core.ts", "second")];
	const read = SourceReader.prototype.read;
	const reads: string[] = [];
	t.mock.method(
		SourceReader.prototype,
		"read",
		async function (this: SourceReader, path: string, signal?: AbortSignal, limit?: number) {
			reads.push(path);
			return read.call(this, path, signal, limit);
		},
	);
	const page = await scanImpact({ source: f.source }, f.query(roots));
	assert.deepEqual(reads.sort(), Object.keys(f.files).sort(), "each parsed file is read once, not per root/frame");
	assert.deepEqual(
		page.results.map((hit) => [hit.frame.name, hit.distance]),
		[
			["shared", 1],
			["secondOnly", 1],
			["entry", 2],
		],
	);
	assert.deepEqual(
		page.counts.byRoot.map((root) => root.assignedWitnesses),
		[2, 1],
	);
	assert.equal(page.counts.exhaustive, false);
	assert.equal(page.partial, false);
	assert.equal(page.roots[0]!.location.span.start.line, 2);
	await assertWitnesses(page, f.source);
	const oldCallers = new Set<string>();
	for (const symbol of roots) {
		const old = await runExploration(
			{ source: f.source },
			{ tool: "code_call_paths", symbol, direction: "callers", depth: 6 },
		);
		for (const edge of old.results) oldCallers.add(edge.from.id);
		assert.equal(old.revision.id, page.revision.id, "both APIs consume identical shared graph observations");
	}
	assert.deepEqual(new Set(page.results.map((hit) => hit.frame.id)), oldCallers);
});

test("nearest-root and diamond ties are deterministic, root duplicates/cycles are not extra callers", async (t) => {
	const f = await fixture(t, {
		"a.ts": `
function a() { a(); cycle(); }
function b() {}
function left() { a(); }
function right() { a(); }
function diamond() { right(); left(); }
function tied() { b(); a(); }
function near() { left(); b(); }
function cycle() { a(); }
`,
	});
	const a = f.symbol("a.ts", "a"),
		b = f.symbol("a.ts", "b");
	const one = await f.run([b, a, b]);
	const two = await f.run([a, b]);
	assert.deepEqual(one.roots, two.roots);
	assert.deepEqual(one.results, two.results);
	const byName = new Map(one.results.map((hit) => [hit.frame.name, hit]));
	assert.equal(
		byName.get("tied")!.rootId,
		one.roots[0]!.id,
		"canonical root wins equal distances, not input/call order",
	);
	assert.equal(byName.get("near")!.rootId, one.roots[1]!.id, "shorter path beats canonical root");
	assert.equal(
		byName.get("diamond")!.witness[0]!.to!.name,
		"left",
		"callsite order back from root breaks same-root ties",
	);
	assert.equal(byName.get("cycle")!.witness[0]!.cycle, true);
	assert.ok(one.results.every((hit) => !one.roots.some((root) => root.id === hit.frame.id)));
	await assertWitnesses(one, f.source);
});

test("unknown, ambiguous and unsupported cases remain explicit, empty is never safe", async (t) => {
	const f = await fixture(t, {
		"a.ts": "function lonely() {} function dynamic(callback: any, value: any) { value.lonely(); callback(); }",
		"b.ts": 'import { lonely } from "./amb"; function ambiguous() { lonely(); }',
		"amb.ts": "export function lonely() {}",
		"amb.js": "export function lonely() {}",
		"native.rs": "fn lonely() {}",
		"broken.ts": "function broken(",
		"config.cjs": 'throw new Error("must never run")',
	});
	const page = await f.run([f.symbol("a.ts", "lonely")]);
	assert.deepEqual(page.results, []);
	assert.equal(page.coverage.unresolvedCalls, 3);
	assert.equal(page.coverage.ambiguousCalls, 1);
	assert.equal(page.coverage.unsupported, 1);
	assert.equal(page.failureCount, 1);
	assert.equal(page.capabilities.valueReferences, "unsupported");
	assert.equal(page.capabilities.typeRelationships, "unsupported");
	assert.equal(page.capabilities.otherLanguages, "unsupported");
	assert.equal(page.capabilities.completeImpact, "not-proven");
	assert.equal(page.counts.exhaustive, false);
	assert.ok(page.partial);
	assert.ok(page.coverage.limitations.some((value) => value.includes("not proof of no impact")));
	await assert.rejects(f.run([{ path: "native.rs", line: 1, column: 4 }]), /parsed callable/);
});

test("opaque revision receipts are query-independent but workspace/content/coverage bound", async (t) => {
	const f = await fixture(t, {
		"a.ts": "function leaf() {} function entry() { leaf(); }",
		"b.ts": "function spare() {}",
	});
	const leaf = f.symbol("a.ts", "leaf"),
		entry = f.symbol("a.ts", "entry");
	const first = await f.run([leaf]);
	const changedQuery = await f.run([entry], { depth: 1, limit: 1, expectedRevision: first.revision.id });
	assert.deepEqual(first.revision, changedQuery.revision);
	for (const direction of ["callers", "callees"] as const) {
		const old = await runExploration(
			{ source: f.source },
			{ tool: "code_call_paths", symbol: entry, direction, depth: 1 },
		);
		assert.deepEqual(first.revision, old.revision);
	}
	assert.equal(first.source.id, first.revision.sourceId);
	assert.doesNotMatch(JSON.stringify(first), new RegExp(f.source));
	assert.equal(first.revision.kind, "observed-content");
	assert.equal(first.revision.consistency, "per-file-read-not-atomic");
	const other = await mkdtemp(join(tmpdir(), "pilot-impact-other-"));
	t.after(() => rm(other, { recursive: true, force: true }));
	await cp(f.source, other, { recursive: true });
	await assert.rejects(
		runExploration({ source: other }, f.query([leaf], { expectedRevision: first.revision.id })),
		/Stale/,
	);
	await writeFile(join(f.source, "b.ts"), "function changedNonRoot() {}");
	await assert.rejects(f.run([leaf], { expectedRevision: first.revision.id }), /Stale/);
	const second = await f.run([leaf]);
	await writeFile(join(f.source, "unknown.go"), "package main");
	await assert.rejects(f.run([leaf], { expectedRevision: second.revision.id }), /Stale/);
	assert.equal((await f.run([leaf])).coverage.unsupported, 1);
});

test("pages bind complete root query, non-root edits and workspace; observed counts are not page counts", async (t) => {
	const f = await fixture(t, { "a.ts": "function leaf() {} function a() { leaf(); } function b() { leaf(); }" });
	const leaf = f.symbol("a.ts", "leaf");
	const first = await f.run([leaf], { limit: 1 });
	const cursor = first.page.nextCursor!;
	assert.ok(cursor);
	assert.equal(first.counts.callersObserved, 2);
	const next = await f.run([leaf], { limit: 1, cursor });
	assert.equal(next.page.offset, 1);
	assert.equal(next.counts.callersObserved, 2);
	const other = await mkdtemp(join(tmpdir(), "pilot-impact-page-source-"));
	t.after(() => rm(other, { recursive: true, force: true }));
	await cp(f.source, other, { recursive: true });
	await assert.rejects(runExploration({ source: other }, f.query([leaf], { cursor })), /Stale/);
	await assert.rejects(f.run([leaf, leaf], { limit: 1, cursor }), /Stale/);
	await assert.rejects(f.run([leaf], { depth: 1, cursor }), /Stale/);
	await assert.rejects(f.run([leaf], { cursor: "invalid" }), /Invalid/);
	await writeFile(join(f.source, "new.ts"), "function changed() {}");
	await assert.rejects(f.run([leaf], { cursor }), /Stale/);
});

test("pinned lower-layer impact never reads dirty top-of-stack or a different store", async (t) => {
	const f = await fixture(t, { "a.ts": "function leaf() {} function entry() { leaf(); }" });
	const git = async (...args: string[]) =>
		(await promisify(execFile)("/usr/bin/git", ["-C", f.source, ...args])).stdout.trim();
	await git("init");
	await git("add", "a.ts");
	await git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"fixture",
	);
	const commit = await git("rev-parse", "HEAD");
	const source = { source: f.source, gitDir: join(f.source, ".git"), commit };
	const query = f.query([f.symbol("a.ts", "leaf")]);
	const pinned = await runExploration(source, query);
	await writeFile(join(f.source, "a.ts"), "function leaf() {} function entry() { unknown(); }");
	const again = await runExploration(source, { ...query, expectedRevision: pinned.revision.id });
	assert.deepEqual(again.results, pinned.results);
	assert.equal(again.source.commit, commit);
	assert.equal(again.revision.kind, "pinned-content");
	assert.equal(again.freshness.includesUncommitted, false);
	assert.equal((await f.run(query.symbols)).results.length, 0);
	await assert.rejects(runExploration({ ...source, commit: "f".repeat(40) }, query), /Git|git|source|object|tree/i);
});

test("mixed live windows retain observed hashes without claiming atomic revision", async (t) => {
	const f = await fixture(t, {
		"a.ts": 'import { leaf } from "./b.ts"; function entry() { leaf(); }',
		"b.ts": "export function leaf() {}",
	});
	const read = SourceReader.prototype.read;
	t.mock.method(
		SourceReader.prototype,
		"read",
		async function (this: SourceReader, path: string, signal?: AbortSignal, limit?: number) {
			const bytes = await read.call(this, path, signal, limit);
			if (path === "a.ts") await writeFile(join(f.source, path), "function entry() { unknown(); }");
			return bytes;
		},
	);
	const page = await scanImpact({ source: f.source }, f.query([f.symbol("b.ts", "leaf")]));
	assert.equal(page.results[0]!.witness[0]!.resolution, "inferred");
	assert.equal(page.revision.consistency, "per-file-read-not-atomic");
	assert.equal(page.results[0]!.witness[0]!.site.snippet.text, f.files["a.ts"]);
});

test("graph, traversal/depth and JSON page budgets are explicit", async (t) => {
	const f = await fixture(t, {
		"a.ts": `function leaf() {} function caller() { ${"leaf();".repeat(1100)} } function entry() { caller(); }`,
	});
	const leaf = f.symbol("a.ts", "leaf");
	const limited = await f.run([leaf]);
	assert.equal(limited.counts.edgesExamined, 1000);
	assert.equal(limited.counts.callersObserved, 1);
	assert.equal(limited.traversal.resultLimited, true);
	assert.ok(limited.partial);
	assert.ok(Buffer.byteLength(JSON.stringify(limited)) < 48 * 1024);
	await writeFile(
		join(f.source, "a.ts"),
		"function leaf() {} function caller() { leaf(); } function entry() { caller(); }",
	);
	assert.equal((await f.run([leaf], { depth: 1 })).traversal.depthLimited, true);
	await writeFile(
		join(f.source, "z.ts"),
		Array.from({ length: 5000 }, (_, i) => `function generated${i}() {}`).join("\n"),
	);
	const graphLimited = await f.run([leaf]);
	assert.ok(graphLimited.partialReasons.some((reason) => reason.includes("graph-record-limit")));
});

test("source denials, queued/running cancellation and API bounds preserve shared limits", async (t) => {
	const f = await fixture(t, { "a.ts": "function leaf() {} function caller() { leaf(); }" });
	const leaf = f.symbol("a.ts", "leaf");
	await symlink(join(f.source, "a.ts"), join(f.source, "link.ts"));
	for (const path of ["../outside", "link.ts", ".git", "node_modules"])
		await assert.rejects(f.run([leaf], { path }), /Ask|excluded/);
	await assert.rejects(f.run([{ ...leaf, path: "../outside" }]), /traversal/);
	for (const options of [
		{ depth: 0 },
		{ depth: 7 },
		{ limit: 51 },
		{ expectedRevision: "wrong" },
		{ symbols: [] },
		{ symbols: Array(9).fill(leaf) },
	])
		await assert.rejects(f.run([leaf], options), /1\.\.|Invalid/);
	await assert.rejects(f.run([{ ...leaf, contentHash: "f".repeat(64) }]), /Stale.*contentHash/);
	const before = new AbortController();
	before.abort(new Error("pre-cancelled"));
	await assert.rejects(runExploration({ source: f.source }, f.query([leaf]), before.signal), /pre-cancelled/);
	const controllers = Array.from({ length: 4 }, () => new AbortController());
	const pending = Promise.allSettled(
		controllers.map((controller) => runExploration({ source: f.source }, f.query([leaf]), controller.signal)),
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	for (const controller of controllers) controller.abort(new Error("in-flight-cancelled"));
	assert.ok(
		(await pending).every((result) => result.status === "rejected" && /cancelled/.test(String(result.reason))),
	);
	assert.equal((await f.run([leaf])).results.length, 1);
});

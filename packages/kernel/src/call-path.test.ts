import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import type { CallPathPage, CallPathQuery } from "./call-path-contract.ts";
import { scanCallPaths } from "./call-path-scan.ts";
import { parseDeclarations, supportedSyntax } from "./exploration-parser.ts";
import { runExploration } from "./exploration-runner.ts";
import { positions } from "./exploration-scan.ts";
import { SourceReader } from "./source-reader.ts";

async function fixture(t: TestContext, files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "pilot-call-paths-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	}
	const query = (path: string, name: string, options: Partial<CallPathQuery> = {}): CallPathQuery => {
		const offset = supportedSyntax(path)
			? (parseDeclarations(files[path]!, path).find((d) => d.name === name.replace(/\(\)$/, ""))?.start ?? -1)
			: files[path]!.indexOf(name);
		assert.ok(offset >= 0, name);
		const { line, column } = positions(files[path]!).span(offset, offset).start;
		return { tool: "code_call_paths", symbol: { path, line, column }, direction: "callees", depth: 6, ...options };
	};
	const run = (path: string, name: string, options: Partial<CallPathQuery> = {}) =>
		runExploration({ source: root }, query(path, name, options));
	return { root, files, query, run };
}

const pairs = (page: CallPathPage) => page.results.map((edge) => [edge.from.name, edge.to?.name, edge.resolution]);

test("API validation: direct/nested paths return exact navigable frames without name linking", async (t) => {
	const f = await fixture(t, {
		"a.ts":
			"\uFEFF// 🚀\r\nexport function entry() { nested(); function nested() { leaf(); } }\r\nconst leaf = () => {};\r\n",
		"other.ts": "function leaf() {} function other() { leaf(); }",
	});
	const page = await f.run("a.ts", "entry");
	assert.equal(page.mode, "source-inferred-not-runtime");
	assert.deepEqual(pairs(page), [
		["entry", "nested", "resolved"],
		["nested", "leaf", "resolved"],
	]);
	assert.equal(page.root.location.span.start.line, 2);
	assert.equal(page.coverage.semantics, "lexical-direct-calls-and-relative-esm");
	assert.equal(page.partial, false);
	for (const edge of page.results) {
		for (const hit of [edge.site, edge.from.location, edge.to!.location]) {
			const text = await readFile(join(f.root, hit.path), "utf8");
			assert.equal(text.slice(hit.snippet.span.start.offset, hit.snippet.span.end.offset), hit.snippet.text);
			assert.equal(hit.citation, `${hit.path}:${hit.span.start.line}:${hit.span.start.column}`);
		}
		assert.equal(edge.to?.location.path, "a.ts");
	}
	const callers = await f.run("a.ts", "leaf", { direction: "callers" });
	assert.deepEqual(pairs(callers), [
		["nested", "leaf", "resolved"],
		["entry", "nested", "resolved"],
	]);
	const shallow = await f.run("a.ts", "entry", { depth: 1 });
	assert.equal(shallow.results.length, 1);
	assert.ok(shallow.traversal.depthLimited);
	assert.ok(shallow.partialReasons.includes("call-depth-limit"));
});

test("lexical scope, parameters, hoisting, destructuring, catch and mutable bindings do not alias names", async (t) => {
	const f = await fixture(t, {
		"scope.ts": `
function target() {}
function entry(target: () => void) { target(); }
function blocks() { { const target = 1; target(); } target(); }
function vars() { target(); { var target = 1; } }
function destructure({target}: any) { target(); }
function catches() { try {} catch (target) { target(); } }
function mutate() { target(); target = other; }
function other() {}
`,
	});
	for (const name of ["entry", "vars", "destructure", "catches"]) {
		const page = await f.run("scope.ts", name);
		assert.equal(page.results.length, 1);
		assert.equal(page.results[0]!.resolution, "unresolved", name);
		assert.equal(page.results[0]!.to, undefined);
	}
	// A write anywhere invalidates that binding, including outer-scope writes.
	const blocks = await f.run("scope.ts", "blocks");
	assert.ok(blocks.results.every((edge) => edge.resolution === "unresolved"));
	const mutable = await f.run("scope.ts", "mutate");
	assert.match(mutable.results[0]!.provenance, /reassigned/);
	await writeFile(join(f.root, "scope.ts"), f.files["scope.ts"]!.replace("target = other", "void other"));
	const unchanged = await f.run("scope.ts", "blocks");
	assert.deepEqual(
		unchanged.results.map((e) => e.resolution),
		["unresolved", "resolved"],
	);
});

test("relative ESM imports use explicit export bindings, never equal names in other files", async (t) => {
	const f = await fixture(t, {
		"a.ts": 'import { leaf as local } from "./b.ts"; export function entry() { local(); missing(); }',
		"b.ts": "function implementation() {} export { implementation as leaf };",
		"c.ts": "export function missing() {} export function local() {}",
	});
	const page = await f.run("a.ts", "entry");
	assert.deepEqual(pairs(page), [
		["entry", "implementation", "inferred"],
		["entry", undefined, "unresolved"],
	]);
	assert.equal(page.results[0]!.to!.location.path, "b.ts");
	assert.match(page.results[0]!.provenance, /per-file-window/);
	const callers = await f.run("b.ts", "implementation", { direction: "callers" });
	assert.deepEqual(pairs(callers), [["entry", "implementation", "inferred"]]);
	const narrow = await f.run("a.ts", "entry", { path: "a.ts" });
	assert.ok(narrow.results.every((edge) => edge.resolution === "unresolved"));
});

test("ambiguous imports and duplicate declarations never create traversable edges", async (t) => {
	const f = await fixture(t, {
		"a.ts": 'import { leaf } from "./b"; function entry() { leaf(); }',
		"b.ts": "export function leaf() {}",
		"b.js": "export function leaf() {}",
		"duplicate.js": "function dup() {} function dup() {} function ambiguous() { dup(); }",
	});
	const ambiguous = await f.run("a.ts", "entry");
	assert.equal(ambiguous.results[0]!.resolution, "ambiguous");
	assert.equal(ambiguous.results[0]!.to, undefined);
	assert.ok(ambiguous.partial);
	const dup = await f.run("duplicate.js", "ambiguous");
	assert.equal(dup.results[0]!.resolution, "ambiguous");
	await rm(join(f.root, "b.js"));
	assert.equal((await f.run("a.ts", "entry")).results[0]!.resolution, "inferred");
});

test("callbacks, methods, aliases, dispatch and unsupported module resolution remain explicit", async (t) => {
	const f = await fixture(t, {
		"dynamic.ts": `
import { ext } from "external";
function leaf() {}
function invoke(callback: () => void) { callback(); }
function entry() { invoke(() => leaf()); const alias = leaf; alias(); obj.leaf(); leaf?.(); new Thing(); tag\`x\`; ext(); }
`,
	});
	const page = await f.run("dynamic.ts", "entry");
	assert.ok(page.results.some((edge) => edge.to?.name === "invoke"));
	assert.ok(!page.results.some((edge) => edge.to?.name === "leaf"), "passing a callback is not invoking it");
	assert.equal(page.results.filter((edge) => edge.resolution === "unresolved").length, 7);
	assert.ok(page.coverage.unresolvedCalls >= 7);
	const leaf = await f.run("dynamic.ts", "leaf", { direction: "callers" });
	assert.equal(leaf.results[0]!.from.name, "<anonymous>");
	assert.equal(leaf.results.length, 1);
});

test("recursive SCCs terminate; diamond convergence is not a cycle", async (t) => {
	const f = await fixture(t, {
		"cycles.ts": `
function entry() { left(); right(); }
function left() { bottom(); }
function right() { bottom(); }
function bottom() {}
function a() { b(); }
function b() { a(); b(); }
`,
	});
	const diamond = await f.run("cycles.ts", "entry");
	assert.equal(diamond.results.length, 4);
	assert.ok(diamond.results.every((edge) => !edge.cycle));
	const cycle = await f.run("cycles.ts", "a()");
	assert.equal(cycle.results.length, 3);
	assert.ok(cycle.results.every((edge) => edge.cycle));
});

test("unsupported/failed syntax and no callers report incomplete coverage, not impact absence", async (t) => {
	const f = await fixture(t, {
		"a.ts": "function lonely() {} function opaque() { unknown(); }",
		"native.rs": "fn lonely() {}",
		"broken.ts": "function nope(",
		"config.cjs": 'throw new Error("MUST NOT EXECUTE")',
	});
	const page = await f.run("a.ts", "lonely", { direction: "callers" });
	assert.equal(page.results.length, 0);
	assert.equal(page.coverage.unsupported, 1);
	assert.equal(page.failureCount, 1);
	assert.ok(page.partial);
	assert.ok(page.coverage.limitations.some((line) => line.includes("not proof of no impact")));
	await assert.rejects(f.run("native.rs", "lonely"), /parsed callable/);
});

test("pages invalidate edits, queries and independent workspaces; hashes fence symbol selection", async (t) => {
	const f = await fixture(t, { "a.ts": "function entry() { leaf(); leaf(); } function leaf() {}" });
	const query = f.query("a.ts", "entry", { limit: 1 });
	const first = await runExploration({ source: f.root }, query);
	const cursor = first.page.nextCursor!;
	assert.ok(cursor);
	const second = await runExploration({ source: f.root }, { ...query, cursor });
	assert.equal(second.page.offset, 1);
	const other = await mkdtemp(join(tmpdir(), "pilot-other-source-"));
	t.after(() => rm(other, { recursive: true, force: true }));
	await cp(f.root, other, { recursive: true });
	await assert.rejects(runExploration({ source: other }, { ...query, cursor }), /Stale/);
	await assert.rejects(runExploration({ source: f.root }, { ...query, direction: "callers", cursor }), /Stale/);
	await assert.rejects(runExploration({ source: f.root }, { ...query, cursor: "invalid" }), /Invalid/);
	await writeFile(join(f.root, "a.ts"), f.files["a.ts"]!.replaceAll("leaf();", "void 0;"));
	await assert.rejects(runExploration({ source: f.root }, { ...query, cursor }), /Stale/);
	await assert.rejects(
		runExploration(
			{ source: f.root },
			{ ...query, symbol: { ...query.symbol, contentHash: first.root.location.contentHash } },
		),
		/Stale.*contentHash/,
	);
	assert.equal((await runExploration({ source: f.root }, query)).results.length, 0);
});

test("pinned lower-layer sources never read edited top-of-stack content", async (t) => {
	const f = await fixture(t, { "a.ts": "export function entry() { leaf(); } function leaf() {}" });
	const git = promisify(execFile);
	await git("/usr/bin/git", ["init", f.root]);
	await git("/usr/bin/git", ["-C", f.root, "add", "a.ts"]);
	await git("/usr/bin/git", [
		"-C",
		f.root,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"fixture",
	]);
	const commit = (await git("/usr/bin/git", ["-C", f.root, "rev-parse", "HEAD"])).stdout.trim();
	await writeFile(join(f.root, "a.ts"), "export function entry() { unknown(); } function leaf() {}");
	const page = await runExploration(
		{ source: f.root, gitDir: join(f.root, ".git"), commit },
		f.query("a.ts", "entry"),
	);
	assert.equal(page.source.commit, commit);
	assert.equal(page.freshness.includesUncommitted, false);
	assert.equal(page.results[0]!.to!.name, "leaf");
	assert.equal((await f.run("a.ts", "entry")).results[0]!.resolution, "unresolved");
});

test("trust denials, source I/O failure and cancellation preserve the shared read-only boundary", async (t) => {
	const f = await fixture(t, { "a.ts": "function entry() { leaf(); } function leaf() {}" });
	await symlink(join(f.root, "a.ts"), join(f.root, "link.ts"));
	for (const path of ["../outside", "link.ts", "node_modules", ".git"])
		await assert.rejects(f.run("a.ts", "entry", { path }), /Ask|excluded/);
	await assert.rejects(f.run("a.ts", "entry", { symbol: { path: "../outside", line: 1, column: 1 } }), /traversal/);
	const controller = new AbortController();
	controller.abort(new Error("pre-cancelled"));
	await assert.rejects(
		runExploration({ source: f.root }, f.query("a.ts", "entry"), controller.signal),
		/pre-cancelled/,
	);
	const controllers = Array.from({ length: 4 }, () => new AbortController());
	const calls = controllers.map((c) => runExploration({ source: f.root }, f.query("a.ts", "entry"), c.signal));
	const settled = Promise.allSettled(calls);
	await new Promise<void>((resolve) => setImmediate(resolve));
	for (const c of controllers) c.abort(new Error("in-flight-cancelled"));
	assert.ok(
		(await settled).every((result) => result.status === "rejected" && /cancelled/.test(String(result.reason))),
	);
	assert.equal((await f.run("a.ts", "entry")).results.length, 1);
	const read = SourceReader.prototype.read;
	t.mock.method(
		SourceReader.prototype,
		"read",
		async function (this: SourceReader, path: string, signal?: AbortSignal, maxBytes?: number) {
			if (path === "denied.ts") throw new Error("denied");
			return read.call(this, path, signal, maxBytes);
		},
	);
	await writeFile(join(f.root, "denied.ts"), "function denied() {}");
	const denied = await scanCallPaths({ source: f.root }, f.query("a.ts", "entry"));
	assert.equal(denied.failureCount, 1);
	assert.ok(denied.partial);
	for (const options of [{ depth: 0 }, { depth: 7 }, { limit: 51 }])
		await assert.rejects(f.run("a.ts", "entry", options), /1\.\./);
});

test("implicit arguments, parameter properties and typed writes shadow or invalidate outer names", async (t) => {
	const f = await fixture(t, {
		"arguments.js": "function arguments() {} function entry() { arguments(); }",
		"scope.ts": `
function target() {}
function entry() { target(); }
function change() { target! = other; }
function other() {}
class C { constructor(public target: any) { target(); } }
`,
	});
	assert.equal((await f.run("arguments.js", "entry")).results[0]!.resolution, "unresolved");
	const page = await f.run("scope.ts", "entry");
	assert.ok(page.results.every((edge) => !edge.to));
	const construction = await f.run("scope.ts", "constructor");
	assert.equal(construction.results[0]!.resolution, "unresolved");
});

test("defaults, closures and computed keys keep the correct lexical enclosing frames", async (t) => {
	const f = await fixture(t, {
		"scope.ts": `
export function target() {}
export function entry(callback = target()) {
  function target() {}
  const closure = function self() { self(); target(); };
  closure();
  const object = { [target()]() {} };
}
`,
	});
	const page = await f.run("scope.ts", "entry");
	const targetEdges = page.results.filter((edge) => edge.to?.name === "target");
	assert.equal(targetEdges.length, 3);
	assert.equal(
		targetEdges.filter((edge) => edge.to!.location.span.start.line === 2).length,
		1,
		"parameter default uses outer target, not body declaration",
	);
	assert.equal(
		targetEdges.filter((edge) => edge.from.name === "entry").length,
		2,
		"computed key is evaluated in enclosing context",
	);
	assert.ok(page.results.some((edge) => edge.from.name === "closure" && edge.to?.name === "closure" && edge.cycle));
});

test("function body var/function collisions do not bypass shadowing or default-parameter scopes", async (t) => {
	const f = await fixture(t, {
		"vars.ts": `
export function target() {}
export function entry(callback = target()) { function target() {} var target = other; target(); }
function other() {}
`,
	});
	const page = await f.run("vars.ts", "entry");
	assert.equal(page.results.length, 2);
	assert.equal(page.results[0]!.to!.location.span.start.line, 2);
	assert.equal(page.results[1]!.resolution, "ambiguous");
	assert.equal(page.results[1]!.to, undefined);
});

test("unsupported re-exports, namespaces, eval and sloppy block hoisting do not guess edges", async (t) => {
	const f = await fixture(t, {
		"a.ts": 'import { target } from "./b.ts"; function entry() { target(); }',
		"b.ts": 'export { target } from "./c.ts";',
		"c.ts": "export function target() {}",
		"eval.js": 'function target() {} function entry() { eval("unknown"); target(); }',
		"annex.js": "function target() {} { function target() {} } function entry() { target(); }",
		"namespace.ts": "function target() {} namespace Area { export function entry() { target(); } }",
	});
	for (const path of ["a.ts", "eval.js", "annex.js", "namespace.ts"]) {
		const page = await f.run(path, "entry");
		assert.ok(
			page.results.every((edge) => !edge.to && edge.resolution === "unresolved"),
			path,
		);
	}
});

test("frame IDs disambiguate anonymous navigation at module coordinates", async (t) => {
	const f = await fixture(t, { "a.ts": "()=>{ leaf(); }; function leaf() {}" });
	const page = await f.run("a.ts", "leaf", { direction: "callers" });
	const anonymous = page.results[0]!.from;
	const symbol = {
		path: "a.ts",
		line: 1,
		column: 1,
		contentHash: anonymous.location.contentHash,
		frameId: anonymous.id,
	};
	await assert.rejects(f.run("a.ts", "leaf", { symbol: { ...symbol, frameId: undefined } }), /ambiguous/);
	const navigated = await f.run("a.ts", "leaf", { symbol, direction: "callees" });
	assert.equal(navigated.root.id, anonymous.id);
	assert.equal(navigated.results[0]!.to!.name, "leaf");
});

test("mixed live read windows identify observed bytes and never claim an atomic cross-file edge", async (t) => {
	const f = await fixture(t, {
		"a.ts": 'import { leaf } from "./b.ts"; function entry() { leaf(); }',
		"b.ts": "export function leaf() {}",
	});
	const read = SourceReader.prototype.read;
	t.mock.method(
		SourceReader.prototype,
		"read",
		async function (this: SourceReader, path: string, signal?: AbortSignal, maxBytes?: number) {
			if (path === "b.ts") await writeFile(join(f.root, "a.ts"), f.files["a.ts"]!.replace("leaf();", "unknown();"));
			return read.call(this, path, signal, maxBytes);
		},
	);
	const page = await scanCallPaths({ source: f.root }, f.query("a.ts", "entry"));
	assert.equal(page.freshness.consistency, "per-file-read-not-atomic");
	assert.equal(page.results[0]!.resolution, "inferred");
	assert.match(page.results[0]!.provenance, /per-file-window/);
	assert.equal(page.results[0]!.site.snippet.text, f.files["a.ts"]);
	assert.notEqual(await readFile(join(f.root, "a.ts"), "utf8"), page.results[0]!.site.snippet.text);
});

test("bounded graph retention and 48 KiB pages are honest", async (t) => {
	const f = await fixture(t, {
		"a.ts": `function entry() { ${"leaf();".repeat(1100)} } function leaf() {}`,
		"z.ts": Array.from({ length: 21000 }, (_, i) => `const a${i} = 0;`).join("\n"),
	});
	const page = await f.run("a.ts", "entry", { limit: 50 });
	assert.ok(page.traversal.resultLimited);
	assert.ok(page.partialReasons.includes("call-graph-record-limit: narrow path"));
	assert.equal(page.page.retained, 1000);
	assert.ok(page.page.returned > 0 && page.page.returned <= 50);
	assert.ok(Buffer.byteLength(JSON.stringify(page)) < 48 * 1024);
	assert.ok(page.page.nextCursor);
});

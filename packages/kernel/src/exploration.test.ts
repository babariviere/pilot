import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import type { ExplorationPage, ExplorationQuery } from "./exploration-contract.ts";
import { parseDeclarations } from "./exploration-parser.ts";
import { runExploration } from "./exploration-runner.ts";
import { scanSource } from "./exploration-scan.ts";
import { SourceReader } from "./source-reader.ts";

const git = promisify(execFile);
async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-exploration-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "workspace-a");
	const files: Record<string, string | Buffer> = {
		"packages/server/src/service.ts":
			'export interface Request { id: string }\nexport class Service {\n  #token = "local";\n  fetch(request: Request) { return request.id; }\n}\nexport function fetchData() { return new Service(); }\nexport const [first, { value: renamed }] = [1, {value: 2}];\n',
		"packages/client/src/view.tsx":
			'import { Service } from "../../server/src/service.ts";\nexport const View = () => <button>{new Service().fetch({id: "x"})}</button>;\n',
		"packages/client/src/use.ts":
			'import { Service } from "../../server/src/service.ts";\nexport const makeService = () => new Service();\n',
		"docs/readme.md": "Service handles requests.\nService is local.\n",
		"native/main.rs": "fn Service() {}\n",
		"node_modules/ignored.ts": "export const Service = 1;",
		"dist/ignored.ts": "export const Service = 2;",
		"babel.config.cjs": 'throw new Error("must not execute project config");',
		"tsconfig.json":
			'{"extends":"https://invalid.test/no-network","compilerOptions":{"plugins":[{"name":"untrusted"}]}}',
	};
	for (const [path, value] of Object.entries(files)) {
		await mkdir(dirname(join(source, path)), { recursive: true });
		await writeFile(join(source, path), value);
	}
	await writeFile(join(root, "secret.ts"), "export const Secret = 1");
	await symlink("../secret.ts", join(source, "escape.ts"));
	await symlink(root, join(source, "escape-dir"));
	const query = (input: ExplorationQuery, signal?: AbortSignal) => runExploration({ source }, input, signal);
	return { root, source, files, query };
}

async function citations(source: string, page: ExplorationPage) {
	for (const hit of page.results) {
		const bytes = await readFile(join(source, hit.path));
		const text = bytes.toString("utf8");
		assert.equal(hit.contentHash, createHash("sha256").update(bytes).digest("hex"));
		assert.equal(text.slice(hit.snippet.span.start.offset, hit.snippet.span.end.offset), hit.snippet.text);
		const prefix = text.slice(0, hit.span.start.offset).split("\n");
		assert.equal(hit.span.start.line, prefix.length);
		assert.equal(hit.span.start.column, prefix.at(-1)!.length + 1);
		assert.equal(hit.citation, `${hit.path}:${prefix.length}:${prefix.at(-1)!.length + 1}`);
	}
}

test("source-aware literal ranking and named declarations have stable precise citations", async (t) => {
	const f = await fixture(t);
	const page = await f.query({ tool: "code_search", query: "Service", limit: 50 });
	assert.equal(page.results[0]!.name, "Service");
	assert.equal(page.results[0]!.score, 100);
	assert.equal(page.coverage.parsed, 4); // three source files and the config file as inert syntax
	assert.ok(page.coverage.lexical >= 3);
	assert.equal(page.partial, false);
	assert.equal(page.exclusions.node_modules, 1);
	assert.equal(page.exclusions.dist, 1);
	assert.equal(page.exclusions.symlink, 2);
	assert.ok(page.results.some((hit) => hit.path === "native/main.rs" && hit.coverage === "lexical"));
	await citations(f.source, page);
	const again = await f.query({ tool: "code_search", query: "Service", limit: 50 });
	assert.deepEqual(page.results, again.results);
	assert.equal(page.freshness.fingerprint, again.freshness.fingerprint);
	const symbols = await f.query({ tool: "code_symbols", query: "Service", exact: true });
	assert.equal(symbols.results.length, 1, "imports/references are not definition candidates");
	assert.equal(symbols.results[0]!.kind, "ClassDeclaration");
	assert.equal(symbols.coverage.unsupported, 3);
	assert.equal(symbols.partial, true);
	const members = await f.query({ tool: "code_symbols", query: "fetch", path: "packages/server" });
	assert.deepEqual(
		members.results.map((hit) => hit.name),
		["fetch", "fetchData"],
	);
	assert.equal(members.results[0]!.container, "Service");
	const bindings = await f.query({ tool: "code_symbols", path: "packages/server" });
	for (const name of ["first", "renamed", "Request", "#token"])
		assert.ok(
			bindings.results.some((hit) => hit.name === name),
			name,
		);
	await citations(f.source, bindings);
});

test("actual parser excludes comments/strings and preserves BOM, CRLF and UTF-16 source offsets", async (t) => {
	const f = await fixture(t);
	const text =
		'\uFEFF// class Fake {}\r\nconst literal = "function Fake() {}";\r\n/* 🚀 */ export function Real() {}\r\nexport const Box = () => <div />;\r\n';
	await writeFile(join(f.source, "unicode.tsx"), text);
	const page = await f.query({ tool: "code_symbols", path: "unicode.tsx" });
	assert.deepEqual(
		page.results.map((hit) => hit.name),
		["literal", "Real", "Box"],
	);
	await citations(f.source, page);
	for (const hit of page.results) assert.equal(text.slice(hit.span.start.offset, hit.span.end.offset), hit.name);
	const ast = parseDeclarations(
		"export enum Choice { Yes, No }\nexport type ID = string;\nexport namespace Area { export const x = 1; }",
		"test.ts",
	);
	assert.deepEqual(new Set(ast.map((item) => item.name)), new Set(["Choice", "Yes", "No", "ID", "Area", "x"]));
});

test("pages rescan dirty edits, additions, deletions and never accept another workspace cursor", async (t) => {
	const f = await fixture(t);
	const input = { tool: "code_search", query: "Service", limit: 1 } as const;
	const first = await f.query(input);
	const cursor = first.page.nextCursor;
	assert.ok(cursor);
	const second = await f.query({ ...input, cursor });
	assert.equal(second.page.offset, 1);
	assert.notDeepEqual(first.results, second.results);
	await assert.rejects(f.query({ ...input, query: "other", cursor }), /Stale/);
	await assert.rejects(f.query({ ...input, cursor: "not-json" }), /Invalid/);
	const other = join(f.root, "workspace-b");
	await cp(f.source, other, { recursive: true, verbatimSymlinks: true });
	await assert.rejects(runExploration({ source: other }, { ...input, cursor }), /Stale/);
	await writeFile(join(f.source, "packages/server/src/service.ts"), "\n\nexport class Service {}\n");
	await assert.rejects(f.query({ ...input, cursor }), /Stale/);
	const edited = await f.query(input);
	assert.equal(edited.results[0]!.span.start.line, 3);
	assert.notEqual(first.results[0]!.contentHash, edited.results[0]!.contentHash);
	await writeFile(join(f.source, "new.ts"), "export class Service {}\n");
	await assert.rejects(f.query({ ...input, cursor: edited.page.nextCursor }), /Stale/);
	const added = await f.query(input);
	await rm(join(f.source, "new.ts"));
	await assert.rejects(f.query({ ...input, cursor: added.page.nextCursor }), /Stale/);
	assert.equal(edited.source.kind, "workspace");
	assert.equal(edited.freshness.includesUncommitted, true);
});

test("host-pinned Ask snapshot stays pinned while live source changes", async (t) => {
	const f = await fixture(t);
	await git("/usr/bin/git", ["init", f.source]);
	await git("/usr/bin/git", ["-C", f.source, "add", "packages"]);
	await git("/usr/bin/git", [
		"-C",
		f.source,
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
	const commit = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD"])).stdout.trim();
	const source = { source: f.source, gitDir: join(f.source, ".git"), commit };
	await writeFile(join(f.source, "packages/server/src/service.ts"), "export const Changed = 1");
	const page = await runExploration(source, { tool: "code_symbols", query: "Service", exact: true });
	assert.equal(page.source.commit, commit);
	assert.equal(page.freshness.includesUncommitted, false);
	assert.equal(page.results[0]!.span.start.line, 2);
	assert.equal((await f.query({ tool: "code_symbols", query: "Changed" })).results.length, 1);
	await assert.rejects(runExploration({ ...source, commit: "HEAD" }, { tool: "code_symbols" }), /full commit/);
});

test("unsupported syntax, parser failures, binary/oversized files and read failures are explicit", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.source, "broken.ts"), "export function Service( { broken source");
	await writeFile(join(f.source, "binary.ts"), Buffer.from([0, 1]));
	await writeFile(join(f.source, "invalid.txt"), Buffer.from([0xff]));
	const huge = await open(join(f.source, "huge.ts"), "w");
	await huge.truncate(513 * 1024);
	await huge.close();
	const page = await f.query({ tool: "code_search", query: "Service" });
	assert.equal(page.partial, true);
	assert.equal(page.failureCount, 1);
	assert.equal(page.failures[0]!.path, "broken.ts");
	assert.ok(page.results.some((hit) => hit.path === "broken.ts" && hit.coverage === "lexical"));
	assert.equal(page.exclusions.binary, 1);
	assert.equal(page.exclusions["non-UTF8"], 1);
	assert.equal(page.exclusions.oversized, 1);
	const read = SourceReader.prototype.read;
	t.mock.method(
		SourceReader.prototype,
		"read",
		async function (
			this: SourceReader,
			path: string,
			...rest: Parameters<SourceReader["read"]> extends [string, ...infer R] ? R : never
		) {
			if (path.endsWith("service.ts")) throw new Error("synthetic denial");
			return read.call(this, path, ...rest);
		},
	);
	const failed = await scanSource({ source: f.source }, { tool: "code_symbols" });
	assert.ok(failed.failures.some((failure) => failure.reason === "unreadable-or-changed-during-read"));
	assert.equal(failed.partial, true);
});

test("output/result/entry limits are honest and source files are not mutated", async (t) => {
	const f = await fixture(t);
	await writeFile(
		join(f.source, "many.ts"),
		Array.from({ length: 1100 }, (_, i) => `export const item${i} = ${i};`).join("\n"),
	);
	const before = await readdir(f.source, { recursive: true });
	const page = await f.query({ tool: "code_symbols", path: "many.ts", limit: 50 });
	assert.equal(page.page.matchesObserved, 1100);
	assert.equal(page.page.retained, 1000);
	assert.ok(page.page.returned <= 50 && page.page.returned > 0);
	assert.ok(Buffer.byteLength(JSON.stringify(page)) < 48 * 1024);
	assert.ok(page.partialReasons.some((reason) => reason.startsWith("top-1000")));
	assert.deepEqual(await readdir(f.source, { recursive: true }), before);
	t.mock.method(SourceReader.prototype, "list", async () =>
		Array.from({ length: 10_001 }, (_, i) => ({ name: `${i}.txt`, kind: "symlink" as const })),
	);
	const limited = await scanSource({ source: f.source }, { tool: "code_search", query: "none" });
	assert.ok(limited.partialReasons.some((reason) => reason.startsWith("entry-limit")));
});

test("rooted path denials and cancellation cover queued and running disposable workers", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	for (const path of [
		"../secret.ts",
		"escape.ts",
		"escape-dir/secret.ts",
		"packages/../docs",
		join(f.root, "secret.ts"),
		".git",
		"node_modules/ignored.ts",
	])
		await assert.rejects(f.query({ tool: "code_symbols", path }), /Ask|excluded/);
	const cancelled = new AbortController();
	cancelled.abort(new Error("pre-cancelled"));
	await assert.rejects(f.query({ tool: "code_symbols" }, cancelled.signal), /pre-cancelled/);
	await writeFile(join(f.source, "large.ts"), "export const a = 1;\n".repeat(20_000));
	const controllers = Array.from({ length: 4 }, () => new AbortController());
	const calls = controllers.map((controller) => f.query({ tool: "code_symbols" }, controller.signal));
	const settled = Promise.allSettled(calls);
	await new Promise<void>((resolve) => setImmediate(resolve));
	for (const controller of controllers) controller.abort(new Error("in-flight cancelled"));
	assert.ok(
		(await settled).every((result) => result.status === "rejected" && /cancelled/.test(String(result.reason))),
	);
	assert.equal(
		(await f.query({ tool: "code_symbols", path: "packages/client" })).partial,
		false,
		"slots are released after joining cancellation",
	);
	await assert.rejects(f.query({ tool: "code_search", query: "a\nb" }), /one line/);
	await assert.rejects(f.query({ tool: "code_symbols", limit: 1000 }), /1..50/);
});

test("cumulative byte limits and cancellation during source I/O never look exhaustive", async (t) => {
	const f = await fixture(t);
	t.mock.method(SourceReader.prototype, "list", async () =>
		Array.from({ length: 66 }, (_, i) => ({ name: `${i}.txt`, kind: "file" as const })),
	);
	const buffer = Buffer.alloc(512 * 1024, "x");
	t.mock.method(SourceReader.prototype, "read", async () => buffer);
	const limited = await scanSource({ source: f.source }, { tool: "code_search", query: "not-present" });
	assert.equal(limited.scan.bytes, 32 * 1024 * 1024);
	assert.equal(limited.results.length, 0);
	assert.ok(limited.partialReasons.some((reason) => reason.startsWith("scan-byte-limit")));
	const controller = new AbortController();
	t.mock.method(SourceReader.prototype, "read", async () => {
		controller.abort(new Error("source-read-cancelled"));
		controller.signal.throwIfAborted();
		return buffer;
	});
	await assert.rejects(
		scanSource({ source: f.source }, { tool: "code_search", query: "x" }, controller.signal),
		/source-read-cancelled/,
	);
});

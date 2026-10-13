import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectChangeSummary, collectChanges, RepositoryChanges } from "./changes.ts";
import { type ProcessOptions, subprocesses } from "./subprocess.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});

test("many untracked files use a constant command count and share metadata across endpoints", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-untracked-fanout-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "--quiet", "-b", "main");
	git(root, "commit", "--quiet", "--allow-empty", "-m", "base");
	for (let i = 0; i < 100; i++) writeFileSync(join(root, `${i}.txt`), "one\ntwo\n");
	const run = subprocesses.run.bind(subprocesses);
	const commands: string[][] = [];
	t.mock.method(subprocesses, "run", (file: string, args: string[], options: ProcessOptions) => {
		commands.push(args);
		return run(file, args, options);
	});
	const cache = new RepositoryChanges();
	const summary = await cache.summary(root);
	assert.equal(summary.fileCount, 100);
	assert.equal(summary.additions, 200);
	assert.equal(commands.length, 8, "fixed repository + attribute/config reads, regardless of file count");
	const full = await cache.changes(root);
	assert.equal(full.files.length, 100);
	assert.equal(commands.filter((args) => args.includes("--numstat")).length, 1, "full diff reuses sidebar metadata");
	assert.equal(commands.filter((args) => args.includes("--name-status")).length, 1);
});

test("bounds huge untracked patches during collection while retaining accurate stats for every file", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-huge-"));
	const traceRoot = mkdtempSync(join(tmpdir(), "pilot-changes-trace-"));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(traceRoot, { recursive: true, force: true });
	});
	git(root, "init", "--quiet", "-b", "main");
	git(root, "commit", "--quiet", "--allow-empty", "-m", "base");
	// Beyond the old execFile maxBuffer. Counting patches used to silently report zero additions here.
	writeFileSync(join(root, "a-huge.txt"), `${"a".repeat(34 * 1024 * 1024)}\nlast\n`);
	writeFileSync(join(root, "z-later.txt"), "one\ntwo\nthree\n");
	const tracePath = join(traceRoot, "git.jsonl");
	const previousTrace = process.env.GIT_TRACE2_EVENT;
	process.env.GIT_TRACE2_EVENT = tracePath;
	let changes: Awaited<ReturnType<typeof collectChanges>>;
	try {
		changes = await collectChanges(root);
	} finally {
		if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
		else process.env.GIT_TRACE2_EVENT = previousTrace;
	}
	assert.equal(changes.truncated, true);
	assert.ok(Buffer.byteLength(changes.diff) <= 1024 * 1024);
	assert.deepEqual(
		changes.files.map((file) => [file.path, file.additions, file.deletions]),
		[
			["a-huge.txt", 2, 0],
			["z-later.txt", 3, 0],
		],
	);
	const patchCommands = readFileSync(tracePath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { event: string; argv?: string[] })
		.filter((event) => event.event === "start" && event.argv?.includes("--src-prefix=a/"));
	assert.equal(patchCommands.length, 2, "only tracked and the first untracked patch are generated");
	assert.deepEqual(await collectChangeSummary(root), {
		base: changes.base,
		branch: "main",
		fileCount: 2,
		additions: 5,
		deletions: 0,
	});
});

test("bounds tracked UTF-8 patches and keeps metadata for omitted untracked patches", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-huge-tracked-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "--quiet", "-b", "main");
	writeFileSync(join(root, "a.txt"), "old\n");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "base");
	writeFileSync(join(root, "a.txt"), `${"é".repeat(1024 * 1024)}\n`);
	writeFileSync(join(root, "new\n\tfile.txt"), "new\n");
	const changes = await collectChanges(root);
	assert.equal(changes.truncated, true);
	assert.ok(Buffer.byteLength(changes.diff) <= 1024 * 1024);
	assert.ok(!changes.diff.includes("\uFFFD"), "truncation must not split UTF-8 code points");
	assert.deepEqual(
		changes.files.map((file) => [file.path, file.additions, file.deletions]),
		[
			["a.txt", 1, 1],
			["new\n\tfile.txt", 1, 0],
		],
	);
});

test("invalid UTF-8 in text patches cannot expand beyond the diff byte budget", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-invalid-utf8-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "--quiet", "-b", "main");
	git(root, "commit", "--quiet", "--allow-empty", "-m", "base");
	writeFileSync(join(root, "invalid.txt"), Buffer.alloc(1024 * 1024, 0xff));
	const changes = await collectChanges(root);
	assert.equal(changes.truncated, true);
	assert.ok(Buffer.byteLength(changes.diff) <= 1024 * 1024);
	assert.equal(changes.files[0]?.additions, 1);
});

test("truncation preserves complete early hunks and omits an incomplete trailing hunk", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-hunks-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "--quiet", "-b", "main");
	const context = Array.from({ length: 100 }, (_, i) => `context ${i}\n`).join("");
	writeFileSync(join(root, "a.txt"), `first\n${context}last\n`);
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "base");
	writeFileSync(join(root, "a.txt"), `first edit\n${context}${"x".repeat(2 * 1024 * 1024)}\n`);
	const changes = await collectChanges(root);
	assert.equal(changes.truncated, true);
	assert.match(changes.diff, /\+first edit\n/);
	assert.equal(changes.diff.match(/^@@ /gm)?.length, 1);
	assert.ok(changes.diff.endsWith("\n"));
	assert.equal(changes.files[0]?.additions, 2);
	assert.equal(changes.files[0]?.deletions, 2);
});

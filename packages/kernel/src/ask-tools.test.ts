import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createAskTools } from "./ask-tools.ts";
import type { AskContext } from "./policy.ts";

const git = promisify(execFile);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-ask-tools-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source");
	await mkdir(join(source, "src"), { recursive: true });
	await writeFile(join(source, "src", "a.ts"), "first\nneedle in source\nlast");
	await writeFile(join(source, "image.png"), Buffer.from(png, "base64"));
	await writeFile(join(root, "secret"), "outside source");
	await symlink("../secret", join(source, "escape"));
	await symlink("src/a.ts", join(source, "internal-link"));
	await symlink(root, join(source, "escape-dir"));
	return { root, source };
}

async function calls(ask: AskContext) {
	const tools = await createAskTools(ask);
	for (const tool of tools) {
		assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
		assert.equal(tool.annotations?.destructiveHint, false, tool.name);
	}
	return async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
		const tool = tools.find((tool) => tool.name === name);
		assert.ok(tool, name);
		return tool.execute("test", args, signal, undefined, { cwd: ask.source } as ExtensionToolContext);
	};
}
function text(result: Awaited<ReturnType<Awaited<ReturnType<typeof calls>>>>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

for (const snapshot of [false, true]) {
	test(`Ask ${snapshot ? "pinned tree" : "checkout"} reads/searches/lists with rooted symlink safety`, async (t) => {
		const f = await fixture(t);
		let ask: AskContext = { source: f.source };
		if (snapshot) {
			await git("git", ["init", f.source]);
			await git("git", ["-C", f.source, "add", "."]);
			await git("git", [
				"-C",
				f.source,
				"-c",
				"user.name=Ask Test",
				"-c",
				"user.email=ask@example.invalid",
				"commit",
				"-m",
				"snapshot",
			]);
			const commit = (await git("git", ["-C", f.source, "rev-parse", "HEAD"])).stdout.trim();
			const gitDir = join(f.root, "objects.git");
			await git("git", ["clone", "--bare", f.source, gitDir]);
			ask = { ...ask, gitDir, commit, branch: "main" };
			await writeFile(join(f.source, "src", "a.ts"), "checkout changed, not pinned");
			await writeFile(join(f.source, "untracked"), "not in snapshot");
		}
		const call = await calls(ask);
		assert.equal(
			text(await call("read", { path: "src/a.ts", offset: 2, limit: 1 })).split("\n")[0],
			"needle in source",
		);
		assert.match(text(await call("grep", { pattern: "needle" })), /src\/a.ts:2:needle in source/);
		assert.match(
			text(await call("grep", { path: "src/a.ts", pattern: "FIRST", ignoreCase: true })),
			/src\/a.ts:1:first/,
		);
		assert.match(text(await call("find", { pattern: "*.ts" })), /src\/a.ts/);
		assert.match(text(await call("ls", {})), /src\//);
		assert.match(text(await call("ls", {})), /escape \[symlink\]/);
		assert.match(text(await call("read", { path: join(f.source, "src", "a.ts") })), /needle/);
		for (const path of [
			"../secret",
			"src/../../secret",
			join(f.root, "secret"),
			"src/../src/a.ts",
			"escape",
			"internal-link",
			"escape-dir/secret",
		])
			await assert.rejects(call("read", { path }), /Ask/);
		for (const name of ["ls", "grep", "find"])
			await assert.rejects(call(name, { path: "escape-dir", pattern: "*" }), /Ask/);
		const image = await call("read", { path: "image.png" });
		assert.ok(
			image.content.some((block) => block.type === "image"),
			JSON.stringify(image),
		);
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		for (const name of ["read", "ls", "grep", "find"])
			await assert.rejects(
				call(name, { path: name === "read" ? "src/a.ts" : ".", pattern: "*" }, controller.signal),
				/cancelled/,
			);
		if (snapshot) await assert.rejects(call("read", { path: "untracked" }), /not found in pinned tree/);
	});
}

test("Ask output and scanning are bounded, and oversized files do not stop grep", async (t) => {
	const f = await fixture(t);
	const huge = await open(join(f.source, "huge.txt"), "w");
	await huge.truncate(17 * 1024 * 1024);
	await huge.close();
	await writeFile(join(f.source, "long.txt"), "needle".repeat(20_000));
	const call = await calls({ source: f.source });
	const output = text(await call("read", { path: "long.txt" }));
	assert.ok(Buffer.byteLength(output) < 52 * 1024);
	assert.match(output, /Output truncated/);
	assert.match(text(await call("grep", { pattern: "needle" })), /src\/a.ts:2/);
	await assert.rejects(call("read", { path: "huge.txt" }), /16 MiB/);
	// This wildcard chain would cause exponential regex backtracking in a naive glob implementation.
	assert.equal(text(await call("find", { pattern: `${"*a".repeat(200)}z` })), "");
});

test("Ask rejects incomplete or model-controlled snapshot revisions", async () => {
	await assert.rejects(createAskTools({ source: "/tmp", gitDir: "/tmp/git" }), /both gitDir and commit/);
	await assert.rejects(createAskTools({ source: "/tmp", commit: "HEAD:../../secret" }), /both gitDir and commit/);
	await assert.rejects(createAskTools({ source: "/tmp", gitDir: "/tmp/git", commit: "HEAD" }), /full commit ID/);
});

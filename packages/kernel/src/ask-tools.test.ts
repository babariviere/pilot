import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { ARTIFACT_SKILL_PATH, ARTIFACT_SKILL_REFERENCES } from "./artifact-skill.ts";
import { ASK_ATTACHMENTS, createAskTools } from "./ask-tools.ts";
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

async function calls(ask: AskContext, artifactSkill = false) {
	const tools = await createAskTools(ask, { artifactSkill });
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

test("feedback named roots allow exact files and directory subtrees, never siblings, aliases or traversal", async (t) => {
	const f = await fixture(t);
	const folder = join(f.root, "selected");
	await mkdir(join(folder, "sub"), { recursive: true });
	await writeFile(join(folder, "sub", "note.txt"), "needle in selected folder");
	await writeFile(join(folder, "secret.txt"), "API_KEY=example-secret-value\nSafe line");
	await writeFile(join(folder, "gif-prefix.txt"), "GIF89a\nAPI_KEY=gif-prefix-secret\nneedle");
	await symlink(join(f.root, "secret"), join(folder, "escape"));
	const selected = await lstat(folder),
		file = await lstat(join(f.root, "secret"));
	const call = await calls({
		source: f.source,
		feedbackSources: [
			{ path: folder, kind: "directory", dev: selected.dev, ino: selected.ino },
			{ path: join(f.root, "secret"), kind: "file", dev: file.dev, ino: file.ino },
		],
	});
	assert.match(text(await call("read", { path: join(folder, "sub", "note.txt") })), /needle in selected/);
	assert.match(text(await call("grep", { path: folder, pattern: "needle" })), /note.txt/);
	assert.match(text(await call("find", { path: folder, pattern: "*.txt" })), /note.txt/);
	assert.match(text(await call("ls", { path: folder })), /sub\//);
	assert.doesNotMatch(text(await call("read", { path: join(folder, "secret.txt") })), /example-secret-value/);
	assert.match(text(await call("read", { path: join(folder, "secret.txt") })), /Safe line/);
	assert.doesNotMatch(
		text(await call("grep", { path: folder, pattern: "API_KEY" })),
		/gif-prefix-secret|example-secret-value/,
	);
	assert.match(text(await call("read", { path: join(f.root, "secret") })), /outside source/);
	await assert.rejects(call("ls", { path: f.root }), /inside the source/);
	await assert.rejects(call("read", { path: join(folder, "escape") }), /symlink/);
	await assert.rejects(call("read", { path: `${folder}/sub/../sub/note.txt` }), /traversal/);
	await assert.rejects(call("read", { path: `${folder}-sibling/note.txt` }), /inside the source/);
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(call("read", { path: join(folder, "sub", "note.txt") }, aborted.signal), /abort/i);
	await rename(folder, `${folder}-old`);
	await symlink(`${folder}-old`, folder);
	await assert.rejects(call("read", { path: join(folder, "sub", "note.txt") }), /selected feedback path changed/);
});

test("feedback credential exclusions apply to external and primary roots, including canonical aliases", async (t) => {
	const f = await fixture(t);
	const agent = join(f.root, "configured-agent");
	await mkdir(agent);
	await writeFile(join(agent, "auth.json"), '{"apiKey":"fake-secret"}');
	await writeFile(join(agent, "settings.json"), '{"safe":true}');
	const stat = await lstat(agent);
	const grant = { path: agent, kind: "directory" as const, dev: stat.dev, ino: stat.ino };
	for (const source of [f.source, agent]) {
		const call = await calls({ source, feedbackSources: [grant], feedbackDeniedPaths: [join(agent, "auth.json")] });
		await assert.rejects(call("read", { path: join(agent, "auth.json") }), /protected credential/);
		assert.match(text(await call("read", { path: join(agent, "settings.json") })), /safe/);
		await symlink(join(agent, "auth.json"), join(agent, "alias")).catch(() => {});
		await assert.rejects(call("read", { path: join(agent, "alias") }), /protected credential/);
	}
	const feedback = await calls({ source: f.source, feedbackDeniedPaths: [] });
	await link(join(agent, "auth.json"), join(f.source, "credential-alias"));
	await assert.rejects(feedback("read", { path: "credential-alias" }), /hardlink/);
	await assert.rejects(
		feedback("read", { path: join(ASK_ATTACHMENTS, "00000000-0000-4000-8000-000000000001.png") }),
		/inside the source/,
	);
});

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
		await assert.rejects(call("read", { path: ARTIFACT_SKILL_PATH }), /Ask paths must stay inside the source/);
		const hostRead = await calls(ask, true);
		const skill = text(await hostRead("read", { path: ARTIFACT_SKILL_PATH }));
		assert.match(skill, /name: pilot-artifacts/);
		assert.match(skill, /Ask image sources must be inline base64/);
		assert.equal(
			text(await hostRead("read", { path: ARTIFACT_SKILL_PATH, limit: 1 })),
			"---\n[More lines available; use offset=2.]",
		);
		for (const reference of ARTIFACT_SKILL_REFERENCES)
			assert.equal(text(await hostRead("read", { path: reference })), await readFile(reference, "utf8"));
		for (const path of [
			dirname(ARTIFACT_SKILL_PATH),
			join(dirname(ARTIFACT_SKILL_PATH), "other.md"),
			join(dirname(ARTIFACT_SKILL_PATH), "references"),
			join(dirname(ARTIFACT_SKILL_PATH), "references", "other.md"),
			`${dirname(ARTIFACT_SKILL_PATH)}/../pilot-artifacts/SKILL.md`,
			`${ARTIFACT_SKILL_PATH}/other`,
		])
			await assert.rejects(hostRead("read", { path }), /Ask/);
		await assert.rejects(hostRead("read", { path: ARTIFACT_SKILL_PATH }, controller.signal), /cancelled/);
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

test("feedback image reads use only the exact native-admitted paths, never their siblings or symlinks", async (t) => {
	const f = await fixture(t);
	const image = join(f.root, "feedback.png");
	const sibling = join(f.root, "other.png");
	await writeFile(image, Buffer.from(png, "base64"));
	await writeFile(sibling, Buffer.from(png, "base64"));
	const call = await calls({ source: f.source, feedbackImages: [image] });
	assert.ok((await call("read", { path: image })).content.some((b) => b.type === "image"));
	await assert.rejects(call("read", { path: sibling }), /inside the source/);
	await assert.rejects((await calls({ source: f.source }))("read", { path: image }), /inside the source/);
	await rm(image);
	await symlink(sibling, image);
	await assert.rejects(call("read", { path: image }));
});

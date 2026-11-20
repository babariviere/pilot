import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ArtifactStore } from "./store.ts";
import { nshSource } from "../nsh/nsh-source.ts";
import { STORED_REVISION_LIMITS } from "./stored-revision.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "stored-artifact-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const id = "11111111-1111-1111-1111-111111111111";
	const directory = join(root, "artifacts", id);
	await mkdir(directory, { recursive: true });
	const source = "export default () => null;";
	const summary = {
		id,
		revision: 1,
		sessionId: "owner",
		projectId: "project",
		kind: "nsh",
		title: "Exact",
		createdAt: 1,
		updatedAt: 2,
	};
	const value = { ...summary, source, html: "", nsh: nshSource(source, "view.tsx") };
	const pointer = async (patch = {}) => {
		await writeFile(join(directory, "latest.json"), JSON.stringify({ ...summary, ...patch }));
	};
	await pointer();
	const bytes = Buffer.from(`\uFEFF${JSON.stringify(value, null, 2).replaceAll("\n", "\r\n")}\r\n`);
	await writeFile(join(directory, "1.json"), bytes);
	return {
		root,
		id,
		directory,
		value,
		bytes,
		pointer,
		store: new ArtifactStore(root, { sessionId: "owner", projectId: "project" }),
	};
}

for (const source of ["\uFEFFexport default () => null;\r\n// é😀\r\n", "export default () => null;"]) {
	test(`captured NSH reader keeps exact container and decoded source ${JSON.stringify(source)}`, async (t) => {
		const f = await fixture(t);
		const value = { ...f.value, source, nsh: nshSource(source, "view.tsx") };
		const bytes = Buffer.from(`\uFEFF${JSON.stringify(value, null, 2).replaceAll("\n", "\r\n")}\r\n`);
		await writeFile(join(f.directory, "1.json"), bytes);
		await f.pointer({ revision: 2 });
		await writeFile(join(f.directory, "2.json"), JSON.stringify({ ...value, revision: 2, source: "newer" }));
		const read = await f.store.readCapturedRevision(f.id, 1);
		assert.deepEqual(Buffer.from(read.bytes), bytes);
		assert.equal(read.artifact.source, source);
		assert.notDeepEqual(Buffer.from(JSON.stringify(read.artifact)), bytes);
		assert.deepEqual(await readFile(join(f.directory, "1.json")), bytes);
	});
}

for (const patch of [
	{ revision: 2 },
	{ id: "22222222-2222-2222-2222-222222222222" },
	{ sessionId: "other" },
	{ projectId: "other" },
	{ kind: "image" },
	{ kind: "html" },
	{ kind: "react" },
	{ kind: "swiftui" },
	{ kind: "shader" },
	{ kind: "visual" },
	{ nsh: { api: 2 } },
	{ source: null },
]) {
	test(`captured NSH reader refuses mismatched/unsupported ${JSON.stringify(patch)}`, async (t) => {
		const f = await fixture(t);
		await writeFile(join(f.directory, "1.json"), JSON.stringify({ ...f.value, ...patch }));
		await assert.rejects(f.store.readCapturedRevision(f.id, 1), /mismatch|Unsupported|Unknown|basename/);
	});
}

test("stored revision requires a committed explicit pin and exact identity, never latest", async (t) => {
	const f = await fixture(t);
	for (const revision of [0, -1, NaN, 1.1, undefined as never, 2])
		await assert.rejects(f.store.readCapturedRevision(f.id, revision));
	await assert.rejects(f.store.readCapturedRevision("../latest", 1));
	await assert.rejects(new ArtifactStore(f.root, { sessionId: "owner" }).readCapturedRevision(f.id, 1), /Unknown/);
	await f.pointer({ revision: 0 });
	await assert.rejects(f.store.readCapturedRevision(f.id, 1), /committed/);
	await f.pointer({ revision: 2 });
	await assert.rejects(f.store.readCapturedRevision(f.id, 2), /Unknown artifact revision/);
	await rm(join(f.directory, "latest.json"));
	await assert.rejects(f.store.readCapturedRevision(f.id, 1), /Unknown/);
});

test("stored revision bounds pointer and body before hydration, rejects malformed UTF-8 and symlinks", async (t) => {
	const f = await fixture(t);
	const file = join(f.directory, "1.json");
	await writeFile(file, "x".repeat(STORED_REVISION_LIMITS.containerBytes + 1));
	await assert.rejects(f.store.readCapturedRevision(f.id, 1), /Unsupported stored artifact size/);
	const small = Buffer.from(JSON.stringify(f.value));
	await writeFile(
		file,
		Buffer.concat([small, Buffer.alloc(STORED_REVISION_LIMITS.containerBytes - small.length, 32)]),
	);
	assert.equal((await f.store.readCapturedRevision(f.id, 1)).bytes.byteLength, STORED_REVISION_LIMITS.containerBytes);
	await writeFile(file, Buffer.from([0xff]));
	await assert.rejects(f.store.readCapturedRevision(f.id, 1), /UTF-8/);
	await writeFile(file, "");
	await assert.rejects(f.store.readCapturedRevision(f.id, 1), SyntaxError);
	await rm(file);
	await symlink(join(f.directory, "latest.json"), file);
	await assert.rejects(f.store.readCapturedRevision(f.id, 1));
	await writeFile(join(f.directory, "latest.json"), "x".repeat(STORED_REVISION_LIMITS.pointerBytes + 1));
	await assert.rejects(f.store.readCapturedRevision(f.id, 1), /Unsupported stored artifact size/);
	await assert.rejects(f.store.readCapturedRevision(f.id, 1, AbortSignal.abort()), { name: "AbortError" });
});

test("stored revision parse errors never echo source bytes", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.directory, "1.json"), '{"source":"private-marker" broken}');
	await assert.rejects(f.store.readCapturedRevision(f.id, 1), (error: Error) => {
		assert.doesNotMatch(error.message, /private-marker/);
		return error instanceof SyntaxError;
	});
	await writeFile(join(f.directory, "latest.json"), '"private-marker" broken');
	await assert.rejects(f.store.readCapturedRevision(f.id, 1), (error: Error) => {
		assert.doesNotMatch(error.message, /private-marker/);
		return error instanceof SyntaxError;
	});
});

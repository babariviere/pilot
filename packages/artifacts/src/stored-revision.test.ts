import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ArtifactStore } from "./store.ts";
import { STORED_REVISION_LIMITS } from "./stored-revision.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "stored-artifact-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const id = "11111111-1111-1111-1111-111111111111";
	const directory = join(root, "artifacts", id);
	await mkdir(directory, { recursive: true });
	const value = {
		id,
		revision: 1,
		sessionId: "owner",
		projectId: "project",
		kind: "visual",
		title: "Exact",
		createdAt: 1,
		updatedAt: 2,
		source: "function visual() {}",
		data: null,
		html: "Stored document, never executed",
		libraries: [],
		libraryVersions: {},
		visual: { api: 1, engine: "stored-engine", check: { nodes: 0, controls: 0, interactions: 0, logs: [] } },
	};
	const pointer = async (patch = {}) => {
		const {
			source: _source,
			data: _data,
			html: _html,
			visual: _visual,
			libraries: _libraries,
			libraryVersions: _versions,
			...summary
		} = value;
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

for (const source of ["\uFEFFfunction visual() {\r\n// é😀\r\n}", "", "\uFEFF", "é😀\r\n"]) {
	test(`stored visual reader keeps exact container and decoded source ${JSON.stringify(source)}`, async (t) => {
		const f = await fixture(t);
		const value = { ...f.value, source, data: { text: "\uFEFFé😀\r\n", empty: "" } };
		const bytes = Buffer.from(`\uFEFF${JSON.stringify(value, null, 2).replaceAll("\n", "\r\n")}\r\n`);
		await writeFile(join(f.directory, "1.json"), bytes);
		await f.pointer({ revision: 2 });
		await writeFile(join(f.directory, "2.json"), JSON.stringify({ ...value, revision: 2, source: "newer" }));
		const read = await f.store.readStoredRevision(f.id, 1);
		assert.deepEqual(Buffer.from(read.bytes), bytes);
		assert.equal(read.artifact.source, source);
		assert.deepEqual(read.artifact.data, value.data);
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
	{ visual: { api: 2, engine: "unsupported" } },
	{ source: null },
]) {
	test(`stored visual reader refuses mismatched/unsupported ${JSON.stringify(patch)}`, async (t) => {
		const f = await fixture(t);
		await writeFile(join(f.directory, "1.json"), JSON.stringify({ ...f.value, ...patch }));
		await assert.rejects(f.store.readStoredRevision(f.id, 1), /mismatch|Unsupported/);
	});
}

test("stored revision requires a committed explicit pin and exact identity, never latest", async (t) => {
	const f = await fixture(t);
	for (const revision of [0, -1, NaN, 1.1, undefined as never, 2])
		await assert.rejects(f.store.readStoredRevision(f.id, revision));
	await assert.rejects(f.store.readStoredRevision("../latest", 1));
	await assert.rejects(new ArtifactStore(f.root, { sessionId: "owner" }).readStoredRevision(f.id, 1), /Unknown/);
	await f.pointer({ revision: 0 });
	await assert.rejects(f.store.readStoredRevision(f.id, 1), /committed/);
	await f.pointer({ revision: 2 });
	await assert.rejects(f.store.readStoredRevision(f.id, 2), /Unknown artifact revision/);
	await rm(join(f.directory, "latest.json"));
	await assert.rejects(f.store.readStoredRevision(f.id, 1), /Unknown/);
});

test("stored revision bounds pointer and body before hydration, rejects malformed UTF-8 and symlinks", async (t) => {
	const f = await fixture(t);
	const file = join(f.directory, "1.json");
	await writeFile(file, "x".repeat(STORED_REVISION_LIMITS.containerBytes + 1));
	await assert.rejects(f.store.readStoredRevision(f.id, 1), /Unsupported stored artifact size/);
	const small = Buffer.from(JSON.stringify(f.value));
	await writeFile(
		file,
		Buffer.concat([small, Buffer.alloc(STORED_REVISION_LIMITS.containerBytes - small.length, 32)]),
	);
	assert.equal((await f.store.readStoredRevision(f.id, 1)).bytes.byteLength, STORED_REVISION_LIMITS.containerBytes);
	await writeFile(file, Buffer.from([0xff]));
	await assert.rejects(f.store.readStoredRevision(f.id, 1), /UTF-8/);
	await writeFile(file, "");
	await assert.rejects(f.store.readStoredRevision(f.id, 1), SyntaxError);
	await rm(file);
	await symlink(join(f.directory, "latest.json"), file);
	await assert.rejects(f.store.readStoredRevision(f.id, 1));
	await writeFile(join(f.directory, "latest.json"), "x".repeat(STORED_REVISION_LIMITS.pointerBytes + 1));
	await assert.rejects(f.store.readStoredRevision(f.id, 1), /Unsupported stored artifact size/);
	await assert.rejects(f.store.readStoredRevision(f.id, 1, AbortSignal.abort()), { name: "AbortError" });
});

test("stored revision parse errors never echo source bytes", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.directory, "1.json"), '{"source":"private-marker" broken}');
	await assert.rejects(f.store.readStoredRevision(f.id, 1), (error: Error) => {
		assert.doesNotMatch(error.message, /private-marker/);
		return error instanceof SyntaxError;
	});
	await writeFile(join(f.directory, "latest.json"), '"private-marker" broken');
	await assert.rejects(f.store.readStoredRevision(f.id, 1), (error: Error) => {
		assert.doesNotMatch(error.message, /private-marker/);
		return error instanceof SyntaxError;
	});
});

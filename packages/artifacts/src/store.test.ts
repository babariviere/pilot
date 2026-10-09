import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactLibraries } from "./render.ts";
import { ArtifactNotFound, ArtifactStore } from "./store.ts";

const document = { title: "Graph", kind: "html" as const, source: "<h1>Hello</h1>" };

test("artifacts persist project/session ownership and immutable revisions", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-artifacts-"));
	try {
		const store = new ArtifactStore(dir, { sessionId: "session", projectId: "project" });
		assert.deepEqual(await store.list(), []);
		const first = await store.create(document);
		assert.equal(first.revision, 1);
		assert.equal(first.projectId, "project");
		assert.match(first.html, /Content-Security-Policy/);
		const second = await store.update(first.id, { ...document, source: "<h1>Updated</h1>" }, 1);
		assert.equal(second.revision, 2);
		assert.equal(second.createdAt, first.createdAt);
		const reopened = new ArtifactStore(dir, { sessionId: "session", projectId: "project" });
		assert.equal((await reopened.get(first.id, 1)).source, first.source);
		assert.equal((await reopened.get(first.id)).source, second.source);
		assert.equal((await reopened.list())[0]?.revision, 2);
		assert.ok(!("html" in (await reopened.list())[0]!));
		await assert.rejects(reopened.update(first.id, document, 1), /revision conflict/);
		await assert.rejects(reopened.get(first.id, 3), ArtifactNotFound);
		await assert.rejects(new ArtifactStore(dir, { sessionId: "other" }).get(first.id), ArtifactNotFound);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("failed updates leave latest intact and serialize concurrent revisions", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-artifacts-"));
	try {
		const store = new ArtifactStore(dir, { sessionId: "session" });
		const first = await store.create(document);
		await assert.rejects(store.update(first.id, { ...document, kind: "react", source: "broken jsx <>" }));
		assert.equal((await store.get(first.id)).revision, 1);
		const results = await Promise.all([store.update(first.id, document), store.update(first.id, document)]);
		assert.deepEqual(
			results.map((item) => item.revision),
			[2, 3],
		);
		assert.equal((await store.list())[0]?.revision, 3);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("path traversal and uncommitted revisions are not readable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-artifacts-"));
	try {
		const store = new ArtifactStore(dir, { sessionId: "session" });
		await assert.rejects(store.get("../../meta"), ArtifactNotFound);
		const id = "11111111-1111-1111-1111-111111111111";
		await mkdir(join(dir, "artifacts", id), { recursive: true });
		await writeFile(join(dir, "artifacts", id, "1.json"), "{}");
		assert.deepEqual(await store.list(), []);
		await assert.rejects(store.get(id, 1), ArtifactNotFound);
		await assert.rejects(
			store.create({ ...document, libraries: ["constructor" as never] }),
			/Unknown artifact library/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("one damaged latest pointer does not hide the other artifacts", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	const dir = await mkdtemp(join(tmpdir(), "pilot-artifacts-"));
	try {
		const store = new ArtifactStore(dir, { sessionId: "session" });
		const good = await store.create(document);
		const id = "22222222-2222-2222-2222-222222222222";
		await mkdir(join(dir, "artifacts", id), { recursive: true });
		await writeFile(join(dir, "artifacts", id, "latest.json"), "{trunc");
		assert.deepEqual(
			(await store.list()).map((item) => item.id),
			[good.id],
		);
		assert.equal(warn.mock.callCount(), 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("image bytes are stored once and the image document is rebuilt on read", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-artifacts-"));
	try {
		const store = new ArtifactStore(dir, { sessionId: "session" });
		const source =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
		const created = await store.create({ title: "Pixel", kind: "image", source });
		const raw = JSON.parse(await readFile(join(dir, "artifacts", created.id, "1.json"), "utf8"));
		assert.equal(raw.html, "");
		assert.equal((await store.get(created.id)).html, created.html);
		assert.ok(created.html.includes(source));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("revisions record the library versions they were prepared with", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-artifacts-"));
	try {
		const store = new ArtifactStore(dir, { sessionId: "session" });
		const created = await store.create({ ...document, libraries: ["mermaid"] });
		assert.deepEqual((await store.get(created.id)).libraryVersions, { mermaid: artifactLibraries.mermaid.version });
		assert.ok(!("libraryVersions" in (await store.list())[0]!));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

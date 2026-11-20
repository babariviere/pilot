import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LegacyArtifactFixture } from "./fixtures/legacy-fixture.ts";
import { ArtifactNotFound, ArtifactStore } from "./store.ts";

const document = {
	title: "Pixel",
	kind: "image" as const,
	source:
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==",
};

for (const kind of ["html", "react", "swiftui", "visual", "shader"] as const) {
	test(`${kind} history stays on disk but is unavailable through the store`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "artifact-legacy-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const fixture = new LegacyArtifactFixture(dir, { sessionId: "legacy", projectId: "project" });
		const first = await fixture.create({ title: "Legacy", kind, source: "exact old source", libraries: ["react"] });
		await fixture.update(first.id, { title: "Legacy", kind, source: "exact latest source", libraries: ["react"] }, 1);
		const paths = ["1.json", "2.json", "latest.json"].map((name) => join(dir, "artifacts", first.id, name));
		const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
		const store = new ArtifactStore(dir, { sessionId: "legacy", projectId: "project" });
		await assert.rejects(store.get(first.id, 1), ArtifactNotFound);
		await assert.rejects(store.get(first.id), ArtifactNotFound);
		await assert.rejects(store.summary(first.id), ArtifactNotFound);
		await assert.rejects(store.readCapturedRevision(first.id, 1), ArtifactNotFound);
		await assert.rejects(store.update(first.id, document, 2), ArtifactNotFound);
		const index = store.searchMetadata();
		assert.deepEqual(await index.read(10), { rows: [], visited: 1, more: false, partial: false });
		for (const action of ["create", "update"] as const) {
			const write = { title: "Rejected", kind: kind as never, source: "while(true){}" };
			await assert.rejects(
				action === "create" ? store.create(write) : store.update(first.id, write, 2),
				/Supported artifact kinds/,
			);
		}
		assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), before);
		assert.deepEqual(await store.list(), []);
	});
}

test("artifacts persist project/session ownership and immutable revisions", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-artifacts-"));
	try {
		const store = new ArtifactStore(dir, { sessionId: "session", projectId: "project" });
		assert.deepEqual(await store.list(), []);
		const first = await store.create(document);
		assert.equal(first.revision, 1);
		assert.equal(first.projectId, "project");
		assert.match(first.html, /Content-Security-Policy/);
		const second = await store.update(first.id, { ...document, title: "Updated" }, 1);
		assert.equal(second.revision, 2);
		assert.equal(second.createdAt, first.createdAt);
		const reopened = new ArtifactStore(dir, { sessionId: "session", projectId: "project" });
		assert.equal((await reopened.get(first.id, 1)).source, first.source);
		assert.equal((await reopened.get(first.id)).title, second.title);
		assert.equal((await reopened.list())[0]?.revision, 2);
		assert.ok(!("html" in (await reopened.list())[0]!));
		assert.deepEqual(await reopened.summary(first.id), (await reopened.list())[0]);
		await assert.rejects(new ArtifactStore(dir, { sessionId: "other" }).summary(first.id), ArtifactNotFound);
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
		await assert.rejects(store.update(first.id, { ...document, kind: "react" as never, source: "broken jsx" }));
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
		await assert.rejects(store.summary("../../meta"), ArtifactNotFound);
		const id = "11111111-1111-1111-1111-111111111111";
		await mkdir(join(dir, "artifacts", id), { recursive: true });
		await writeFile(join(dir, "artifacts", id, "1.json"), "{}");
		assert.deepEqual(await store.list(), []);
		await assert.rejects(store.get(id, 1), ArtifactNotFound);
		await assert.rejects(store.summary(id), ArtifactNotFound);
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

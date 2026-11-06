import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LegacyArtifactFixture } from "../test/legacy-fixture.ts";
import { ArtifactNotFound, ArtifactStore } from "./store.ts";

const document = {
	title: "Graph",
	kind: "visual" as const,
	source: 'function visual({ ui }) { return () => ui.text("Hello"); }',
};

test("publication keeps JSON data, normalized titles and exact source", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "artifact-serialization-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const store = new ArtifactStore(dir, { sessionId: "session" });
	const data = { label: "é", values: [0, false, null] };
	const source =
		'  ({ ui, data }) => { if (data.label !== "é") throw Error("wrong data"); return () => ui.text(data.label); }\r\n';
	const created = await store.create({ title: "  Native  ", kind: "visual", source, data });
	assert.equal(created.title, "Native");
	assert.equal(created.source, source);
	assert.equal(created.data, data);
	const stored = await store.get(created.id);
	assert.equal(stored.title, "Native");
	assert.equal(stored.source, source);
	assert.deepEqual(stored.data, data);
	const directory = join(dir, "artifacts", created.id);
	const before = await readFile(join(directory, "latest.json"));
	await assert.rejects(store.update(created.id, { ...document, data: "é".repeat(512 * 1024) }), /1 MiB/);
	assert.deepEqual(await readFile(join(directory, "latest.json")), before);
	await assert.rejects(readFile(join(directory, "2.json")), { code: "ENOENT" });
});

for (const kind of ["html", "react", "swiftui"] as const) {
	test(`${kind} history stays exact and inert; rejected writes leave bytes untouched`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "artifact-legacy-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const fixture = new LegacyArtifactFixture(dir, { sessionId: "legacy", projectId: "project" });
		const first = await fixture.create({ title: "Legacy", kind, source: "exact old source", libraries: ["react"] });
		const latest = await fixture.update(
			first.id,
			{ title: "Legacy", kind, source: "exact latest source", libraries: ["react"] },
			1,
		);
		const paths = ["1.json", "2.json", "latest.json"].map((name) => join(dir, "artifacts", first.id, name));
		const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
		const store = new ArtifactStore(dir, { sessionId: "legacy" });
		assert.deepEqual(await store.get(first.id, 1), first);
		assert.deepEqual(await store.get(first.id), latest);
		assert.equal((await store.list())[0]?.kind, kind);
		await assert.rejects(store.update(first.id, document, 2), /Supported kinds/);
		for (const action of ["create", "update"] as const) {
			const write = { title: "Rejected", kind: kind as never, source: "while(true){}" };
			await assert.rejects(
				action === "create" ? store.create(write) : store.update(first.id, write, 2),
				/Supported kinds/,
			);
		}
		assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), before);
		assert.equal((await store.list()).length, 1);
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
		const second = await store.update(
			first.id,
			{ ...document, source: document.source.replace("Hello", "Updated") },
			1,
		);
		assert.equal(second.revision, 2);
		assert.equal(second.createdAt, first.createdAt);
		const reopened = new ArtifactStore(dir, { sessionId: "session", projectId: "project" });
		assert.equal((await reopened.get(first.id, 1)).source, first.source);
		assert.equal((await reopened.get(first.id)).source, second.source);
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
		await assert.rejects(store.create({ ...document, libraries: ["constructor" as never] }), /do not use libraries/);
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

test("visual revisions keep source, data, versions and the check, with a fallback page", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-artifacts-"));
	try {
		const store = new ArtifactStore(dir, { sessionId: "session" });
		const source =
			'function visual({ ui, state, data }) {\n  const s = state({ on: false });\n  return () => ui.column([ui.text(data?.title ?? "Untitled"), ui.toggle({ label: "On", value: s.on, onChange: (v) => (s.on = v) })]);\n}';
		const created = await store.create({ title: "Toggle", kind: "visual", source, data: { title: "Hello" } });
		assert.equal(created.source, source);
		assert.deepEqual(created.data, { title: "Hello" });
		assert.deepEqual(created.visual, {
			api: 1,
			engine: "quickjs-ng 0.17.0",
			check: { nodes: 3, controls: 1, interactions: 2, draws: 0, logs: [] },
		});
		assert.deepEqual(created.libraries, []);
		assert.match(created.html, /newer version of Pilot/);
		const read = await new ArtifactStore(dir, { sessionId: "session" }).get(created.id);
		assert.deepEqual(read, created);
		const [summary] = await store.list();
		assert.ok(summary && !("data" in summary) && !("visual" in summary));
		const updated = await store.update(created.id, { title: "Toggle", kind: "visual", source }, 1);
		assert.equal(updated.data, null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("failing visuals, data on other kinds and libraries on visuals save nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-artifacts-"));
	try {
		const store = new ArtifactStore(dir, { sessionId: "session" });
		await assert.rejects(
			store.create({
				title: "Broken",
				kind: "visual",
				source: '({ ui }) => () =>\n  ui.text("x", { color: "red" })',
			}),
			/Nothing was published\. line 2: text: color "red" is not a color token/,
		);
		await assert.rejects(
			store.create({
				title: "Shader",
				kind: "shader",
				source: "void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }",
				data: { a: 1 },
			}),
			/Only visual artifacts take data/,
		);
		await assert.rejects(
			store.create({ title: "Lib", kind: "visual", source: "() => () => null", libraries: ["d3"] }),
			/Visual artifacts do not use libraries/,
		);
		assert.deepEqual(await store.list(), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

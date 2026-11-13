import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareNshRevision } from "./nsh-host.ts";
import { captureNshSource, ensureArtifactScratch, NSH_SOURCE_BYTES } from "./nsh-source.ts";
import { ArtifactStore } from "./store.ts";

const host = process.env.NSH_ARTIFACT_TEST_HOST;
const capture = (root: string, path: string, signal?: AbortSignal) => captureNshSource(root, path, signal, host);
const scratch = (root: string) => ensureArtifactScratch(root, host);
const captureOptions = {
	skip:
		process.platform === "darwin" && !host
			? "Run apps/day/scripts/test-artifact-source.mjs for native openat capture"
			: false,
};

test(
	"NSH capture keeps exact BOM/CRLF/Unicode bytes across revisions, reopen and scratch cleanup",
	captureOptions,
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "nsh-source-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const directory = await scratch(root);
		const path = join(directory, "one.tsx");
		const first = Buffer.from('\uFEFFexport default function Artifact() { return "é😀"; }\r\n');
		await writeFile(path, first);
		const captured = await capture(root, path);
		assert.deepEqual(Buffer.from(captured.source), first);
		assert.equal(captured.nsh.sourceSha256, createHash("sha256").update(first).digest("hex"));
		assert.equal(captured.nsh.sourceBytes, first.length);
		const identity = { sessionId: "owner", projectId: "project" };
		const store = new ArtifactStore(root, identity);
		const a = await store.create({ title: "One", kind: "nsh", source: captured.source, entry: captured.entry });
		await assert.rejects(
			store.update(a.id, { title: "No CAS", kind: "nsh", source: captured.source, entry: captured.entry }),
			/expectedRevision/,
		);
		await assert.rejects(
			store.update(a.id, { title: "Other kind", kind: "image", source: "not an image" }, 1),
			/cannot change kind/,
		);
		await writeFile(path, "export default () => 'changed';\n");
		assert.deepEqual(Buffer.from((await store.get(a.id, 1)).source), first, "no live source link");
		const next = await capture(root, "one.tsx");
		const b = await store.update(a.id, { title: "Two", kind: "nsh", source: next.source, entry: next.entry }, 1);
		assert.equal(b.revision, 2);
		assert.notEqual(b.nsh?.sourceSha256, a.nsh?.sourceSha256);
		await assert.rejects(
			store.update(a.id, { title: "Stale", kind: "nsh", source: next.source, entry: next.entry }, 1),
			/conflict/,
		);
		await rm(join(root, "scratch"), { recursive: true });
		const reopened = new ArtifactStore(root, identity);
		assert.deepEqual(Buffer.from((await reopened.get(a.id, 1)).source), first);
		assert.equal((await reopened.readCapturedRevision(a.id, 2)).artifact.nsh?.rendering, "unsupported");
		assert.equal((await reopened.get(a.id, 1)).html, "");
		assert.equal((await reopened.list())[0]?.revision, 2);
		if (host) {
			const prepared = await prepareNshRevision(await reopened.get(a.id, 1), undefined, host);
			assert.equal(prepared.sourceSha256, captured.nsh.sourceSha256);
			assert.equal(prepared.revision, 1);
			assert.equal(prepared.rendering, "unsupported");
		}
		const stored = JSON.parse(await readFile(join(root, "artifacts", a.id, "2.json"), "utf8"));
		stored.nsh.sourceSha256 = "0".repeat(64);
		await writeFile(join(root, "artifacts", a.id, "2.json"), JSON.stringify(stored));
		await assert.rejects(reopened.readCapturedRevision(a.id, 2), /NSH representation/);
	},
);

test(
	"NSH capture denies escapes, links, binary, oversize, cancellation and unsupported paths",
	captureOptions,
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "nsh-capture-deny-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const directory = await scratch(root);
		await writeFile(join(directory, "ok.tsx"), "export default () => null;");
		for (const path of ["../ok.tsx", "sub/ok.tsx", "/not-here.tsx", "https://no.tsx", "ok.js", ""]) {
			await assert.rejects(capture(root, path), /sourcePath/);
		}
		await symlink(join(directory, "ok.tsx"), join(directory, "alias.tsx"));
		await assert.rejects(capture(root, "alias.tsx"));
		await link(join(directory, "ok.tsx"), join(directory, "hard.tsx"));
		await assert.rejects(capture(root, "hard.tsx"), /Unsafe/);
		await mkdir(join(directory, "folder.tsx"));
		await assert.rejects(capture(root, "folder.tsx"), /Unsafe/);
		await writeFile(join(directory, "binary.tsx"), Buffer.from([0xff, 0xfe]));
		await assert.rejects(capture(root, "binary.tsx"));
		await writeFile(join(directory, "large.tsx"), Buffer.alloc(NSH_SOURCE_BYTES + 1));
		await assert.rejects(capture(root, "large.tsx"), /512 KiB/);
		await assert.rejects(capture(root, "missing.tsx"), /unavailable|ENOENT/);
		const abort = new AbortController();
		abort.abort();
		await assert.rejects(capture(root, "ok.tsx", abort.signal), { name: "AbortError" });
		await rm(directory, { recursive: true });
		await symlink(root, directory);
		await assert.rejects(capture(root, "ok.tsx"));
		await assert.rejects(scratch(root));
	},
);

test("NSH failed publication leaves history intact and cannot produce an oversized stored container", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nsh-container-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new ArtifactStore(root, { sessionId: "owner" });
	const a = await store.create({ title: "A", kind: "nsh", source: "export default () => null;", entry: "a.tsx" });
	await assert.rejects(
		store.update(a.id, { title: "Large", kind: "nsh", source: "\u0001".repeat(300_000), entry: "a.tsx" }, 1),
		/1 MiB/,
	);
	assert.equal((await store.get(a.id)).revision, 1);
	assert.equal((await store.list()).length, 1);
	await assert.rejects(store.create({ title: "Invalid", kind: "nsh", source: "\ud800", entry: "a.tsx" }), /UTF-8/);
	assert.equal((await store.list()).length, 1);
});

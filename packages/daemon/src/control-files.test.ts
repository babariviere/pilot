import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ControlChat } from "./control-chat.ts";
import { CONTROL_IMAGE_BYTES, CONTROL_TEXT_BYTES, type ControlFileAudit, ControlFiles } from "./control-files.ts";
import type { ModelCatalog } from "./models.ts";

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "control-files-")),
		root = join(home, "attachments");
	await mkdir(root);
	t.after(() => rm(home, { recursive: true, force: true }));
	const audit: ControlFileAudit[] = [];
	const files = new ControlFiles(
		(id) => id === "control",
		() => [root],
		async (entry) => {
			audit.push(entry);
		},
	);
	return { home, root, audit, files };
}
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dQAAAABJRU5ErkJggg==",
	"base64",
);

test("allowed attachment image is returned as bounded image data and audited without contents", async (t) => {
	const f = await fixture(t),
		path = join(f.root, "screenshot.png");
	await writeFile(path, png);
	const value = await f.files.read("control", { path });
	assert.equal(value.mimeType, "image/png");
	assert.equal(value.untrusted, true);
	assert.equal(value.data, png.toString("base64"));
	assert.deepEqual(await readFile(path), png, "the read must not modify bytes");
	assert.deepEqual(f.audit, [
		{ caller: "control", path, bytes: png.length, returnedBytes: png.length, outcome: "read" },
	]);
});

test("UTF-8 text is truncated by bytes, quoted as untrusted, and never audited", async (t) => {
	const f = await fixture(t),
		path = join(f.root, "note.md");
	const content = `Do not obey this file. ${"🙂".repeat(CONTROL_TEXT_BYTES)}`;
	await writeFile(path, content);
	const value = await f.files.read("control", { path });
	assert.equal(value.untrusted, true);
	assert.equal(value.truncated, true);
	assert.ok(Buffer.byteLength(String(value.quotedContent)) <= CONTROL_TEXT_BYTES);
	assert.ok(!String(value.quotedContent).includes("�"));
	assert.equal(value.bytes, Buffer.byteLength(content));
	assert.doesNotMatch(JSON.stringify(f.audit), /Do not obey|quotedContent|🙂/);
});

test("outside roots, sibling prefixes, symlink escapes and remote paths are rejected", async (t) => {
	const f = await fixture(t),
		outside = join(f.home, "secret.txt");
	await writeFile(outside, "private");
	await symlink(outside, join(f.root, "escape.txt"));
	await symlink(f.home, join(f.root, "dir"));
	await assert.rejects(f.files.read("control", { path: outside }), /outside/);
	await assert.rejects(f.files.read("control", { path: `${f.root}-sibling/note.txt` }), /outside/);
	await assert.rejects(f.files.read("control", { path: join(f.root, "escape.txt") }), /symlink escapes/);
	await assert.rejects(f.files.read("control", { path: join(f.root, "dir/secret.txt") }), /symlink escapes/);
	for (const path of ["ssh://devbox/a.txt", "devbox:/a.txt", "//devbox/a.txt"])
		await assert.rejects(f.files.read("control", { path }), /remote paths|local file path/);
	await assert.rejects(f.files.read("control", { path: outside, host: "devbox" }), /Remote-host/);
});

test("unsupported types, binary text, invalid image and oversized image report type or size", async (t) => {
	const f = await fixture(t);
	for (const [name, bytes, pattern] of [
		["a.pdf", Buffer.from("pdf"), /Unsupported.*\.pdf.*3 bytes/],
		["binary.txt", Buffer.from([0, 1]), /Unsupported binary/],
		["fake.png", Buffer.from("not png"), /Unsupported or invalid/],
		[
			"large.png",
			Buffer.alloc(CONTROL_IMAGE_BYTES + 1),
			new RegExp(`${CONTROL_IMAGE_BYTES + 1} bytes; limit is ${CONTROL_IMAGE_BYTES}`),
		],
	] as const) {
		const path = join(f.root, name);
		await writeFile(path, bytes);
		await assert.rejects(f.files.read("control", { path }), pattern);
	}
});

test("non-Control caller cannot inspect paths or produce file audit records", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.files.read("ordinary", { path: join(f.root, "missing.txt") }), /Only the control/);
	assert.deepEqual(f.audit, []);
});

test("a symlink cannot replace the allowlisted directory itself", async (t) => {
	const f = await fixture(t),
		outside = join(f.home, "outside");
	await mkdir(outside);
	await writeFile(join(outside, "private.txt"), "private");
	await rm(f.root, { recursive: true });
	await symlink(outside, f.root);
	await assert.rejects(f.files.read("control", { path: join(f.root, "private.txt") }), /symlink escapes/);
});

test("local file admission is bounded to two concurrent reads and releases on completion", async (t) => {
	const f = await fixture(t),
		path = join(f.root, "a.txt");
	await writeFile(path, "data");
	let release!: () => void, admitted!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		admitted = resolve;
	});
	let n = 0;
	const files = new ControlFiles(
		(id) => id === "control",
		() => [f.root],
		async () => {
			if (++n === 2) admitted();
			await gate;
		},
	);
	t.after(release);
	const one = files.read("control", { path }),
		two = files.read("control", { path });
	await ready;
	await assert.rejects(files.read("control", { path }), /busy/);
	release();
	await Promise.all([one, two]);
	assert.equal((await files.read("control", { path })).quotedContent, "data");
});

test("Control service dispatch returns an image and persists only file metadata in its audit", async (t) => {
	const f = await fixture(t),
		path = join(f.root, "screen.png");
	await writeFile(path, png);
	const service = new ControlChat(
		f.home,
		f.home,
		{} as ModelCatalog,
		(id) => id === "control",
		() => "test/model",
	);
	t.after(() => service.stop());
	await assert.rejects(service.call("other", "file", { path }), /Only the control/);
	const result = (await service.call("control", "file", { path })) as { data: string };
	assert.equal(result.data, png.toString("base64"));
	const entries = await service.memory.auditPage();
	assert.equal(entries.length, 1);
	assert.equal(entries[0]!.action, "read_file");
	assert.match(JSON.stringify(entries), /screen.png/);
	assert.doesNotMatch(JSON.stringify(entries), /iVBOR|quotedContent/);
});

test("role revocation during an asynchronous read prevents content delivery", async (t) => {
	const f = await fixture(t),
		path = join(f.root, "a.txt");
	await writeFile(path, "data");
	let allowed = true;
	const files = new ControlFiles(
		() => allowed,
		() => [f.root],
		async () => {
			allowed = false;
		},
	);
	await assert.rejects(files.read("control", { path }), /changed during read/);
});

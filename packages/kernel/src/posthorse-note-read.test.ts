import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createJiti } from "jiti";

const LIMIT = 1024 * 1024;
type Reader = (path: string, expected: Awaited<ReturnType<typeof fs.stat>>, signal?: AbortSignal) => Promise<Buffer>;

async function fixture(t: TestContext) {
	const directory = await fs.mkdtemp(join(tmpdir(), "posthorse-note-read-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	// Verify the installed package has the exact limited reader, then exercise that real module.
	const patch = await fs.readFile(new URL("../../../patches/pi-posthorse@0.10.10.patch", import.meta.url), "utf8");
	const added = patch.split("diff --git a/src/note-read.ts b/src/note-read.ts\n")[1];
	assert.ok(added, "patch must include the limited reader");
	const source = added
		.split("\n")
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
		.map((line) => line.slice(1))
		.join("\n");
	const moduleUrl = import.meta.resolve("pi-posthorse/src/note-read.ts");
	assert.equal((await fs.readFile(new URL(moduleUrl), "utf8")).trim(), source.trim());
	const reader = await createJiti(import.meta.url).import<{ readNoteBytes: Reader }>(moduleUrl);
	const path = join(directory, "task.md");
	await fs.writeFile(path, "Checkpoint\n");
	return { ...reader, path, directory, patch };
}

test("note patch decodes and checks binary data from one limited snapshot", async (t) => {
	const { readNoteBytes, path, patch } = await fixture(t);
	const content = Buffer.from("Résumé\r\n保持\n");
	await fs.writeFile(path, content);
	assert.deepEqual(await readNoteBytes(path, await fs.stat(path)), content);
	assert.match(patch, /\+\s*const bytes = await readNoteBytes\(path, info, access.signal\)/);
	assert.match(patch, /\+\s*const text = bytes.toString\("utf8"\)/);
	assert.match(patch, /-\s*if \(await isBinaryFile\(path\)\)/);
});

test("note reader accepts exactly 1 MiB and rejects larger files", async (t) => {
	const { readNoteBytes, path } = await fixture(t);
	await fs.writeFile(path, Buffer.alloc(LIMIT, 120));
	assert.equal((await readNoteBytes(path, await fs.stat(path))).length, LIMIT);
	await fs.appendFile(path, "x");
	await assert.rejects(readNoteBytes(path, await fs.stat(path)), /1 MiB read limit/);
});

test("growing note reads at most 1 MiB plus one byte", async (t) => {
	const { readNoteBytes, path } = await fixture(t);
	const expected = await fs.stat(path);
	let total = 0;
	let closed = false;
	t.mock.method(fs, "open", async () => ({
		stat: async () => expected,
		read: async (buffer: Buffer, offset: number, length: number) => {
			buffer.fill(120, offset, offset + length);
			total += length;
			return { bytesRead: length, buffer };
		},
		close: async () => {
			closed = true;
		},
	}));
	await assert.rejects(readNoteBytes(path, expected), /1 MiB read limit/);
	assert.equal(total, LIMIT + 1);
	assert.equal(closed, true);
});

test("note reader rejects replacement between stat and open", async (t) => {
	const { readNoteBytes, path, directory } = await fixture(t);
	const expected = await fs.stat(path);
	await fs.rename(path, join(directory, "old.md"));
	await fs.writeFile(path, "Checkpoint\n");
	await assert.rejects(readNoteBytes(path, expected), /changed before reading/);
});

test("note reader rejects a pathname replaced during the read", async (t) => {
	const { readNoteBytes, path, directory } = await fixture(t);
	const expected = await fs.stat(path);
	const open = fs.open;
	t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const file = await open(...args);
		const read = file.read.bind(file);
		let replaced = false;
		file.read = (async (...readArgs: unknown[]) => {
			const result = await Reflect.apply(read, file, readArgs);
			if (!replaced) {
				replaced = true;
				await fs.rename(path, join(directory, "old.md"));
				await fs.writeFile(path, "Checkpoint\n");
			}
			return result;
		}) as typeof file.read;
		return file;
	});
	await assert.rejects(readNoteBytes(path, expected), /changed while reading/);
});

test("note reader rejects same-size modification during the read", async (t) => {
	const { readNoteBytes, path } = await fixture(t);
	const expected = await fs.stat(path);
	const open = fs.open;
	t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const file = await open(...args);
		const stat = file.stat.bind(file);
		let count = 0;
		file.stat = (async () => {
			const info = await stat();
			if (++count > 1) info.mtimeMs += 1;
			return info;
		}) as typeof file.stat;
		return file;
	});
	await assert.rejects(readNoteBytes(path, expected), /changed while reading/);
});

test("note reader closes its handle when aborted during reading", async (t) => {
	const { readNoteBytes, path } = await fixture(t);
	const expected = await fs.stat(path);
	const controller = new AbortController();
	let closed = false;
	t.mock.method(fs, "open", async () => ({
		stat: async () => expected,
		read: async () => {
			controller.abort();
			return { bytesRead: 0 };
		},
		close: async () => {
			closed = true;
		},
	}));
	await assert.rejects(readNoteBytes(path, expected, controller.signal), { name: "AbortError" });
	assert.equal(closed, true);
});

test("already aborted note read never opens a handle", async (t) => {
	const { readNoteBytes, path } = await fixture(t);
	const expected = await fs.stat(path);
	const open = t.mock.method(fs, "open", async () => assert.fail("aborted read opened a handle"));
	await assert.rejects(readNoteBytes(path, expected, AbortSignal.abort()), { name: "AbortError" });
	assert.equal(open.mock.callCount(), 0);
});

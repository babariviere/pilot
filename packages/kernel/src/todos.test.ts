import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TodosUpdateEvent } from "@pilot/protocol";
import { parseTodo, TodosWatch, todosDirectory } from "./todos.ts";

const record = (title = "Add tests", extra = {}) => ({
	id: "deadbeef",
	title,
	status: "open",
	created_at: "2026-07-01T00:00:00Z",
	tags: [],
	...extra,
});
const markdown = (value: unknown) => `${JSON.stringify(value, null, 2)}\n\nBody with {braces}\n`;

test("TODO reader accepts extension front matter and ignores markdown bodies and private fields", () => {
	assert.deepEqual(
		parseTodo(
			markdown(record('Escaped "quote", \\ and {braces}', { assigned_to_session: "session-1", secret: "hidden" })),
			"DEADBEEF",
		),
		{
			id: "TODO-deadbeef",
			title: 'Escaped "quote", \\ and {braces}',
			status: "open",
			createdAt: "2026-07-01T00:00:00Z",
			assignedToSession: "session-1",
		},
	);
	assert.equal(parseTodo("{partial", "deadbeef"), undefined);
	assert.equal(parseTodo("Not JSON", "deadbeef"), undefined);
	assert.equal(parseTodo(markdown({ title: 42, status: "open" }), "deadbeef"), undefined);
	assert.equal(parseTodo(JSON.stringify(record()), "deadbeef")?.assignedToSession, undefined);
});

test("TODO path matches extension defaults and relative/absolute environment overrides", () => {
	assert.equal(todosDirectory("/workspace", ""), "/workspace/.pi/todos");
	assert.equal(todosDirectory("/workspace", " shared/tasks "), "/workspace/shared/tasks");
	assert.equal(todosDirectory("/workspace", "/shared/tasks"), "/shared/tasks");
});

test("TODO watch sends a fresh snapshot, live mutations, and deletions, without duplicate updates", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-todos-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, ".pi/todos");
	const watch = new TodosWatch(directory);
	const events: TodosUpdateEvent[] = [];
	const stop = watch.subscribe((event) => events.push(event));
	t.after(stop);
	assert.deepEqual(events, [{ type: "todos_update", items: [] }]);
	await mkdir(directory, { recursive: true });
	const file = join(directory, "deadbeef.md");
	await writeFile(file, markdown(record()));
	await writeFile(join(directory, "settings.json"), "{}");
	await writeFile(join(directory, "invalid.md"), markdown(record()));
	await writeFile(join(directory, "deadbeef.lock"), "{}");
	await mkdir(join(directory, "aabbccdd.md"));
	if (process.platform !== "win32") execFileSync("mkfifo", [join(directory, "12345678.md")]);
	await watch.refresh();
	assert.equal(events.at(-1)?.items.length, 1);
	await watch.refresh();
	assert.equal(events.length, 2);
	await writeFile(file, markdown(record("Implement tests", { assigned_to_session: "session-1" })));
	await watch.refresh();
	assert.equal(events.at(-1)?.items[0]?.assignedToSession, "session-1");
	await writeFile(file, "{partial");
	await watch.refresh();
	assert.equal(events.length, 3, "partial writes retain the last good state");
	await writeFile(file, markdown(record("Implement tests", { status: "closed" })));
	await watch.refresh();
	assert.equal(events.at(-1)?.items[0]?.status, "closed");
	assert.equal(events.at(-1)?.items[0]?.assignedToSession, undefined);
	stop();
	await rm(file);
	const reconnected: TodosUpdateEvent[] = [];
	const stopAgain = watch.subscribe((event) => reconnected.push(event));
	t.after(stopAgain);
	await watch.refresh();
	assert.deepEqual(reconnected.at(-1), { type: "todos_update", items: [] });
});

test("TODO polling runs only while subscribed and detects files during long tool calls", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-todos-poll-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const watch = new TodosWatch(directory, 10);
	const events: TodosUpdateEvent[] = [];
	const stop = watch.subscribe((event) => events.push(event));
	t.after(stop);
	assert.equal(typeof stop, "function", "subscription does not await display-only filesystem I/O");
	await writeFile(join(directory, "deadbeef.md"), markdown(record()));
	const deadline = Date.now() + 2_000;
	while (events.length < 2 && Date.now() < deadline) await sleep(10);
	assert.equal(events.at(-1)?.items[0]?.title, "Add tests");
	stop();
	await writeFile(join(directory, "deadbeef.md"), markdown(record("Changed after stop")));
	await sleep(40);
	assert.equal(events.length, 2);
});

test("TODO cached snapshots stay sorted and defensive across getters and listener deliveries", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-todos-snapshot-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "deadbeef.md"), markdown(record("later", { created_at: "2026-07-02" })));
	await writeFile(join(directory, "aabbccdd.md"), markdown(record("earlier", { created_at: "2026-07-01" })));
	const watch = new TodosWatch(directory);
	await watch.refresh();
	const mutated = watch.current;
	mutated.items[0].title = "mutated";
	mutated.items.reverse();
	const expected = ["earlier", "later"];
	assert.deepEqual(
		watch.current.items.map((todo) => todo.title),
		expected,
	);
	const offFirst = watch.subscribe((event) => {
		event.items[0].title = "listener mutation";
		event.items.reverse();
	});
	t.after(offFirst);
	const received: TodosUpdateEvent[] = [];
	const offSecond = watch.subscribe((event) => received.push(event));
	t.after(offSecond);
	await watch.refresh();
	assert.equal(received.length, 1, "unchanged polls compare the stable cached representation");
	assert.deepEqual(
		received[0].items.map((todo) => todo.title),
		expected,
	);
	await writeFile(join(directory, "deadbeef.md"), markdown(record("updated", { created_at: "2026-07-02" })));
	await watch.refresh();
	assert.equal(received.length, 2);
	assert.deepEqual(
		received[1].items.map((todo) => todo.title),
		["earlier", "updated"],
	);
	assert.deepEqual(
		watch.current.items.map((todo) => todo.title),
		["earlier", "updated"],
	);
});

test("TODO polls cache unchanged metadata, read bounded headers, and retry invalid writes", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-todos-cache-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const fs = { open, readdir, stat };
	let bytes = 0;
	const opened = t.mock.method(
		fs,
		"open",
		async (path: Parameters<typeof open>[0], flags: Parameters<typeof open>[1]) => {
			const handle = await open(path, flags);
			const read = t.mock.method(handle, "read");
			const close = handle.close.bind(handle);
			t.mock.method(handle, "close", async () => {
				for (const call of read.mock.calls) {
					const args: readonly unknown[] = call.arguments;
					bytes += Number(args[2]);
				}
				await close();
			});
			return handle;
		},
	);
	const watch = new TodosWatch(directory, 1_000, fs);
	const file = join(directory, "deadbeef.md");
	await writeFile(file, `${markdown(record("first"))}${"large body\n".repeat(100_000)}`);
	await watch.refresh();
	assert.equal(watch.current.items[0]?.title, "first");
	assert.equal(bytes, 4096, "a huge markdown body is not read in full");
	await watch.refresh();
	assert.equal(opened.mock.callCount(), 1, "unchanged polls stat files without opening them");
	await writeFile(join(directory, "replacement"), markdown(record("other")));
	await rename(join(directory, "replacement"), file);
	await watch.refresh();
	assert.equal(watch.current.items[0]?.title, "other", "atomic replacement invalidates metadata");
	await writeFile(file, `{${" ".repeat(200_000)}`);
	const before = bytes;
	await watch.refresh();
	assert.equal(bytes - before, 64 * 1024, "a malformed/oversized header has a hard read budget");
	assert.equal(watch.current.items[0]?.title, "other", "retain the last good TODO");
	const count = opened.mock.callCount();
	await watch.refresh();
	assert.equal(opened.mock.callCount(), count + 1, "invalid headers are retried, not cached");
	await writeFile(file, markdown(record("recovered")));
	await watch.refresh();
	assert.equal(watch.current.items[0]?.title, "recovered");
	await rm(file);
	await watch.refresh();
	assert.equal(watch.current.items.length, 0);
	await writeFile(file, markdown(record("recreated")));
	await watch.refresh();
	assert.equal(watch.current.items[0]?.title, "recreated");
});

test("TODO polling bounds concurrent file work and coalesces refresh requests", { timeout: 5_000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-todos-concurrency-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (let id = 0; id < 20; id++)
		await writeFile(join(directory, `${id.toString(16).padStart(8, "0")}.md`), markdown(record()));
	const fs = { open, readdir, stat };
	let active = 0;
	let maximum = 0;
	let unblock!: () => void;
	const blocked = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	t.after(unblock);
	let filled!: () => void;
	const ready = new Promise<void>((resolve) => {
		filled = resolve;
	});
	t.mock.method(fs, "open", async (path: Parameters<typeof open>[0], flags: Parameters<typeof open>[1]) => {
		const handle = await open(path, flags);
		active++;
		maximum = Math.max(maximum, active);
		const close = handle.close.bind(handle);
		t.mock.method(handle, "close", async () => {
			await close();
			active--;
		});
		if (active === 4) filled();
		await blocked;
		return handle;
	});
	const watch = new TodosWatch(directory, 1_000, fs);
	const refreshing = watch.refresh();
	assert.equal(watch.refresh(), refreshing);
	await ready;
	assert.equal(active, 4);
	unblock();
	await refreshing;
	assert.equal(maximum, 4);
	assert.equal(active, 0, "every header handle closes");
	assert.equal(watch.current.items.length, 20);
});

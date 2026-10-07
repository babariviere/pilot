import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

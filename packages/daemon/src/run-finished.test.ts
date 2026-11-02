// biome-ignore-all lint/complexity/useLiteralKeys: Offline run boundary seams.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { type RunFinished, runChangedFiles, runSnapshot } from "./run-finished.ts";
import type { SessionWorker } from "./sessions.ts";
import { fixture, until } from "./testing/session-workspace.ts";

test("snapshots compare each run, including untracked files, without reusing the chat's accumulated diff", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const start = await runSnapshot(chat.cwd, true);
	await writeFile(join(chat.cwd, "tracked.txt"), "first run\n");
	await writeFile(join(chat.cwd, "new\nfile.txt"), "new\n");
	await writeFile(join(chat.cwd, "ignored-secret"), "not input\n");
	assert.deepEqual(await runChangedFiles(chat.cwd, true, start), ["new\nfile.txt", "tracked.txt"]);
	const next = await runSnapshot(chat.cwd, true);
	assert.deepEqual(await runChangedFiles(chat.cwd, true, next), []);
	await writeFile(join(chat.cwd, "tracked.txt"), "second run\n");
	assert.deepEqual(await runChangedFiles(chat.cwd, true, next), ["tracked.txt"]);
	await f.assertSourceUnchanged();
});

test("run completion waits for jobs, queues and pause gates; retains one durable event", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	const chat = await f.spawn();
	const meta = f.sessions["metas"].get(chat.id)!;
	const worker = f.workers.at(-1)!;
	const events: RunFinished[] = [];
	f.sessions.onRunFinished((_id, event) => events.push(event));
	meta.automation!.boundary = { id: "run", baseline: await runSnapshot(chat.cwd, true) };
	await writeFile(join(chat.cwd, "tracked.txt"), "changed\n");
	worker.state = "idle";
	(worker as SessionWorker).openTodoCount = 2;
	meta.working = false;
	meta.outcome = "done";
	meta.outcomeAt = 123;
	(worker as SessionWorker).runningJobs = [
		{ id: "job", name: "background", state: "running", outputPath: "/unused", startedAt: 1 },
	];
	f.sessions["emit"](meta);
	assert.equal(f.sessions["runFinishing"].size, 0);
	(worker as SessionWorker).runningJobs = [];
	meta.pending = [{ type: "input", requestId: "user", content: "wait", mode: "steer" }];
	f.sessions["emit"](meta);
	assert.equal(f.sessions["runFinishing"].size, 0);
	meta.pending = [];
	meta.sleepPaused = true;
	f.sessions["emit"](meta);
	assert.equal(f.sessions["runFinishing"].size, 0);
	delete meta.sleepPaused;
	meta.updatePaused = true;
	f.sessions["emit"](meta);
	assert.equal(f.sessions["runFinishing"].size, 0);
	delete meta.updatePaused;
	f.sessions["emit"](meta);
	await until(() => events.length === 1);
	assert.deepEqual(events[0], {
		triggerId: "run.finished:123",
		outcome: "done",
		changedFiles: ["tracked.txt"],
		openTodos: 2,
	});
	assert.deepEqual((await f.stored(chat.id)).automation?.boundary?.finished, events[0]);
	f.sessions["emit"](meta);
	assert.equal(events.length, 1);
});

test("Git-only snapshots preserve the real index and bound large path lists", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const baseline = await runSnapshot(chat.cwd, false);
	await Promise.all(Array.from({ length: 1001 }, (_, n) => writeFile(join(chat.cwd, `new-${n}.txt`), "new")));
	assert.equal(await runChangedFiles(chat.cwd, false, baseline), "many");
	assert.deepEqual(await runChangedFiles(chat.cwd, false, await runSnapshot(chat.cwd, false)), []);
	await f.assertSourceUnchanged();
});

test("disabled admission never captures a boundary", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	assert.equal((await f.stored(chat.id)).automation?.boundary, undefined);
});

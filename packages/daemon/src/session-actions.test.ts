// biome-ignore-all lint/complexity/useLiteralKeys: Exercise durable registry and lifecycle seams.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Automation } from "@pilot/protocol";
import { ActionRunner } from "./automation-runner.ts";
import { SubprocessPool } from "./subprocess.ts";
import { deferred, fixture } from "./testing/session-workspace.ts";

const hook: Automation = {
	id: "setup",
	name: "Setup",
	enabled: true,
	on: ["workspace.created"],
	action: { type: "shell", run: { shell: "printf 'API_KEY=secret\\n'; printf done" } },
};

test("workspace commands persist bounded redacted records and logs without a model turn", async (t) => {
	const pool = new SubprocessPool();
	t.after(() => pool.close());
	const f = await fixture(t, { automationsEnabled: () => true, actionRunner: new ActionRunner(pool) });
	const chat = await f.spawn();
	const inputs = f.workers.flatMap((worker) => worker.requests).filter((request) => request.type === "input").length;
	const result = await f.sessions.runWorkspaceAction(chat.id, hook, "workspace.created", "workspace.created", 3);
	assert.equal(result.outcome, "ok");
	const record = (await f.stored(chat.id)).automation?.runs[0];
	assert.equal(record?.definitionRevision, 3);
	assert.equal(record?.state, "ok");
	assert.equal(record?.attempt, 1);
	assert.match(record!.excerpt, /REDACTED/);
	assert.doesNotMatch(record!.excerpt, /secret/);
	const logs = await readdir(join(f.home, "sessions", chat.id, "automation-logs"));
	assert.equal(logs.length, 1);
	assert.doesNotMatch(
		await readFile(join(f.home, "sessions", chat.id, "automation-logs", logs[0]!), "utf8"),
		/secret/,
	);
	assert.deepEqual(f.sessions.get(chat.id)?.automationRuns, [record]);
	assert.equal(
		f.workers.flatMap((worker) => worker.requests).filter((request) => request.type === "input").length,
		inputs,
	);
	await f.sessions.shutdown();
	const reopened = await f.manager({ automationsEnabled: () => true, actionRunner: new ActionRunner(pool) });
	assert.equal(reopened.get(chat.id)?.automationRuns?.[0]?.state, "ok");
});

test("Stop and archive cancel workspace commands and keep them working until the process settles", async (t) => {
	const pool = new SubprocessPool();
	const running = deferred();
	const finish = deferred();
	const spawned = t.mock.method(
		pool,
		"run",
		async (_file: string, _args: string[], options: Parameters<SubprocessPool["run"]>[2]) => {
			running.resolve();
			await new Promise<void>((resolve) =>
				options.signal!.addEventListener("abort", () => resolve(), { once: true }),
			);
			await finish.promise;
			return {
				code: null,
				signal: "SIGTERM" as const,
				stdout: Buffer.from(""),
				stderr: "",
				truncated: false,
				overflowed: false,
				timedOut: false,
				aborted: true,
			};
		},
	);
	t.after(async () => {
		finish.resolve();
		await pool.close();
	});
	const f = await fixture(t, { automationsEnabled: () => true, actionRunner: new ActionRunner(pool) });
	const chat = await f.spawn();
	const action = f.sessions.runWorkspaceAction(chat.id, hook, "workspace.created", "workspace.created", 1);
	await running.promise;
	assert.equal(f.sessions.get(chat.id)?.working, true);
	assert.equal(f.sessions.get(chat.id)?.automation?.name, "Setup");
	const stopping = f.sessions.stop(chat.id);
	assert.equal(f.sessions.get(chat.id)?.working, true, "concurrency ownership is not released on abort alone");
	finish.resolve();
	await stopping;
	assert.equal((await action).outcome, "cancelled");
	assert.equal(f.sessions.get(chat.id)?.working, false);
	await f.sessions.archive(chat.id);
	assert.equal(spawned.mock.callCount(), 1);
	await assert.rejects(f.sessions.runWorkspaceAction(chat.id, hook, "workspace.created", "new", 1), /Build workspace/);
});

test("host switch is checked live for every workspace command admission", async (t) => {
	const pool = new SubprocessPool();
	t.after(() => pool.close());
	let enabled = false;
	const f = await fixture(t, { automationsEnabled: () => enabled, actionRunner: new ActionRunner(pool) });
	const chat = await f.spawn();
	await assert.rejects(f.sessions.runWorkspaceAction(chat.id, hook, "workspace.created", "off", 1), /disabled/);
	enabled = true;
	assert.equal((await f.sessions.runWorkspaceAction(chat.id, hook, "workspace.created", "on", 1)).outcome, "ok");
	enabled = false;
	await assert.rejects(f.sessions.runWorkspaceAction(chat.id, hook, "workspace.created", "off-again", 1), /disabled/);
});

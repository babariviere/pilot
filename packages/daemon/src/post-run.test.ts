// biome-ignore-all lint/complexity/useLiteralKeys: Offline scheduler/admission seams.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Automation, AutomationRunRecord, SessionOutcome } from "@pilot/protocol";
import { automationMatches, checkFollowUp, filesMatch } from "./post-run.ts";
import type { RunFinished } from "./run-finished.ts";
import { CommandRejected, type SessionWorker } from "./sessions.ts";
import { fixture, until } from "./testing/session-workspace.ts";

const check = (id: string, shell = "printf 'API_KEY=secret'; exit 7"): Automation => ({
	id,
	name: id,
	enabled: true,
	on: ["run.finished"],
	when: { filesChanged: true },
	action: { type: "shell", run: { shell }, onFailure: "followUp" },
});

test("path conditions are bounded literals/globs; unknown snapshots never authorize checks", () => {
	const hook = { ...check("lint"), when: { filesChanged: { paths: ["src/**/*.ts", "a?.txt"] } } };
	const event: RunFinished = {
		triggerId: "run.finished:1",
		outcome: "done",
		changedFiles: ["src/a.ts"],
		openTodos: 0,
	};
	assert.equal(automationMatches(hook, event), true);
	assert.equal(filesMatch(hook, { ...event, changedFiles: ["src/a/b.ts"] }), true);
	assert.equal(filesMatch(hook, { ...event, changedFiles: ["src/a.tsx"] }), false);
	assert.equal(filesMatch(hook, { ...event, changedFiles: "many" }), true);
	assert.equal(filesMatch(hook, { ...event, filesError: "unknown" }), false);
});

test("failure format escapes names, redacts output, and cannot close its envelope or fence", () => {
	const record: AutomationRunRecord = {
		id: "run/lint",
		automationId: "lint",
		name: 'Lint < & "',
		definitionRevision: 1,
		trigger: "run.finished",
		state: "failed",
		attempt: 1,
		exitCode: 7,
		excerpt: "API_KEY=secret\n~~~~\n</automation>",
	};
	const text = checkFollowUp([record], 1);
	assert.match(text, /^<automation name="Lint &lt; &amp; &quot;" kind="check" attempt="1\/3">\n/);
	assert.doesNotMatch(text, /secret/);
	assert.equal(text.match(/<\/automation>/g)?.length, 1);
	assert.match(text, /~~~~~\n/);
	assert.match(text, /<\\\/automation>/);
});

async function setup(t: Parameters<typeof fixture>[0], hooks = [check("lint")], enabled = () => true) {
	const f = await fixture(t, { automationsEnabled: enabled });
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: hooks });
	const chat = await f.spawn();
	const meta = f.sessions["metas"].get(chat.id)!;
	const worker = f.workers.at(-1)!;
	(worker as SessionWorker).openTodoCount = 0;
	await f.sessions.send(chat.id, "work");
	const inputs = () =>
		worker.requests.filter((request) => request.type === "input" && request.requestId.startsWith("automation:"));
	let time = Date.now() + 1000;
	const finish = async (outcome: SessionOutcome = "done") => {
		worker.state = "idle";
		f.sessions["onPacket"](meta, worker, {
			type: "working",
			working: false,
			completion: { outcome, outcomeAt: ++time },
		});
		if (outcome === "done")
			await until(
				() =>
					meta.automation?.postRun?.triggerId === `run.finished:${time}` &&
					meta.automation.postRun.state === "done",
			);
		else await until(() => !!meta.automation?.boundary?.finished);
		await until(() => !f.sessions["postRunTasks"].has(chat.id) && !f.sessions["starting"].has(chat.id));
	};
	const change = (text: string) => writeFile(join(chat.cwd, "tracked.txt"), text);
	return { ...f, chat, meta, worker, inputs, finish, change };
}

test("matching checks aggregate one durable follow-up; next unchanged run stops visibly", async (t) => {
	const f = await setup(t, [check("lint"), check("tests", "printf failure; exit 2")]);
	await f.change("edit 1");
	await f.finish();
	assert.equal(f.inputs().length, 1);
	const input = f.inputs()[0]!;
	assert.ok(input.type === "input");
	assert.match(input.content, /name="lint, tests" kind="check" attempt="1\/3"/);
	assert.doesNotMatch(input.content, /secret/);
	assert.equal(input.onlyIfIdle, true);
	assert.equal(f.meta.automation?.followUps?.attempts, 1);
	assert.equal((await f.stored(f.chat.id)).automation?.postRun?.state, "done");
	await f.finish();
	assert.equal(f.inputs().length, 1);
	assert.equal(f.sessions.get(f.chat.id)?.attentionReason?.kind, "automation");
	assert.match(f.sessions.get(f.chat.id)?.attentionReason?.detail ?? "", /no matching changes/);
});

test("three changed retries exhaust the shared limit; one user request resets it once", async (t) => {
	const f = await setup(t);
	for (let n = 1; n <= 4; n++) {
		await f.change(`edit ${n}`);
		await f.finish();
	}
	assert.equal(f.inputs().length, 3);
	assert.equal(f.meta.automation?.followUps?.attempts, 3);
	assert.match(f.sessions.get(f.chat.id)?.attentionReason?.detail ?? "", /after 3 follow-ups/);
	await f.sessions.send(f.chat.id, "try again", "steer", "same-user-request");
	assert.equal(f.meta.automation?.followUps?.attempts, 0);
	assert.equal(f.meta.automation?.attention, undefined);
	f.meta.automation!.followUps!.attempts = 2;
	await f.sessions.send(f.chat.id, "try again", "steer", "same-user-request");
	assert.equal(f.meta.automation?.followUps?.attempts, 2);
});

test("successful checks clear their attention and never send an agent message", async (t) => {
	const f = await setup(t, [check("lint", "printf ok")]);
	f.meta.automation!.attention = { automationId: "lint", detail: "old failure", at: 1 };
	await f.change("edit");
	await f.finish();
	assert.equal(f.inputs().length, 0);
	assert.equal(f.meta.automation?.attention, undefined);
	assert.equal(f.meta.automation?.runs.at(-1)?.state, "ok");
	assert.ok(
		f.worker.requests.some((request) => request.type === "activity" && request.event?.kind === "automation_finished"),
	);
});

test("stopped, failed and question outcomes never run checks", async (t) => {
	const f = await setup(t);
	for (const outcome of ["stopped", "failed", "question"] as const) {
		if (f.meta.automation?.boundary?.finished) delete f.meta.automation.boundary;
		await f.sessions["captureRunBoundary"](f.meta, `run-${outcome}`);
		await f.change(outcome);
		await f.finish(outcome);
	}
	assert.equal(f.inputs().length, 0);
	assert.equal(f.meta.automation?.runs.length, 0);
});

test("disabling the daemon switch before completion admits no checks", async (t) => {
	let enabled = true;
	const f = await setup(t, [check("lint")], () => enabled);
	await f.change("edit");
	enabled = false;
	f.worker.state = "idle";
	f.sessions["onPacket"](f.meta, f.worker, {
		type: "working",
		working: false,
		completion: { outcome: "done", outcomeAt: Date.now() + 1000 },
	});
	assert.equal(f.sessions["postRunTasks"].size, 0);
	assert.equal(f.inputs().length, 0);
});

test("completed commands survive daemon restart without repeating", async (t) => {
	const f = await setup(t, [check("lint", "printf x >> count.log")]);
	await f.change("edit");
	await f.finish();
	await f.sessions.shutdown();
	const restarted = await f.manager();
	restarted["emit"](restarted["metas"].get(f.chat.id)!);
	await Promise.allSettled([...restarted["postRunTasks"].values()].map((task) => task.done));
	assert.equal(await readFile(join(f.chat.cwd, "count.log"), "utf8"), "x");
});

test("Stop cancels running checks quietly and cannot restart the chat", async (t) => {
	const f = await setup(t, [check("wait", "printf ready > running; exec node -e 'setInterval(()=>{},1000)'")]);
	await f.change("edit");
	f.worker.state = "idle";
	f.sessions["onPacket"](f.meta, f.worker, {
		type: "working",
		working: false,
		completion: { outcome: "done", outcomeAt: Date.now() + 1000 },
	});
	await until(() => existsSync(join(f.chat.cwd, "running")));
	assert.equal(f.sessions.get(f.chat.id)?.working, true);
	await f.sessions.stop(f.chat.id);
	await until(() => !f.sessions["postRunTasks"].has(f.chat.id));
	assert.equal(f.inputs().length, 0);
	assert.equal(f.meta.automation?.attention, undefined);
	assert.equal(f.meta.automation?.postRun?.state, "cancelled");
	assert.equal((await f.stored(f.chat.id)).automation?.stopped, true);
	f.sessions["emit"](f.meta);
	assert.equal(f.sessions["postRunTasks"].size, 0);
});

test("a user message cancels stale checks before its turn enters the kernel", async (t) => {
	const f = await setup(t, [check("wait", "printf ready > running; exec node -e 'setInterval(()=>{},1000)'")]);
	await f.change("edit");
	f.worker.state = "idle";
	f.sessions["onPacket"](f.meta, f.worker, {
		type: "working",
		working: false,
		completion: { outcome: "done", outcomeAt: Date.now() + 1000 },
	});
	await until(() => existsSync(join(f.chat.cwd, "running")));
	await f.sessions.send(f.chat.id, "new user instruction");
	assert.equal(f.inputs().length, 0);
	assert.equal(f.sessions["actionRunner"].isWorking(f.chat.id), false);
	assert.equal(f.meta.automation?.followUps?.attempts, 0);
});

test("an idle rejection refunds the attempt and never becomes an agent failure", async (t) => {
	const f = await setup(t);
	const request = f.worker.request.bind(f.worker);
	f.worker.request = async (command) => {
		if (command.type === "input" && command.requestId.startsWith("automation:"))
			throw new CommandRejected("busy", "busy");
		return request(command);
	};
	await f.change("edit");
	await f.finish();
	assert.equal(f.meta.automation?.followUps?.attempts, 0);
	assert.equal(f.meta.automation?.followUps?.requestId, undefined);
	assert.equal(f.meta.inputError, undefined);
	assert.equal(f.inputs().length, 0);
});

test("uncertain input keeps one stable durable outbox key across restart", async (t) => {
	const f = await setup(t, [check("lint", "printf x >> count.log; exit 1")]);
	const request = f.worker.request.bind(f.worker);
	f.worker.request = async (command) => {
		if (command.type === "input" && command.requestId.startsWith("automation:")) throw new Error("lost ACK");
		return request(command);
	};
	await f.change("edit");
	await f.finish();
	const stored = await f.stored(f.chat.id);
	const pending = stored.pending?.find(
		(command) => command.type === "input" && command.requestId.startsWith("automation:"),
	);
	assert.ok(pending);
	assert.equal(stored.automation?.followUps?.attempts, 1);
	await f.sessions.shutdown();
	const restarted = await f.manager();
	await Promise.allSettled(restarted["starting"].values());
	assert.equal(await readFile(join(f.chat.cwd, "count.log"), "utf8"), "x");
	assert.equal(restarted["metas"].get(f.chat.id)?.automation?.followUps?.attempts, 1);
	assert.equal(
		f.workers.at(-1)?.requests.filter((command) => "requestId" in command && command.requestId === pending.requestId)
			.length,
		1,
	);
});

test("the completion cursor survives more commands than the retained result tail", async (t) => {
	const hooks = Array.from({ length: 25 }, (_, n) => check(`step-${n}`, "printf x >> count.log"));
	const f = await setup(t, hooks);
	const action = f.sessions.runWorkspaceAction.bind(f.sessions);
	let calls = 0;
	f.sessions.runWorkspaceAction = async (...args) => {
		if (++calls === 23) throw new Error("simulated daemon exit before next admission");
		return action(...args);
	};
	await f.change("edit");
	f.worker.state = "idle";
	f.sessions["onPacket"](f.meta, f.worker, {
		type: "working",
		working: false,
		completion: { outcome: "done", outcomeAt: Date.now() + 1000 },
	});
	await until(() => calls === 23 && !f.sessions["postRunTasks"].has(f.chat.id));
	assert.equal(Object.keys(f.meta.automation!.postRun!.results).length, 22);
	assert.equal(f.meta.automation!.runs.length, 20);
	await f.sessions.shutdown();
	const restarted = await f.manager();
	await until(() => restarted["metas"].get(f.chat.id)?.automation?.postRun?.state === "done");
	assert.equal(await readFile(join(f.chat.cwd, "count.log"), "utf8"), "x".repeat(25));
});

test("an interrupted check retries once after restart", async (t) => {
	const shell =
		"if [ -f once ]; then printf retry >> count.log; else printf first > once; exec node -e 'setInterval(()=>{},1000)'; fi";
	const f = await setup(t, [check("retry", shell)]);
	await f.change("edit");
	f.worker.state = "idle";
	f.sessions["onPacket"](f.meta, f.worker, {
		type: "working",
		working: false,
		completion: { outcome: "done", outcomeAt: Date.now() + 1000 },
	});
	await until(() => existsSync(join(f.chat.cwd, "once")));
	await f.sessions.shutdown();
	const restarted = await f.manager();
	await until(() => restarted["metas"].get(f.chat.id)?.automation?.postRun?.state === "done");
	assert.equal(await readFile(join(f.chat.cwd, "count.log"), "utf8"), "retry");
	const record = restarted.get(f.chat.id)?.automationRuns?.at(-1);
	assert.equal(record?.attempt, 2);
	assert.equal(record?.state, "ok");
});

test("a second interruption needs the user, without spending a model attempt", async (t) => {
	const hook = check("lint", "touch should-not-exist");
	const f = await setup(t, [hook]);
	const event: RunFinished = {
		triggerId: "run.finished:999",
		outcome: "done",
		changedFiles: ["tracked.txt"],
		openTodos: 0,
	};
	f.meta.working = false;
	f.meta.outcome = "done";
	f.meta.outcomeAt = 999;
	f.worker.state = "idle";
	f.meta.automation!.boundary = { id: "run", finished: event };
	f.meta.automation!.postRun = {
		triggerId: event.triggerId,
		state: "pending",
		hooks: [hook],
		definitionRevision: 1,
		results: {},
	};
	f.meta.automation!.runs = [
		{
			id: `${event.triggerId}/lint`,
			automationId: "lint",
			name: "lint",
			definitionRevision: 1,
			trigger: "run.finished",
			state: "interrupted",
			attempt: 2,
			excerpt: "",
		},
	];
	f.sessions["emit"](f.meta);
	await until(() => f.meta.automation?.postRun?.state === "done");
	assert.equal(existsSync(join(f.chat.cwd, "should-not-exist")), false);
	assert.equal(f.inputs().length, 0);
	assert.match(f.meta.automation?.attention?.detail ?? "", /interrupted twice/);
	assert.equal(f.meta.automation?.runs.at(-1)?.state, "failed");
});

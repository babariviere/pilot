// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry lifecycle seams with offline workers.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand, KernelPacket, KernelSubagent } from "@pilot/kernel";
import type { SessionSummary } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";

const completion = { outcome: "done" as const, outcomeAt: 42 };
const child: KernelSubagent = {
	name: "implementation",
	state: "working",
	task: "Offline implementation",
	createdAt: 1,
	cwd: "/fixture",
	storage: "/fixture/durable/subagent-runs/implementation",
	conversationId: "9",
};

async function until(check: () => boolean | Promise<boolean>) {
	const deadline = performance.now() + 5_000;
	while (!(await check())) {
		assert.ok(performance.now() < deadline, "condition did not settle");
		await delay(1);
	}
}

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-child-activity-"));
	type FakeWorker = SessionWorker & {
		id: string;
		commands: KernelCommand[];
		closed: boolean;
		report(packet: KernelPacket): void;
		crash(): void;
	};
	const workers: FakeWorker[] = [];
	const managers: SessionManager[] = [];
	const open = async () => {
		const sessions = new SessionManager(
			home,
			new ProjectStore(home),
			undefined,
			{
				title: async () => undefined,
				worker(spec, report, exited) {
					const worker: FakeWorker = {
						id: spec.sessionId,
						state: "idle",
						busy: false,
						ready: Promise.resolve(),
						closed: false,
						commands: [],
						report(packet) {
							if (packet.type === "ready" || packet.type === "working")
								this.state = packet.working ? "working" : "idle";
							report(packet);
						},
						send(command) {
							this.commands.push(command);
							if (command.type === "update.pause") report({ type: "update.paused", id: command.id });
						},
						async request(command) {
							this.commands.push(command);
						},
						async close() {
							this.closed = true;
							exited(this, 0);
						},
						hasChildren: async () => false,
						crash() {
							exited(this, 1);
						},
					};
					workers.push(worker);
					queueMicrotask(() =>
						worker.report({
							type: "ready",
							model: "offline/model",
							working: false,
							usage: {},
							completion,
						}),
					);
					return worker;
				},
			},
			{},
			{ kernelRestartBackoffMs: 0 },
		);
		managers.push(sessions);
		await sessions.load();
		return sessions;
	};
	t.after(async () => {
		for (const manager of managers.reverse()) await manager.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	const sessions = await open();
	const created = await sessions.spawn({ cwd: home, message: "Delegate work", title: "Offline" });
	await Promise.all(sessions["starting"].values());
	const worker = workers[0]!;
	worker.report({ type: "working", working: true });
	worker.report({ type: "subagents", subagents: [child] });
	worker.report({ type: "working", working: false, completion: { ...completion, outcomeAt: 43 } });
	const stored = async () => {
		await sessions["saving"].get(created.id);
		return JSON.parse(await readFile(join(home, "sessions", created.id, "meta.json"), "utf8"));
	};
	return { home, open, sessions, created, worker, workers, stored };
}

test("an idle parent stays Working until delegated work returns, without publishing its waiting answer", async (t) => {
	const { sessions, created, worker, stored } = await fixture(t);
	assert.equal(sessions.get(created.id)?.state, "idle", "parent admission uses kernel state, not child activity");
	assert.equal(sessions.get(created.id)?.working, true);
	assert.equal(sessions.get(created.id)?.outcome, undefined);
	assert.equal((await stored()).working, false);
	assert.equal((await stored()).lastCompletionAt, 43);
	sessions["lastUse"].set(created.id, 0);
	assert.equal(
		sessions["parkable"](sessions["require"](created.id), worker),
		false,
		"pending children protect the kernel even between worker processes",
	);
	const changes: SessionSummary[] = [];
	sessions.onChange((summary) => changes.push(summary));
	// Child completion and parent result delivery are separate events. Never replay the waiting answer.
	worker.report({ type: "subagents", subagents: [{ ...child, state: "idle", lastAnswerId: "20" }] });
	worker.report({ type: "working", working: false, completion: { ...completion, outcomeAt: 43 } });
	assert.equal(sessions.get(created.id)?.outcome, undefined);
	worker.report({ type: "working", working: true });
	worker.report({ type: "working", working: false, completion: { ...completion, outcomeAt: 44 } });
	assert.equal(sessions.get(created.id)?.outcome, "done");
	assert.equal(changes.filter((summary) => summary.outcome).length, 1);
	// Old workers cannot overwrite the replacement's child state.
	const other = { ...worker };
	sessions["onPacket"](sessions["require"](created.id), other, { type: "subagents", subagents: [child] });
	assert.equal(sessions.get(created.id)?.working, false);
});

for (const kind of ["update", "shutdown", "crash", "sleep", "legacy"] as const) {
	test(`idle-parent child work recovers after ${kind}, without replaying the parent's completion`, async (t) => {
		const f = await fixture(t);
		let resumed = f.sessions;
		if (kind === "update") await until(() => f.sessions.pauseForUpdate().ready);
		if (kind === "sleep") {
			const sleeping = f.sessions.pauseForSleep("sleep:1");
			assert.equal(f.sessions.get(f.created.id)?.working, false, "the sleep latch quiets children synchronously");
			await sleeping;
			assert.equal(f.sessions.get(f.created.id)?.sleepPaused, true);
			assert.equal(f.sessions.get(f.created.id)?.working, false);
		}
		if (kind === "crash") {
			f.worker.crash();
		} else {
			await f.sessions.shutdown();
			if (kind === "legacy") {
				const meta = await f.stored();
				await writeFile(
					join(f.home, "sessions", f.created.id, "meta.json"),
					JSON.stringify({
						...meta,
						outcome: "done",
						outcomeAt: 43,
					}),
				);
			}
			resumed = await f.open();
			if (kind === "sleep") {
				assert.equal(f.workers.length, 1, "a daemon restart is not a full wake");
				await resumed.resumeAfterSleep();
			}
		}
		await until(() => f.workers.length === 2);
		await Promise.all(resumed["starting"].values());
		const next = f.workers[1]!;
		assert.equal(next.id, f.created.id);
		assert.equal(
			next.commands.some((command) => command.type === "input"),
			false,
			"child recovery must not resubmit the parent's original user input",
		);
		assert.equal(resumed.get(f.created.id)?.working, true);
		assert.equal(resumed.get(f.created.id)?.outcome, undefined);
		assert.equal(resumed["require"](f.created.id).working, false);
		next.report({ type: "subagents", subagents: [{ ...child, state: "idle", error: "Child could not recover" }] });
		next.report({ type: "working", working: true });
		next.report({ type: "working", working: false, completion: { ...completion, outcomeAt: 44 } });
		assert.equal(resumed.get(f.created.id)?.outcome, "done", "the failure-result turn may settle normally");
	});
}

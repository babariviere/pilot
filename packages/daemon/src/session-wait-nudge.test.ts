// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without forking a kernel or making them public.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KernelCommand } from "@pilot/kernel";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionMissionBridge, type SessionWorker, WAIT_NUDGE_TEXT } from "./sessions.ts";
import { offlineSessionOptions } from "./testing/offline-session-options.ts";

type Meta = Parameters<SessionManager["save"]>[0];
type Input = Extract<KernelCommand, { type: "input" }>;

/** One idle build chat whose turn ended done, with a mission bridge the test answers. */
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
	const f = await setup();
	try {
		await run(f);
	} finally {
		await f.manager.shutdown();
		await rm(f.home, { recursive: true, force: true });
	}
}

async function setup() {
	const home = await mkdtemp(join(tmpdir(), "pilot-wait-nudge-"));
	const id = randomUUID();
	const cwd = join(home, "sessions", id, "workspace");
	const initial: Meta = {
		id,
		title: "Builder",
		cwd,
		createdAt: 1,
		updatedAt: 2,
		lastUserMessageAt: 5,
		working: false,
		outcome: "done",
		outcomeAt: 10,
		lastOutcomeAt: 10,
		lastCompletionAt: 10,
	};
	await mkdir(cwd, { recursive: true });
	await writeFile(join(home, "sessions", id, "meta.json"), JSON.stringify(initial));
	const inputs: Input[] = [];
	const manager = new SessionManager(
		home,
		new ProjectStore(home),
		undefined,
		{
			title: async () => undefined,
			worker: (_spec, _onPacket, onExit) => {
				const worker: SessionWorker & { busy: boolean } = {
					ready: Promise.resolve(),
					state: "idle",
					busy: false,
					send: () => {},
					request: async (command) => {
						if (command.type === "input") inputs.push(command);
					},
					close: async () => {
						worker.state = "idle";
						onExit(worker, 0);
					},
				};
				return worker;
			},
		},
		undefined,
		offlineSessionOptions(),
	);
	await manager.load();
	const bridge = { waits: true, since: [] as number[] };
	manager.setMissionBridge({
		membership: () => undefined,
		context: () => undefined,
		waitsForReply: (sessionId: string, since: number) => {
			assert.equal(sessionId, id);
			bridge.since.push(since);
			return bridge.waits;
		},
	} as unknown as SessionMissionBridge);
	return {
		home,
		id,
		inputs,
		bridge,
		manager,
		get meta() {
			return manager["metas"].get(id)!;
		},
		settle: async () => {
			await Promise.allSettled(manager["starting"].values());
			await Promise.all(manager["saving"].values());
		},
	};
}

test("a builder whose turn ended with no result is reminded once per user input, then waits for a reply", async () => {
	await fixture(async (f) => {
		f.bridge.waits = false;
		assert.equal(await f.manager.sendWaitNudge(f.id), false, "a delivered or closed task needs no reminder");
		f.bridge.waits = true;
		assert.equal(f.manager.get(f.id)?.waitsForReply, undefined, "before the reminder it does not wait yet");
		assert.equal(await f.manager.sendWaitNudge(f.id), true);
		await f.settle();
		assert.deepEqual(
			f.inputs.map((input) => [input.requestId, input.content, input.mode]),
			[[`mission-wait:${f.id}:5`, WAIT_NUDGE_TEXT, "followUp"]],
		);
		assert.equal(f.bridge.since.at(-1), 5, "the cycle starts at the last user input");
		assert.equal(await f.manager.sendWaitNudge(f.id), false, "never twice for the same input");
		// The reminded turn ended the same way: the chat now waits for the user's reply, and Continue applies.
		f.meta.pending = [];
		const summary = f.manager.get(f.id)!;
		assert.equal(summary.waitsForReply, true);
		assert.equal(summary.canContinue, true);
		f.bridge.waits = false;
		assert.equal(f.manager.get(f.id)?.waitsForReply, undefined, "a delivery since the input ends the wait");
		f.bridge.waits = true;
		// The user's next input starts a new cycle: at most one more reminder.
		f.meta.lastUserMessageAt = 20;
		assert.equal(f.manager.get(f.id)?.waitsForReply, undefined);
		assert.equal(await f.manager.sendWaitNudge(f.id), true);
		await f.settle();
		assert.equal(f.inputs.at(-1)?.requestId, `mission-wait:${f.id}:20`);
	});
});

test("no reminder after a Stop, a question, or for Ask chats", async () => {
	await fixture(async (f) => {
		for (const change of [
			{ outcome: "stopped" as const },
			{ outcome: "question" as const },
			{ mode: "ask" as const },
		]) {
			Object.assign(f.meta, { outcome: "done", mode: undefined }, change);
			assert.equal(await f.manager.sendWaitNudge(f.id), false, JSON.stringify(change));
		}
		Object.assign(f.meta, { outcome: "done", mode: undefined, missionUserStopGeneration: 1 });
		assert.notEqual(await f.manager.sendWaitNudge(f.id), true, "the user's Stop hold");
		assert.equal(f.manager.get(f.id)?.waitsForReply, undefined);
		assert.deepEqual(f.inputs, []);
	});
});

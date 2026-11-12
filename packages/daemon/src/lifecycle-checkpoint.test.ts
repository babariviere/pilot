import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelCommand } from "@pilot/kernel";
import {
	type LifecycleCheckpoint,
	type LifecycleRuntime,
	type MissionResumeFence,
	matchingRuntime,
	validLifecycleRuntime,
} from "./lifecycle-checkpoint.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

const target: LifecycleRuntime = {
	runtimeRoot: "/immutable/candidate/runtime",
	build: {
		schema: 1,
		source: "a".repeat(40),
		protocol: 1,
		platform: "darwin",
		arch: "arm64",
		node: "24.21.0",
		version: "1.2.0",
	},
};

function checkpoint(changes: Partial<LifecycleCheckpoint> = {}): LifecycleCheckpoint {
	return {
		schema: 1,
		operationId: randomUUID(),
		incarnation: "prior-boot:1",
		originBoot: "prior-boot",
		host: { daemonId: "daemon", lineageId: "lineage" },
		purpose: "daemon-upgrade",
		sessionCreatedAt: 1,
		inputGeneration: 4,
		inputControlRevision: 2,
		prior: { working: true, updatePaused: false, sleepPaused: false, inputsPaused: false, subscriptionPaused: false },
		children: [{ name: "review", storage: "/private/child", conversationId: "8", state: "working" }],
		phase: "checkpointed",
		childrenConfirmed: true,
		quiescent: true,
		replacement: target,
		...changes,
	};
}

async function fixture(
	t: TestContext,
	records: { checkpoint: LifecycleCheckpoint; meta?: Record<string, unknown> }[],
	options: {
		runtime?: LifecycleRuntime;
		boot?: string;
		failReady?: boolean;
		sleeping?: boolean;
		mission?: () => MissionResumeFence | null;
		beforeLoad?: (sessions: SessionManager) => void;
	} = {},
) {
	const home = await mkdtemp(join(tmpdir(), "pilot-checkpoint-owner-"));
	if (options.sleeping) await writeFile(join(home, "power-pause.json"), JSON.stringify({ since: Date.now() }));
	const ids = records.map(() => randomUUID());
	for (const [index, record] of records.entries()) {
		const directory = join(home, "sessions", ids[index]!);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, "meta.json"),
			JSON.stringify({
				id: ids[index],
				cwd: home,
				title: "Synthetic",
				createdAt: 1,
				updatedAt: 1,
				working: true,
				updatePaused: true,
				inputGeneration: 4,
				inputControlRevision: 2,
				lifecycleCheckpoint: record.checkpoint,
				...record.meta,
			}),
		);
	}
	const opened: { id: string; stopOnOpen?: boolean }[] = [];
	const commands: KernelCommand[] = [];
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		title: async () => undefined,
		worker: (spec) => {
			opened.push({ id: spec.sessionId, stopOnOpen: spec.stopOnOpen });
			const ready = options.failReady ? Promise.reject(new Error("ready ACK lost")) : Promise.resolve();
			void ready.catch(() => undefined);
			return {
				ready,
				state: "idle",
				busy: false,
				send: (command) => {
					commands.push(command);
				},
				request: async (command) => {
					commands.push(command);
				},
				close: async () => {},
				jobs: async () => [],
				hasChildren: async () => false,
			};
		},
	});
	sessions.bindLifecycleRuntime({
		boot: options.boot ?? "new-boot",
		host: { daemonId: "daemon", lineageId: "lineage" },
		...(options.runtime ?? target),
	});
	if (options.mission)
		sessions.setMissionBridge({
			upgradeResumeFence: options.mission,
			membership: () => ({ missionId: "mission", active: true }),
			context: () => undefined,
			spawnProject: () => {
				throw new Error("unused spawn");
			},
			joinSpawn() {},
			call: async () => {
				throw new Error("unused call");
			},
		});
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	options.beforeLoad?.(sessions);
	await sessions.load();
	const internal = sessions as unknown as { starting: Map<string, Promise<unknown>> };
	await Promise.all([...internal.starting.values()]);
	return {
		sessions,
		ids,
		opened,
		commands,
		settle: () => Promise.all([...internal.starting.values()]),
		meta: async (index = 0) => JSON.parse(await readFile(join(home, "sessions", ids[index]!, "meta.json"), "utf8")),
	};
}

test("restart resumes only matching checkpoint-owned work, without a new input", async (t) => {
	const f = await fixture(t, [
		{ checkpoint: checkpoint() },
		{ checkpoint: checkpoint(), meta: { inputGeneration: 5 } },
		{ checkpoint: checkpoint(), meta: { inputControlRevision: 3 } },
		{ checkpoint: checkpoint(), meta: { inputsPaused: true } },
		{ checkpoint: checkpoint(), meta: { archivedAt: 2 } },
		{ checkpoint: checkpoint({ phase: "unknown" }) },
		{ checkpoint: checkpoint({ phase: "checkpointing" }) },
		{ checkpoint: checkpoint({ phase: "resume-admitted" }) },
		{ checkpoint: checkpoint({ host: { daemonId: "daemon", lineageId: "another-lineage" } }) },
	]);
	assert.deepEqual(
		f.opened.map(({ id }) => id),
		[f.ids[0]],
	);
	assert.equal((await f.meta()).lifecycleCheckpoint.phase, "resume-acknowledged");
	assert.equal(
		f.commands.some((command) => command.type === "input"),
		false,
	);
	assert.equal((await f.meta(7)).lifecycleCheckpoint.phase, "resume-admitted", "lost resume ACK is not replayed");
	await assert.rejects(f.sessions.send(f.ids[5]!, "not a recovery permission"), /unknown/);
});

test("interrupted replacement cannot resume under another native runtime identity", async (t) => {
	const f = await fixture(t, [{ checkpoint: checkpoint() }], {
		runtime: { ...target, runtimeRoot: "/immutable/old/runtime" },
	});
	assert.deepEqual(f.opened, []);
	assert.equal((await f.meta()).lifecycleCheckpoint.phase, "checkpointed");
});

test("same original boot may recover cancelled replacement without pretending it updated", async (t) => {
	const f = await fixture(t, [{ checkpoint: checkpoint() }], {
		boot: "prior-boot",
		runtime: { ...target, runtimeRoot: "/immutable/old/runtime" },
	});
	assert.equal(f.opened.length, 1);
	assert.equal((await f.meta()).lifecycleCheckpoint.phase, "resume-acknowledged");
});

test("parked Stop opens with its cancellation fence, not a resumed model", async (t) => {
	const f = await fixture(t, [
		{
			checkpoint: checkpoint({ phase: "stopped" }),
			meta: { inputGeneration: 5, pending: [{ type: "abort", requestId: "parked-stop" }] },
		},
	]);
	assert.equal(f.opened.length, 1);
	assert.equal(f.opened[0]!.stopOnOpen, true);
	assert.deepEqual(
		f.commands.filter((command) => command.type === "abort"),
		[{ type: "abort", requestId: "parked-stop" }],
	);
	assert.equal(
		f.commands.some((command) => command.type === "input" || command.type === "update.resume"),
		false,
	);
});

test("an interrupted Stop intent cannot be cleared by fresh input before its abort ACK", async (t) => {
	const f = await fixture(t, [{ checkpoint: checkpoint({ phase: "stopped" }), meta: { inputGeneration: 5 } }]);
	assert.equal(f.opened.length, 0);
	await assert.rejects(f.sessions.send(f.ids[0]!, "must not revive the interrupted run"), /Stop cancellation/);
	await f.sessions.stop(f.ids[0]!);
	await f.settle();
	assert.equal((await f.meta()).lifecycleCheckpoint.stopAcknowledged, true);
	assert.equal(f.opened[0]?.stopOnOpen, true);
	await f.sessions.send(f.ids[0]!, "fresh work after known cancellation");
	assert.equal(f.commands.filter((command) => command.type === "input").length, 1);
});

test("resume admission is not ready ACK and cannot replay after ready failure", async (t) => {
	const f = await fixture(t, [{ checkpoint: checkpoint() }], { failReady: true });
	assert.equal(f.opened.length, 1);
	assert.equal((await f.meta()).lifecycleCheckpoint.phase, "unknown");
	await f.sessions.resumeMaintenance();
	assert.equal(f.opened.length, 1);
});

test("a preexisting quota hold keeps upgrade recovery parked", async (t) => {
	const f = await fixture(t, [
		{
			checkpoint: checkpoint({ prior: { ...checkpoint().prior, subscriptionPaused: true } }),
			meta: {
				model: "anthropic/test",
				subscriptionPolicy: {
					version: 1,
					windows: [
						{
							provider: "anthropic",
							label: "Usage limit",
							usedPercent: 100,
							resetsAt: new Date(Date.now() + 60_000).toISOString(),
						},
					],
				},
			},
		},
	]);
	assert.equal(f.opened.length, 0);
	await f.sessions.forceSubscription(f.ids[0]!, true);
	await f.settle();
	assert.equal(f.opened.length, 1, "explicit Force releases only the quota hold");
});

test("upgrade release cannot thaw sleep; a later wake may resume its matching checkpoint", async (t) => {
	const f = await fixture(t, [{ checkpoint: checkpoint() }], { sleeping: true });
	await f.sessions.resumeMaintenance();
	assert.equal(f.opened.length, 0);
	await f.sessions.resumeAfterSleep();
	await f.settle();
	assert.equal(f.opened.length, 1);
});

for (const prior of ["updatePaused", "sleepPaused", "inputsPaused", "subscriptionPaused"] as const) {
	test(`app-update recovery preserves preexisting ${prior} even after current flags change`, async (t) => {
		const record = checkpoint({ purpose: "app-update" });
		record.prior[prior] = true;
		const f = await fixture(t, [{ checkpoint: record }]);
		assert.equal(f.opened.length, 0);
		assert.equal((await f.meta()).lifecycleCheckpoint.phase, "checkpointed");
	});
}

test("host-confirmed root exit never replays interrupted/Unknown app work on reopen", async (t) => {
	const f = await fixture(t, [
		{
			checkpoint: checkpoint({
				purpose: "app-update",
				phase: "unknown",
				interrupted: true,
				hostExited: true,
				quiescent: undefined,
			}),
		},
	]);
	assert.equal(f.opened.length, 0);
	assert.equal((await f.meta()).lifecycleCheckpoint.interrupted, true);
});

test("replacement identity is exact, structural and independent of JSON key order", () => {
	assert.equal(validLifecycleRuntime(target), true);
	assert.equal(validLifecycleRuntime({ ...target, runtimeRoot: "/retained/../candidate" }), false);
	assert.equal(validLifecycleRuntime({ ...target, build: { ...target.build, extra: true } }), false);
	assert.equal(matchingRuntime(target, { ...target, build: { ...target.build, source: "b".repeat(40) } }), false);
	assert.equal(matchingRuntime(target, JSON.parse(JSON.stringify(target))), true);
});

const missionFence: MissionResumeFence = { missionId: "mission", pauseGeneration: 2, stopGeneration: 1, held: false };
test("restart keeps mission checkpoints parked until explicit same-operation Resume", async (t) => {
	const held = { ...missionFence, held: true },
		saved = checkpoint({ purpose: "mission-pause", mission: held });
	const f = await fixture(t, [{ checkpoint: saved }], { mission: () => held });
	assert.equal(f.opened.length, 0);
	await f.sessions.resumeMaintenance();
	assert.equal(f.opened.length, 0);
	await assert.rejects(f.sessions.resumeMission(f.ids[0]!, randomUUID(), held), /ownership/);
	assert.equal(await f.sessions.resumeMission(f.ids[0]!, saved.operationId, held), "resumed");
	assert.equal(f.opened.length, 1);
	assert.equal(f.commands.filter((command) => command.type === "input").length, 0);
});

test("restart never replays an entered or Unknown mission checkpoint", async (t) => {
	const held = { ...missionFence, held: true };
	for (const phase of ["checkpointing", "resume-admitted", "unknown"] as const) {
		const saved = checkpoint({ purpose: "mission-pause", mission: held, phase });
		const f = await fixture(t, [{ checkpoint: saved }], { mission: () => held });
		assert.equal(f.opened.length, 0);
		await assert.rejects(f.sessions.resumeMission(f.ids[0]!, saved.operationId, held), /ownership/);
		assert.equal(f.opened.length, 0);
	}
});
for (const [name, current, expected] of [
	["unchanged", missionFence, 1],
	["later Pause", { ...missionFence, pauseGeneration: 3, held: true }, 0],
	["Pause then Resume", { ...missionFence, pauseGeneration: 3 }, 0],
	["later mission Stop", { ...missionFence, stopGeneration: 2 }, 0],
	["held without generation change", { ...missionFence, held: true }, 0],
	["moved membership", { ...missionFence, missionId: "other" }, 0],
	["removed membership", null, 0],
] as const) {
	test(`upgrade recovery respects mission controls: ${name}`, async (t) => {
		const f = await fixture(t, [{ checkpoint: checkpoint({ mission: missionFence }) }], { mission: () => current });
		assert.equal(f.opened.length, expected);
	});
}

test("unavailable mission controls cannot recover a previously pinned mission checkpoint", async (t) => {
	const f = await fixture(t, [{ checkpoint: checkpoint({ mission: missionFence }) }], {
		mission: () => {
			throw new Error("mission state unavailable");
		},
	});
	assert.equal(f.opened.length, 0);
	const missing = await fixture(t, [{ checkpoint: checkpoint({ mission: missionFence }) }]);
	assert.equal(missing.opened.length, 0);
});

test("installing mission controls does not invent a missing historical upgrade generation", async (t) => {
	const f = await fixture(t, [{ checkpoint: checkpoint() }], { mission: () => missionFence });
	assert.equal(f.opened.length, 0);
});

test("a mission Pause during durable resume admission vetoes worker creation", async (t) => {
	let current = missionFence;
	const f = await fixture(t, [{ checkpoint: checkpoint({ mission: missionFence }) }], {
		mission: () => current,
		beforeLoad(sessions) {
			const internal = sessions as unknown as { save(meta: unknown, ...args: unknown[]): Promise<void> };
			const save = internal.save;
			t.mock.method(internal, "save", async (meta: unknown, ...args: unknown[]) => {
				await save.call(sessions, meta, ...args);
				if ((meta as { lifecycleCheckpoint?: { phase: string } }).lifecycleCheckpoint?.phase === "resume-admitted")
					current = { ...missionFence, pauseGeneration: 3, held: true };
			});
		},
	});
	assert.equal(f.opened.length, 0);
	assert.equal((await f.meta()).lifecycleCheckpoint.phase, "checkpointed");
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PILOT_PROFILE_PATH } from "@babariviere/pi-extensions/profile";
import { createJiti } from "jiti";

interface Connection {
	ready: Promise<{ conversationId: string; working: boolean }>;
	input(): Promise<{ conversationId: string; working: boolean }>;
	status(): Promise<{ conversationId: string; working: boolean }>;
	stop(): Promise<{ conversationId: string; working: boolean }>;
	pause(): Promise<void>;
	cancel(): Promise<void>;
	quiesce(): Promise<void>;
	checkpoint(): Promise<void>;
	resumeTools(): void;
}
interface Supervisor {
	spawn(name: string, message: string, id: string, policy: object): Promise<unknown>;
	quiesce(): Promise<void>;
	checkpoint(): Promise<void>;
	resumeTools(): Promise<void>;
	close(): Promise<void>;
}

test("subagent checkpoint joins peers before resume and retains failed proof until recovery", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-subagent-checkpoint-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	let owner: Supervisor | undefined;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	t.after(async () => {
		release();
		await owner?.close();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	});
	const source = fileURLToPath(
		new URL("../extensions/subagents/durable-supervisor.ts", pathToFileURL(PILOT_PROFILE_PATH)),
	);
	const { DurableSupervisor } = await createJiti(import.meta.url).import<{
		DurableSupervisor: {
			open(
				ref: object,
				factory: (spec: { name: string }, callbacks: { exit(): void }) => Connection,
			): Promise<Supervisor>;
		};
	}>(source);
	let resumes = 0;
	let checkpoints = 0;
	let entered!: () => void;
	const inspecting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	owner = await DurableSupervisor.open(
		{ cwd: directory, sessionId: "parent", sessionFile: join(directory, "parent.jsonl") },
		(spec, callbacks) => {
			const status = { conversationId: spec.name, working: true };
			return {
				ready: Promise.resolve(status),
				input: async () => status,
				status: async () => status,
				stop: async () => status,
				quiesce: async () => {},
				pause: async () => {
					callbacks.exit();
				},
				cancel: async () => {
					callbacks.exit();
				},
				checkpoint: async () => {
					checkpoints++;
					if (spec.name === "refusing") throw new Error("Checkpoint ACK missing");
					entered();
					await pending;
					callbacks.exit();
				},
				resumeTools: () => {
					resumes++;
				},
			};
		},
	);
	const policy = { model: "test/faux", parentProvider: "test", timeoutMs: 60_000 };
	await owner.spawn("refusing", "one", "first", policy);
	await owner.spawn("closing", "two", "second", policy);
	await assert.rejects(owner.checkpoint(), /not paused/);
	await owner.quiesce();
	const checkpoint = owner.checkpoint();
	assert.equal(owner.checkpoint(), checkpoint, "concurrent inspections share one checkpoint");
	const rejected = assert.rejects(checkpoint, /ACK missing/);
	await inspecting;
	let completed = false;
	const resumed = owner.resumeTools().then(() => {
		completed = true;
	});
	await Promise.resolve();
	assert.equal(completed, false, "failed peer cannot thaw a still-closing checkpoint");
	assert.equal(resumes, 0);
	await owner.quiesce(); // A newer pause supersedes the pending cancellation resume.
	release();
	await rejected;
	await resumed;
	assert.equal(resumes, 0, "late old resume cannot thaw the newer pause");
	await assert.rejects(owner.checkpoint(), /ACK missing/);
	await owner.resumeTools();
	assert.ok(resumes > 0);
	await owner.quiesce();
	await assert.rejects(owner.checkpoint(), /ACK missing/);
	const attempts = checkpoints;
	await assert.rejects(owner.checkpoint(), /ACK missing/);
	assert.equal(checkpoints, attempts, "missing ACK cannot become success through an empty census");
});

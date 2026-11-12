import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { GLOBAL_UPDATE_TARGET, GlobalUpdatePreparation } from "./global-update-preparation.ts";
import type { LifecycleCheckpoint } from "./lifecycle-checkpoint.ts";
import { canonicalJSON, OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { RuntimeAdmission, RuntimeResources } from "./runtime-admission.ts";
import { SessionManager, Worker } from "./sessions.ts";

const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
const draft = "  unsent 👩🏽‍💻\n漢字 preedit  ";
const pinned = { captureHash: payloadHash(draft), app: { source: "a".repeat(40), build: "1000.1" } };
function operation(kind = "global-update-prepare", payload: unknown = pinned): DurableOperation {
	const bytes = canonicalJSON(payload);
	return {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: host,
		destination: host,
		targetId: GLOBAL_UPDATE_TARGET,
		kind,
		payload: bytes,
		payloadHash: payloadHash(bytes),
	};
}

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-global-update-"));
	const children: ChildProcess[] = [];
	const modes = ["healthy", "unresponsive", "malformed", "errored"];
	const projects = new ProjectStore(home);
	let starts = 0;
	const sessions = new SessionManager(home, projects, undefined, {
		title: async () => undefined,
		worker: (spec, receive, exit) => {
			starts++;
			const child = fork(
				new URL("./testing/update-pause-worker.ts", import.meta.url),
				[modes.shift() ?? "healthy"],
				{
					execArgv: [],
					stdio: ["ignore", "ignore", "ignore", "ipc"],
					env: { PATH: process.env.PATH },
				},
			);
			children.push(child);
			return new Worker(spec, receive, exit, undefined, { child });
		},
	});
	const journal = new OperationJournal(join(home, "operations"), host);
	const managers = [sessions];
	const resources = new RuntimeResources([sessions]);
	const preparation = new GlobalUpdatePreparation(journal, resources, sessions);
	await preparation.load();
	await sessions.load();
	const chats = [];
	for (const name of ["healthy", "unresponsive", "malformed", "errored"])
		chats.push(await sessions.spawn({ cwd: home, message: name }));
	const internal = sessions as unknown as { starting: Map<string, Promise<unknown>> };
	await Promise.all(internal.starting.values());
	await writeFile(join(home, "saved-native-capture"), draft);
	t.after(async () => {
		for (const manager of managers.toReversed()) await manager.shutdown();
		await Promise.all(
			children
				.filter((c) => c.exitCode === null && c.signalCode === null)
				.map(
					(c) =>
						new Promise<void>((resolve) => {
							c.once("exit", () => resolve());
							c.kill("SIGKILL");
						}),
				),
		);
		await rm(home, { recursive: true, force: true });
	});
	return {
		home,
		sessions,
		managers,
		chats,
		journal,
		resources,
		preparation,
		children,
		draft,
		starts: () => starts,
		settle: () => Promise.all(internal.starting.values()),
	};
}

test("global preparation interrupts broken real IPC peers alongside healthy work, without replay", async (t) => {
	const f = await fixture(t);
	const live = (
		f.sessions as unknown as { metas: Map<string, { failure?: string; updateRecovery?: { operationId: string } }> }
	).metas.get(f.chats[0]!.id)!;
	live.failure = "provider failure while an executor still exists";
	const op = operation();
	const before = Date.now();
	const result = await f.preparation.prepare(op);
	assert.equal(result.state, "accepted");
	assert.ok(Date.now() - before < 6_000, "bounded host preparation does not wait for a model/IPC reply");
	assert.equal(
		f.children.every((c) => c.exitCode === 0),
		true,
		"joined actual OS exit, not a cancellation ACK",
	);
	const manifest = f.sessions.lifecycleManifest(op.operationId);
	assert.equal(manifest.length, 4);
	assert.equal(manifest[0]?.checkpoint.phase, "checkpointed");
	assert.equal(live.updateRecovery?.operationId, op.operationId, "reconciliation follows actual executor close");
	for (const entry of manifest.slice(1)) {
		assert.equal(entry.checkpoint.phase, "unknown");
		assert.equal(entry.checkpoint.interrupted, true);
		assert.equal(entry.checkpoint.hostExited, true);
		assert.equal(entry.checkpoint.quiescent, undefined, "root exit never claims descendant proof");
	}
	assert.ok(
		(result.result as { blockers: { kind: string }[] }).blockers.some((b) => b.kind === "unknown-process"),
		"current interrupted shutdown uncertainty is not bookkeeping",
	);
	assert.equal(await readFile(join(f.home, "saved-native-capture"), "utf8"), f.draft);
	await assert.rejects(f.sessions.spawn({ cwd: f.home, message: "fenced" }), /update/);
	assert.deepEqual(await f.preparation.lookup(op), result);
	assert.deepEqual(await f.preparation.prepare(op), result);
	await assert.rejects(f.preparation.prepare(operation()), /Original global update/);
	assert.equal(f.starts(), 4);
	const reopened = new GlobalUpdatePreparation(
		new OperationJournal(join(f.home, "operations"), host),
		f.resources,
		f.sessions,
	);
	await reopened.load();
	assert.deepEqual(await reopened.lookup(op), result);
	assert.equal(f.starts(), 4, "reopen/lookup never repeats pause, cancellation or sends");
});

test("normal update recovery reconciles failed persisted bookkeeping without restarting or losing queued work", async (t) => {
	const f = await fixture(t);
	await f.sessions.shutdown(); // Real IPC peers exit before the cold recovery scenario.
	const before = new Map<string, Record<string, unknown>>();
	for (const [index, chat] of f.chats.entries()) {
		const path = join(f.home, "sessions", chat.id, "meta.json");
		const meta = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		const failure = [
			"Anthropic request refused",
			"OpenAI request refused",
			"Workspace is missing",
			"Kernel initialization failed",
		][index];
		if (index < 2) {
			delete meta.failure;
			meta.inputError = failure;
		} else meta.failure = failure;
		meta.working = true;
		meta.initializing = true;
		meta.preparing = { source: join(f.home, "missing-source"), baseBranch: "kept-branch" };
		if (index === 2) meta.cwd = join(f.home, "missing-workspace");
		meta.inputsPaused = true;
		meta.pending = [{ type: "input", requestId: randomUUID(), content: draft, mode: "followUp" }];
		meta.recoveryStopped = index >= 2;
		meta.lifecycleCheckpoint = {
			schema: 1,
			operationId: randomUUID(),
			purpose: "app-update",
			incarnation: "previous-runtime:1",
			sessionCreatedAt: meta.createdAt,
			inputGeneration: meta.inputGeneration ?? 0,
			inputControlRevision: meta.inputControlRevision ?? 0,
			prior: {
				working: true,
				updatePaused: false,
				sleepPaused: false,
				inputsPaused: true,
				subscriptionPaused: false,
			},
			children: [],
			phase: "resume-admitted",
		};
		await writeFile(path, JSON.stringify(meta));
		before.set(chat.id, meta);
	}
	let starts = 0;
	const cold = new SessionManager(f.home, new ProjectStore(f.home), undefined, {
		title: async () => undefined,
		worker: () => {
			starts++;
			throw new Error("failed work must not start during update recovery");
		},
	});
	f.managers.push(cold);
	const independent = new RuntimeAdmission();
	const releaseJob = independent.begin({ kind: "job", id: "independent-owned-process" });
	t.after(releaseJob);
	const resources = new RuntimeResources([cold, independent]);
	const initialHold = resources.freezeAdmissions();
	t.after(initialHold);
	const preparation = new GlobalUpdatePreparation(
		new OperationJournal(join(f.home, "operations"), host),
		resources,
		cold,
	);
	await preparation.load();
	await cold.load(true);
	const op = operation();
	const receipt = await preparation.prepare(op);
	assert.equal(receipt.state, "accepted");
	assert.deepEqual(
		(await preparation.verify(op)).blockers,
		[{ kind: "job", id: "independent-owned-process" }],
		"bookkeeping recovery never waives independent process evidence",
	);
	releaseJob();
	assert.deepEqual(
		(await preparation.verify(op)).blockers,
		[],
		"historical failed bookkeeping is not a process census",
	);
	initialHold(); // The accepted preparation still owns its global admission hold.
	for (const chat of f.chats) {
		const prior = before.get(chat.id)!;
		const saved = JSON.parse(await readFile(join(f.home, "sessions", chat.id, "meta.json"), "utf8"));
		assert.equal(saved.failure, prior.failure, "no provider safeguard or original failure is bypassed");
		assert.equal(saved.inputError, prior.inputError);
		assert.deepEqual(
			saved.lifecycleCheckpoint,
			prior.lifecycleCheckpoint,
			"original uncertain ownership is kept exactly",
		);
		assert.equal(saved.working, false);
		assert.equal(saved.initializing, undefined);
		assert.equal(saved.preparing, undefined);
		assert.equal(saved.inputsPaused, true);
		assert.equal(saved.recoveryStopped, prior.recoveryStopped);
		assert.deepEqual(saved.pending, prior.pending, "durable queued intent is preserved, not sent");
		assert.equal(saved.updateRecovery.operationId, op.operationId);
		assert.deepEqual(
			saved.updateRecovery.prior.preparing,
			prior.preparing,
			"clone recipe stays data, not an automatic retry",
		);
	}
	// A retained operation owns cold recovery before any startup dispatch. Only
	// bookkeeping is reconciled; no checkpoint/cancel/install effect is re-entered.
	await cold.shutdown();
	for (const chat of f.chats) {
		const path = join(f.home, "sessions", chat.id, "meta.json");
		const meta = JSON.parse(await readFile(path, "utf8"));
		meta.working = true;
		meta.initializing = true;
		await writeFile(path, JSON.stringify(meta));
	}
	const recovered = new SessionManager(f.home, new ProjectStore(f.home), undefined, {
		title: async () => undefined,
		worker: () => {
			starts++;
			throw new Error("cold update recovery must not restart failed work");
		},
	});
	f.managers.push(recovered);
	const reopened = new GlobalUpdatePreparation(
		new OperationJournal(join(f.home, "operations"), host),
		new RuntimeResources([recovered]),
		recovered,
	);
	await reopened.load();
	await recovered.load(true);
	assert.deepEqual(await reopened.prepare(op), receipt, "original operation receipt is not rewritten or replayed");
	assert.deepEqual((await reopened.verify(op)).blockers, []);
	for (const chat of f.chats) {
		const meta = JSON.parse(await readFile(join(f.home, "sessions", chat.id, "meta.json"), "utf8"));
		assert.equal(meta.working, false);
		assert.equal(meta.initializing, undefined);
		assert.equal(meta.failure, before.get(chat.id)!.failure);
		assert.equal(meta.inputError, before.get(chat.id)!.inputError);
		assert.deepEqual(meta.lifecycleCheckpoint, before.get(chat.id)!.lifecycleCheckpoint);
		assert.deepEqual(meta.updateRecovery.prior.preparing, before.get(chat.id)!.preparing);
	}
	const release = operation("global-update-release", { prepareId: op.operationId, prepareHash: op.payloadHash });
	await reopened.release(release, op, async () => {}); // Fake native authority, not production startup proof.
	assert.equal(starts, 0);
	await assert.rejects(readFile(join(f.home, "missing-workspace")), /ENOENT/);
	assert.equal(await readFile(join(f.home, "saved-native-capture"), "utf8"), draft);
});

test("an interrupted preparation remains lookup-only after durable reopen", async (t) => {
	const f = await fixture(t);
	const op = operation();
	await f.journal.reserve(op); // Simulate interruption after durable admission, before any effect.
	const reopened = new GlobalUpdatePreparation(
		new OperationJournal(join(f.home, "operations"), host),
		f.resources,
		f.sessions,
	);
	await reopened.load();
	assert.equal((await reopened.lookup(op))?.state, "pending");
	assert.equal((await reopened.prepare(op)).state, "pending");
	await assert.rejects(reopened.prepare(operation()), /Original global update/);
	const release = operation("global-update-release", { prepareId: op.operationId, prepareHash: op.payloadHash });
	let verifications = 0;
	await assert.rejects(
		reopened.release(release, op, async () => {
			verifications++;
		}),
		/lookup-only/,
	);
	assert.equal(verifications, 0);
	assert.equal(f.starts(), 4);
});

test("native release verifies the pinned target, then selectively recovers only acknowledged work", async (t) => {
	const f = await fixture(t);
	const op = operation();
	await f.preparation.prepare(op);
	const release = operation("global-update-release", { prepareId: op.operationId, prepareHash: op.payloadHash });
	let verified = 0;
	const result = await f.preparation.release(release, op, async (target) => {
		assert.deepEqual(target, pinned);
		verified++;
	});
	assert.equal(result.state, "accepted");
	assert.equal(verified, 1);
	await f.settle();
	assert.deepEqual(
		await f.preparation.release(release, op, async () => {
			throw new Error("no verifier replay");
		}),
		result,
	);
	assert.equal(f.starts(), 5, "only healthy acknowledged work resumes; broken effects stay Unknown");
});

test("a failed live executor keeps its previous uncertain checkpoint before a fresh host-owned stop", async (t) => {
	const f = await fixture(t);
	const internals = f.sessions as unknown as {
		start(id: string, admitted?: boolean): Promise<Map<string, Error>>;
		metas: Map<
			string,
			{
				createdAt: number;
				inputGeneration?: number;
				inputControlRevision?: number;
				inputError?: string;
				lifecycleCheckpoint?: LifecycleCheckpoint;
				updateRecovery?: { prior: { lifecycleCheckpoints?: LifecycleCheckpoint[] } };
			}
		>;
	};
	const meta = internals.metas.get(f.chats[0]!.id)!;
	f.children[0]!.emit("message", { type: "working", working: false }); // Terminal faux-provider state, not process exit.
	meta.inputError = "Anthropic request refused";
	const previous: LifecycleCheckpoint = {
		schema: 1,
		operationId: randomUUID(),
		purpose: "app-update",
		incarnation: "previous-runtime:1",
		sessionCreatedAt: meta.createdAt,
		inputGeneration: meta.inputGeneration ?? 0,
		inputControlRevision: meta.inputControlRevision ?? 0,
		prior: { working: true, updatePaused: false, sleepPaused: false, inputsPaused: false, subscriptionPaused: false },
		children: [],
		phase: "resume-admitted",
	};
	meta.lifecycleCheckpoint = previous;
	const op = operation();
	assert.equal((await f.preparation.prepare(op)).state, "accepted");
	assert.deepEqual(meta.updateRecovery?.prior.lifecycleCheckpoints, [previous]);
	assert.equal(meta.lifecycleCheckpoint.operationId, op.operationId);
	assert.equal(meta.lifecycleCheckpoint.hostExited, true);
	assert.equal(f.children[0]!.exitCode, 0, "actual executor exit still had to join");
	const release = operation("global-update-release", { prepareId: op.operationId, prepareHash: op.payloadHash });
	await f.preparation.release(release, op, async () => {}); // Fake native verifier, not production shutdown proof.
	await f.settle();
	await internals.start(f.chats[0]!.id, true); // A late host wake is not fresh user retry authority.
	assert.equal(f.starts(), 4, "provider refusal is preserved, never retried by update recovery");
});

test("an old admission error does not discard healthy active work's update-owned resume", async (t) => {
	const f = await fixture(t);
	const meta = (
		f.sessions as unknown as { metas: Map<string, { inputError?: string; updateRecovery?: unknown }> }
	).metas.get(f.chats[0]!.id)!;
	meta.inputError = "An earlier queue edit was not accepted";
	const op = operation();
	await f.preparation.prepare(op);
	assert.equal(meta.updateRecovery, undefined, "a healthy active executor is not a failed run");
	const release = operation("global-update-release", { prepareId: op.operationId, prepareHash: op.payloadHash });
	await f.preparation.release(release, op, async () => {});
	await f.settle();
	assert.equal(f.starts(), 5);
});

test("a genuine ownership-save failure is pending/actionable, not a broken-chat success", async (t) => {
	const f = await fixture(t);
	const internal = f.sessions as unknown as {
		save(meta: { lifecycleCheckpoint?: { phase: string } }, ...args: unknown[]): Promise<void>;
	};
	const original = internal.save;
	const mocked = t.mock.method(
		internal,
		"save",
		async (meta: { lifecycleCheckpoint?: { phase: string } }, ...args: unknown[]) => {
			if (meta.lifecycleCheckpoint?.phase === "checkpointing") throw new Error("ownership fsync failed");
			return original.call(f.sessions, meta, ...args);
		},
	);
	try {
		const op = operation();
		const receipt = await f.preparation.prepare(op);
		assert.equal(receipt.state, "pending");
		assert.match(JSON.stringify(receipt.result), /ownership fsync failed/);
		assert.equal(
			f.children.every((c) => c.exitCode === null),
			true,
			"no worker interrupted before durable ownership",
		);
		assert.deepEqual(await f.preparation.prepare(op), receipt);
		await assert.rejects(f.preparation.prepare(operation()), /Original global update/);
	} finally {
		mocked.mock.restore();
	}
});

test("actual process-exit failure stays actionable and cannot receive a release", async (t) => {
	const f = await fixture(t);
	const internal = f.sessions as unknown as { workers: Map<string, Worker> };
	const worker = internal.workers.get(f.chats[0]!.id)!;
	const mocked = t.mock.method(worker, "close", async () => {
		throw new Error("owned process exit failed");
	});
	try {
		const op = operation();
		const receipt = await f.preparation.prepare(op);
		assert.equal(receipt.state, "pending");
		assert.match(JSON.stringify(receipt.result), /owned process exit failed/);
		assert.equal(f.children[0]!.exitCode, null);
		const release = operation("global-update-release", { prepareId: op.operationId, prepareHash: op.payloadHash });
		await assert.rejects(
			f.preparation.release(release, op, async () => {}),
			/lookup-only/,
		);
	} finally {
		mocked.mock.restore();
	}
});

test("an uncertain native release cannot be resent or replaced by a fresh operation", async (t) => {
	const f = await fixture(t);
	const op = operation();
	await f.preparation.prepare(op);
	const binding = { prepareId: op.operationId, prepareHash: op.payloadHash };
	const release = operation("global-update-release", binding);
	let checks = 0;
	const receipt = await f.preparation.release(release, op, async () => {
		checks++;
		throw new Error("successor identity unavailable");
	});
	assert.equal(receipt.state, "pending");
	assert.deepEqual(
		await f.preparation.release(release, op, async () => {
			checks++;
		}),
		receipt,
	);
	await assert.rejects(
		f.preparation.release(operation("global-update-release", binding), op, async () => {
			checks++;
		}),
		/original-operation lookup-only/,
	);
	assert.equal(checks, 1);
	assert.equal(f.starts(), 4);
});

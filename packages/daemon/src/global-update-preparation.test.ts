import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { GLOBAL_UPDATE_TARGET, GlobalUpdatePreparation } from "./global-update-preparation.ts";
import { canonicalJSON, OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { RuntimeResources } from "./runtime-admission.ts";
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
		await sessions.shutdown();
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
	for (const entry of manifest.slice(1)) {
		assert.equal(entry.checkpoint.phase, "unknown");
		assert.equal(entry.checkpoint.interrupted, true);
		assert.equal(entry.checkpoint.hostExited, true);
		assert.equal(entry.checkpoint.quiescent, undefined, "root exit never claims descendant proof");
	}
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

// biome-ignore-all lint/complexity/useLiteralKeys: Exercise the trusted worker IPC seam without launching agents.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KernelCommand } from "@pilot/kernel";
import type { SessionState, UsageObservation } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";
import { UsageHistoryStore } from "./usage-history.ts";

class CaptureWorker implements SessionWorker {
	ready = Promise.resolve();
	state: SessionState = "idle";
	readonly commands: KernelCommand[] = [];
	next?: (command: KernelCommand) => void;
	send(command: KernelCommand): void {
		this.commands.push(command);
		this.next?.(command);
	}
	async request(): Promise<void> {}
	async close(): Promise<void> {}
}

test("kernel history ingestion is separate, epoch-fenced and restricted to the currently owned worker", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "kernel-history-ipc-"));
	const id = randomUUID();
	await mkdir(join(home, "sessions", id), { recursive: true });
	await writeFile(
		join(home, "sessions", id, "meta.json"),
		JSON.stringify({ id, cwd: home, title: "fixture", createdAt: Date.now(), updatedAt: Date.now() }),
	);
	const store = new UsageHistoryStore(home);
	const manager = new SessionManager(
		home,
		new ProjectStore(home),
		home,
		{ worker: () => new CaptureWorker() },
		{},
		{ usageHistory: store },
	);
	t.after(async () => {
		await manager.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await manager.load();
	const meta = manager["metas"].get(id)!;
	const worker = new CaptureWorker();
	manager["workers"].set(id, worker);
	t.mock.method(manager["aiUsage"], "observeUsage", () =>
		assert.fail("local identities must not enter aggregate telemetry accounting"),
	);
	const epoch = await store.status();
	const row: UsageObservation = {
		schemaVersion: 1,
		generation: epoch.generation,
		sourceId: randomUUID(),
		operationId: randomUUID(),
		revision: 1,
		kind: "checkpoint",
		scope: "direct",
		observedAt: Date.now(),
		coverage: "partial",
		purpose: "agent",
		attribution: { chatId: id },
		outcome: "unknown",
	};
	const ingest = (observation: UsageObservation) =>
		new Promise<KernelCommand>((resolve) => {
			worker.next = resolve;
			manager["onPacket"](meta, worker, { type: "usage-history", callId: randomUUID(), row: observation });
		});
	assert.equal(((await ingest(row)) as { result?: string }).result, "stored");
	assert.equal(((await ingest(row)) as { result?: string }).result, "duplicate");
	assert.equal((await store.status()).retainedRows, 1);
	const cleared = await store.clear();
	assert.equal(((await ingest(row)) as { result?: string }).result, "rejected");
	assert.equal((await store.status()).retainedRows, 0);
	assert.equal(
		(
			(await ingest({
				...row,
				operationId: randomUUID(),
				generation: cleared.generation,
				observedAt: Date.now(),
			})) as { result?: string }
		).result,
		"stored",
	);
	const stale = new CaptureWorker();
	manager["onPacket"](meta, stale, { type: "usage-history", callId: randomUUID(), row });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(stale.commands.length, 0);
	assert.equal((await store.status()).retainedRows, 1);
});

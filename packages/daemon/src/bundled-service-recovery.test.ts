import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { GlobalUpdatePreparation } from "./global-update-preparation.ts";
import type { LifecycleCheckpoint } from "./lifecycle-checkpoint.ts";
import { canonicalJSON, OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { RuntimeResources } from "./runtime-admission.ts";
import { SessionManager, Worker } from "./sessions.ts";

const identity = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
const draft = "  unsent 👩🏽‍💻\n漢字  ";
const history = "Provider refused the request. No retry or bypass was authorized.";
function operation(): DurableOperation {
	const payload = canonicalJSON({ captureHash: payloadHash(draft), app: { source: "a".repeat(40), build: "1000.1" } });
	return {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: identity,
		destination: identity,
		targetId: "global-update",
		kind: "global-update-prepare",
		payload,
		payloadHash: payloadHash(payload),
	};
}

async function fixture(t: TestContext, failure: "provider-refusal" | "provider-error" | "missing-workspace") {
	const home = await mkdtemp(join(tmpdir(), "pilot-bundled-recovery-"));
	const id = randomUUID();
	const directory = join(home, "sessions", id);
	await mkdir(directory, { recursive: true });
	const missing = join(home, "missing-workspace");
	const checkpoint: LifecycleCheckpoint = {
		schema: 1,
		operationId: randomUUID(),
		purpose: "daemon-upgrade",
		incarnation: "old-boot:1",
		originBoot: "old-boot",
		host: { daemonId: "daemon", lineageId: "lineage" },
		sessionCreatedAt: 1,
		inputGeneration: 4,
		inputControlRevision: 2,
		prior: { working: true, updatePaused: false, sleepPaused: false, inputsPaused: false, subscriptionPaused: false },
		children: [],
		phase: "resume-admitted",
		hostExited: true,
	};
	const meta = {
		id,
		cwd: failure === "missing-workspace" ? missing : home,
		title: "Failed saved work",
		createdAt: 1,
		updatedAt: 1,
		working: true,
		updatePaused: true,
		inputGeneration: 4,
		inputControlRevision: 2,
		inputError: failure === "provider-refusal" ? history : `${failure}: saved failure`,
		...(failure === "missing-workspace" ? { failure: `${failure}: saved failure` } : {}),
		lifecycleCheckpoint: checkpoint,
	};
	await writeFile(join(directory, "meta.json"), JSON.stringify(meta));
	await writeFile(join(directory, "saved-draft"), draft);
	// A real durable SQLite history fixture, not a mock model reply. The updater
	// must not erase already committed bytes to reconcile lifecycle bookkeeping.
	const historyFile = join(directory, "history-fixture.sqlite");
	const db = new DatabaseSync(historyFile);
	db.exec("CREATE TABLE history (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
	db.prepare("INSERT INTO history(text) VALUES (?)").run(history);
	db.close();
	const historyBytes = await readFile(historyFile);
	const children: ChildProcess[] = [];
	const opened: string[] = [];
	function manager() {
		return new SessionManager(home, new ProjectStore(home), undefined, {
			title: async () => undefined,
			worker: (spec, receive, exit) => {
				opened.push(spec.sessionId);
				const child = fork(new URL("./testing/update-pause-worker.ts", import.meta.url), ["healthy"], {
					execArgv: [],
					stdio: ["ignore", "ignore", "ignore", "ipc"],
					env: { PATH: process.env.PATH },
				});
				children.push(child);
				return new Worker(spec, receive, exit, undefined, { child });
			},
		});
	}
	const managers: SessionManager[] = [];
	t.after(async () => {
		for (const sessions of managers) await sessions.shutdown();
		await Promise.all(
			children
				.filter((c) => c.exitCode === null && c.signalCode === null)
				.map(
					(child) =>
						new Promise<void>((resolve) => {
							child.once("exit", () => resolve());
							child.kill("SIGKILL");
						}),
				),
		);
		await rm(home, { recursive: true, force: true });
	});
	const sessions = manager();
	managers.push(sessions);
	await sessions.load();
	assert.equal(opened.length, 0, "cold failed records must not start a provider or recreate workspaces");
	const healthy = await sessions.spawn({ cwd: home, message: "healthy active work" });
	await Promise.all((sessions as unknown as { starting: Map<string, Promise<unknown>> }).starting.values());
	const resources = new RuntimeResources([sessions]);
	const journal = new OperationJournal(join(home, "operations"), identity);
	const preparation = new GlobalUpdatePreparation(journal, resources, sessions);
	await preparation.load();
	return {
		home,
		id,
		directory,
		missing,
		checkpoint,
		sessions,
		healthy,
		preparation,
		opened,
		async assertSaved() {
			assert.equal(await readFile(join(directory, "saved-draft"), "utf8"), draft);
			assert.deepEqual(await readFile(historyFile), historyBytes);
			if (failure === "missing-workspace") await assert.rejects(access(missing), { code: "ENOENT" });
		},
		async reopen() {
			await sessions.shutdown();
			const next = manager();
			managers.push(next);
			const nextPreparation = new GlobalUpdatePreparation(
				new OperationJournal(join(home, "operations"), identity),
				new RuntimeResources([next]),
				next,
			);
			await nextPreparation.load();
			await next.load(true);
			return { sessions: next, preparation: nextPreparation };
		},
	};
}

for (const failure of ["provider-refusal", "provider-error", "missing-workspace"] as const) {
	test(`normal update owns persisted ${failure} recovery beside healthy work and cold reopen`, async (t) => {
		const f = await fixture(t, failure);
		const op = operation();
		const receipt = await f.preparation.prepare(op);
		assert.equal(receipt.state, "accepted", "stale bookkeeping is not a cooperative-model veto");
		const manifest = f.sessions.lifecycleManifest(op.operationId);
		assert.ok(
			manifest.some((entry) => entry.sessionId === f.healthy.id),
			"healthy work is prepared normally",
		);
		const metaPath = join(f.directory, "meta.json");
		const recovered = JSON.parse(await readFile(metaPath, "utf8"));
		assert.equal(
			recovered.updateRecovery?.operationId,
			op.operationId,
			"update recovery must durably own the cold persisted failure, not silently skip it",
		);
		assert.equal(recovered.updateRecovery.kind, "persisted-failure");
		assert.equal(recovered.updateRecovery.prior.working, true);
		assert.equal(recovered.working, false, "failed work is interrupted, not restarted or claimed complete");
		assert.deepEqual(
			recovered.lifecycleCheckpoint,
			f.checkpoint,
			"original uncertainty/provenance must not be erased",
		);
		assert.ok(recovered.inputError, "provider refusal/error remains inspectable");
		assert.equal(f.opened.includes(f.id), false);
		await f.assertSaved();
		const opened = [...f.opened];
		const reopened = await f.reopen();
		assert.deepEqual(await reopened.preparation.lookup(op), receipt);
		assert.deepEqual(reopened.sessions.lifecycleManifest(op.operationId), manifest);
		assert.deepEqual(JSON.parse(await readFile(metaPath, "utf8")).updateRecovery, recovered.updateRecovery);
		assert.deepEqual(f.opened, opened, "reopen/lookup cannot replay a canceled or Unknown effect");
		await f.assertSaved();
	});
}

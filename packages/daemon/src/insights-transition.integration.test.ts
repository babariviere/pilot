// biome-ignore-all lint/complexity/useLiteralKeys: Synthetic fault injection and immutable SQL evidence.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DurableOperation, InsightsLegacySelector, ModelOption } from "@pilot/protocol";
import { openSessionStorage } from "../../kernel/src/storage.ts";
import { Conflict } from "./errors.ts";
import { InsightsEnable } from "./insights-enable.ts";
import { admitInsightsOperation } from "./insights-native.ts";
import { InsightsOwner } from "./insights-owner.ts";
import { initialInsightsSettings } from "./insights-settings.ts";
import { InsightsTransition } from "./insights-transition.ts";
import { InsightsWorkspace } from "./insights-workspace.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import type { ModelCatalog } from "./models.ts";
import { canonicalJSON, OperationJournal, payloadHash } from "./operation-journal.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";
import { createDaemonServer } from "./server.ts";
import { TerminalManager } from "./terminals.ts";
import { fixture as sessionFixture } from "./testing/session-workspace.ts";

const host = { hostId: "daemon", daemonId: "synthetic", lineageId: "synthetic-lineage" };
const model: ModelOption = {
	id: "synthetic/terra",
	provider: "synthetic",
	name: "Terra 6.1",
	thinkingLevels: ["high"],
};
async function fixture(
	t: TestContext,
	options: { desiredChange?: boolean; revoke?: boolean; continuation?: boolean } = {},
) {
	const f = await sessionFixture(
		t,
		{ diagnosticHost: host },
		{
			worker: () => {
				throw new Error("No transition test may start a worker");
			},
		},
	);
	const store = new MissionStore(join(f.home, "missions.sqlite"));
	const service = new MissionService(store, f.sessions, f.projects);
	const mission = store.create({ title: "Original user mission", projectId: f.project.id });
	await store.durable();
	const models = { list: async () => ({ models: [model] }) } as unknown as ModelCatalog;
	let automations = true;
	const scheduleStore = new ScheduleStore(join(f.home, "schedules.sqlite"));
	const schedules = new ScheduleService(scheduleStore, {
		projects: f.projects,
		sessions: f.sessions,
		missions: store,
		home: host,
		automationsEnabled: () => automations,
		clock: { now: () => Date.parse("2026-11-02T09:00:00Z"), setTimeout: () => () => {} },
	});
	await schedules.load();
	const journal = new OperationJournal(join(f.home, "operations"), host);
	let sequence = 0;
	const operation = (kind: string, payload: unknown, targetId: string): DurableOperation => {
		const raw = JSON.stringify(payload);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: "native-transfer-fixture",
			sequence: ++sequence,
			origin: { ...host, hostId: "local" },
			destination: { ...host, hostId: "local" },
			kind,
			targetId,
			payload: raw,
			payloadHash: payloadHash(raw),
		};
	};
	const oldEnable = new InsightsEnable({
		home: f.home,
		host,
		projects: f.projects,
		missions: store,
		models,
		sessions: f.sessions,
		schedules,
		journal,
	});
	const oldPreview = await oldEnable.preflight(f.project.id, mission.id, model.id, "high");
	assert.ok(oldPreview.payload, JSON.stringify(oldPreview));
	const oldEnableOp = operation("insights-enable", oldPreview.payload, oldPreview.targetId);
	const initial = await journal.execute(oldEnableOp, (op) => oldEnable.enable(op, oldPreview.payload!));
	assert.equal(initial.state, "accepted", JSON.stringify(initial));
	const report = oldPreview.targetId;
	// Real kernel storage ownership was acquired and closed. No provider/session turn is fabricated.
	const ownership = await openSessionStorage(join(f.sessions["dir"](report), "durable"));
	await ownership.storage.close(BACKGROUND_CONTEXT);
	ownership.release();
	const admission = f.sessions.insightsHostAdmission(report);
	const finding = {
		action: "propose",
		operationId: randomUUID(),
		key: randomUUID(),
		expectedRevision: 0,
		patternKey: "kept-pattern",
		draft: {
			title: "Kept finding é",
			priority: "medium",
			observation: "Synthetic evidence",
			uncertainty: "Unknown baseline",
			proposedChange: "Requires separate approval",
			expectedBenefit: "Unknown",
			targets: [],
			implementationLinks: [],
		},
		evidence: [],
	};
	await store.insights.call(admission, finding);
	const originalEffective = store.insights.settings.current(admission) ?? {
		revision: 0,
		model: model.id,
		settings: initialInsightsSettings(model.id),
	};
	const originals = [oldEnableOp];
	let continuation: { source: string; position: string } | undefined;
	if (options.continuation) {
		const run = {
			runId: randomUUID(),
			windowStart: "2026-11-01T00:00:00Z",
			windowEnd: "2026-11-02T00:00:00Z",
			bounds: originalEffective.settings.bounds,
		};
		await store.insights.reviews.reserve(admission, run);
		await store.insights.reviews.interrupt(
			report,
			"cancelled",
			"Known synthetic Stop, unfinished coverage",
			run.runId,
		);
		const scope = String(store["one"]("SELECT binding FROM insights_runs WHERE run_id=?", run.runId)!.binding);
		continuation = {
			source: randomUUID(),
			position: JSON.stringify({ stream: "synthetic", before: 42, anchor: { id: 43, hash: "a".repeat(64) } }),
		};
		store["run"](
			"INSERT INTO insights_sources(scope,session_id,project_id,position,reviewed) VALUES (?,?,?,?,0)",
			scope,
			continuation.source,
			f.project.id,
			continuation.position,
		);
		store["run"]("INSERT INTO insights_inventory VALUES (?,?)", scope, randomUUID());
		await store.durable();
	}
	if (options.desiredChange) {
		const s = await oldEnable.settings(report);
		const desired = { ...s.settings, budget: { ...s.settings.budget, usd: 7 } };
		const p = {
			projectId: s.projectId,
			missionId: s.missionId,
			expectedHome: s.expectedHome,
			context: s.context,
			chat: s.chat,
			expectedRevision: s.revision,
			settings: desired,
		};
		const op = operation("insights-settings", p, report);
		assert.equal((await journal.execute(op, (op) => oldEnable.saveSettings(op, p))).state, "accepted");
		originals.push(op);
	}
	if (options.revoke !== false) {
		const revoke = operation("insights-revoke", { expectedRevision: 1 }, report);
		assert.equal(
			(
				await journal.execute(revoke, (op) =>
					admitInsightsOperation(f.sessions, store.insights, op, JSON.parse(op.payload)),
				)
			).state,
			"accepted",
		);
		originals.push(revoke);
	}
	const legacy: InsightsLegacySelector = {
		schemaVersion: 2,
		reportSessionId: report,
		projectId: f.project.id,
		missionId: mission.id,
		expectedHome: host,
		context: oldEnable.context(f.project.id, mission.id),
	};
	const transition = new InsightsTransition({
		home: f.home,
		projects: f.projects,
		mission: (id) => {
			const m = store.require(id);
			return { projectId: m.projectId, status: m.status };
		},
		workspace: store.insightsWorkspace,
		store: store.insightsTransition,
		journal,
		sessions: f.sessions,
		schedules,
	});
	const ownerService = new InsightsOwner({
		home: f.home,
		projects: f.projects,
		models,
		workspace: store.insightsWorkspace,
		store: store.insightsOwner,
		sessions: f.sessions,
		schedules,
		journal,
		transition,
	});
	const run = (op: DurableOperation) => journal.execute(op, (op, entry) => transition.admit(op, entry.firstEntry));
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await f.sessions.shutdown();
		await schedules.stop();
		await scheduleStore.close();
		await store.close();
	};
	t.after(close);
	const prepare = async () => {
		const p = await transition.preview(legacy);
		assert.ok(p.payload, JSON.stringify(p));
		return {
			payload: p.payload,
			op: operation("insights-workspace-transfer", p.payload, p.payload.owner.workspaceId),
			authority: { home: f.home, projectPath: f.project.path, owner: p.payload.owner },
		};
	};
	return {
		...f,
		store,
		service,
		models,
		schedules,
		scheduleStore,
		journal,
		oldEnable,
		originalEffective,
		originals,
		mission,
		legacy,
		finding,
		continuation,
		transition,
		ownerService,
		operation,
		run,
		prepare,
		close,
		automations: (value: boolean) => {
			automations = value;
		},
	};
}

test("native transfer preserves v1 bytes and desired/effective split; a separate fresh confirmation alone grants owner execution", async (t) => {
	const f = await fixture(t, { desiredChange: true, continuation: true });
	const bytes = await Promise.all(
		f.originals.map((op) => readFile(join(f.home, "operations", `${payloadHash(op.operationId)}.json`), "utf8")),
	);
	const { op, payload, authority } = await f.prepare();
	const before = f.store.insightsTransition.snapshot(f.legacy, { implicit: null });
	assert.equal(payload.effective.revision, 1);
	assert.equal(payload.desired.revision, 2);
	assert.equal(f.specs.length, 0);
	assert.equal((await f.transition.check(op)).transfer.state, "absent");
	f.automations(false);
	const receipt = await f.run(op);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal(f.schedules.store.require(payload.rules[0]!.id).state, "cancelled");
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_owner_grants")!.n, 0);
	assert.equal(
		f.store["one"](
			"SELECT position FROM insights_owner_sources WHERE scope=? AND session_id=?",
			payloadHash(canonicalJSON(payload.owner)),
			f.continuation!.source,
		)!.position,
		f.continuation!.position,
	);
	assert.equal(f.sessions.get(payload.owner.reportSessionId), undefined);
	assert.deepEqual(f.store.insightsTransition.snapshot(f.legacy, { implicit: null }), before);
	assert.deepEqual(
		await Promise.all(
			f.originals.map((op) => readFile(join(f.home, "operations", `${payloadHash(op.operationId)}.json`), "utf8")),
		),
		bytes,
	);
	assert.equal((await f.run(op)).state, "accepted");
	assert.throws(() => f.sessions.insightsReplacementTarget(f.legacy.reportSessionId.toUpperCase()), /fenced/);
	assert.equal(f.store.require(f.mission.id).title, "Original user mission");
	f.store.remove(f.mission.id);
	await f.store.durable();
	const lease = f.sessions.insightsOwnerLease(authority);
	assert.equal((await f.store.insightsWorkspace.item(lease, "finding", f.finding.key)).key, f.finding.key);
	assert.equal((await f.transition.check(op)).transfer.state, "committed");
	f.automations(true);
	const p = await f.ownerService.preview(payload.owner);
	assert.equal(p.transitionId, op.operationId);
	assert.equal(p.settingsRevision, 1);
	assert.equal(p.desiredSettingsRevision, 2);
	assert.deepEqual(p.settings, f.originalEffective.settings);
	const enable = f.operation("insights-workspace-enable", p, payload.owner.workspaceId);
	const enabled = await f.journal.execute(enable, (op, entry) => f.ownerService.admit(op, entry.firstEntry));
	assert.equal(enabled.state, "accepted", JSON.stringify(enabled));
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_owner_grants")!.n, 1);
	assert.notEqual(f.store.insightsOwner.current(authority)!.binding.grantId, payload.identity.grantId);
	assert.equal(f.store.insightsOwner.current(authority)!.settings.revision, 1);
	assert.equal((await f.store.insightsWorkspace.settings(lease))!.revision, 2);
	assert.equal(f.schedules.store.require(payload.owner.scheduleId).insightsSettingsRevision, 1);
	assert.equal(f.specs.length, 0);
});

test("concurrent native confirmations choose one tracking transaction and one exact cancellation", async (t) => {
	const f = await fixture(t),
		{ op, payload } = await f.prepare();
	const second = f.operation(op.kind, payload, op.targetId);
	let cancellations = 0;
	const cancel = f.schedules.cancelLegacyForTransfer.bind(f.schedules);
	t.mock.method(f.schedules, "cancelLegacyForTransfer", async (...args: Parameters<typeof cancel>) => {
		cancellations++;
		return cancel(...args);
	});
	const receipts = await Promise.all([f.run(op), f.run(second)]);
	assert.equal(receipts.filter((r) => r.state === "accepted").length, 1, JSON.stringify(receipts));
	assert.equal(cancellations, 1);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_transfers")!.n, 1);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_items")!.n, 1);
});

test("unknown cancellation stays entered across exact retries and fresh-ID attempts", async (t) => {
	const f = await fixture(t),
		{ op } = await f.prepare();
	const cancel = f.schedules.cancelLegacyForTransfer.bind(f.schedules);
	let cancellations = 0;
	t.mock.method(f.schedules, "cancelLegacyForTransfer", async (...args: Parameters<typeof cancel>) => {
		cancellations++;
		await cancel(...args);
		throw new Error("Synthetic lost cancellation ACK");
	});
	assert.equal((await f.run(op)).state, "pending");
	assert.equal((await f.transition.check(op)).transfer.state, "entered");
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(cancellations, 1);
	assert.equal((await f.transition.preview(f.legacy)).state, "blocked");
	assert.equal((await f.run(f.operation(op.kind, JSON.parse(op.payload), op.targetId))).state, "rejected");
	assert.equal(cancellations, 1);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_owners")!.n, 0);
});

test("lost final ACK reconciles only the committed transaction, without cancellation or copy replay", async (t) => {
	const f = await fixture(t),
		{ op } = await f.prepare();
	const commit = f.store.insightsTransition.commit.bind(f.store.insightsTransition);
	let copies = 0;
	t.mock.method(f.store.insightsTransition, "commit", async (...args: Parameters<typeof commit>) => {
		copies++;
		await commit(...args);
		throw new Error("Synthetic final ACK lost");
	});
	assert.equal((await f.run(op)).state, "pending");
	assert.equal((await f.transition.check(op)).transfer.state, "committed");
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal(copies, 1);
});

test("a failed native copy rolls back all owned rows without replaying its acknowledged cancellation", async (t) => {
	const f = await fixture(t),
		{ op, payload } = await f.prepare();
	const original = f.store.insightsTransition.snapshot(f.legacy, { implicit: payload.desired }).parts;
	f.store["run"](
		"CREATE TRIGGER native_copy_fault BEFORE INSERT ON insights_workspace_items BEGIN SELECT RAISE(ABORT,'synthetic native copy fault'); END",
	);
	await f.store.durable();
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(f.schedules.store.require(payload.rules[0]!.id).state, "cancelled");
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_owners")!.n, 0);
	f.store["run"]("DROP TRIGGER native_copy_fault");
	await f.store.durable();
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_items")!.n, 0);
	assert.deepEqual(f.store.insightsTransition.snapshot(f.legacy, { implicit: payload.desired }).parts, original);
});

test("bounded native capture never clones unrelated scheduled prompt bodies", async (t) => {
	const f = await fixture(t);
	const source = f.schedules.store.list()[0]!,
		message = "x".repeat(16384);
	for (let n = 0; n < 1000; n++) {
		const id = randomUUID();
		f.scheduleStore["items"].set(id, {
			...source,
			id,
			insightsDestination: undefined,
			insightsEnableOperationId: undefined,
			target: { kind: "message", sessionId: randomUUID(), message },
		});
	}
	const baselineAt = performance.now();
	f.schedules.store.list();
	const baseline = performance.now() - baselineAt;
	t.mock.method(f.schedules.store, "list", () => {
		throw new Error("Native capture must not clone the full prompt index");
	});
	const at = performance.now(),
		{ op, payload } = await f.prepare();
	const capture = performance.now() - at;
	assert.equal(payload.rules.length, 1);
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal((await f.ownerService.preview(payload.owner)).transitionId, op.operationId);
	t.diagnostic(
		`1000 unrelated 16 KiB prompts: full-index clone ${baseline.toFixed(1)}ms; bounded passive capture including async guards ${capture.toFixed(1)}ms. No threshold or streaming claim.`,
	);
});

test("Stop after the exact rule ACK blocks tracking commit and never resumes entered effects", async (t) => {
	const f = await fixture(t),
		{ op } = await f.prepare();
	const cancel = f.schedules.cancelLegacyForTransfer.bind(f.schedules);
	t.mock.method(f.schedules, "cancelLegacyForTransfer", async (...args: Parameters<typeof cancel>) => {
		const ack = await cancel(...args);
		await f.sessions.stop(f.legacy.reportSessionId);
		return ack;
	});
	assert.equal((await f.run(op)).state, "pending");
	assert.equal((await f.run(op)).state, "pending");
	assert.equal((await f.transition.check(op)).transfer.state, "entered");
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_owners")!.n, 0);
});

test("active authority and deleted reports require old exact-ID recovery, never independent fresh setup", async (t) => {
	const f = await fixture(t, { revoke: false });
	assert.match((await f.transition.preview(f.legacy)).reason!, /quiescent|revoked/);
	await f.sessions.revokeInsights(f.legacy.reportSessionId, 1);
	await rm(join(f.home, "sessions", f.legacy.reportSessionId), { recursive: true, force: true });
	f.sessions["metas"].delete(f.legacy.reportSessionId);
	assert.match((await f.transition.preview(f.legacy)).reason!, /exact_D14_recovery/);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_transfers")!.n, 0);
	const fresh = new InsightsWorkspace({
		home: f.home,
		host,
		projects: f.projects,
		models: f.models,
		store: f.store.insightsWorkspace,
		journal: f.journal,
		legacyGuard: () => {
			f.sessions.assertNoLegacyInsights();
			f.schedules.assertNoLegacyInsights(host);
		},
	});
	assert.equal((await fresh.preflight(f.project.id, model.id, "high")).state, "blocked");
});

test("immutable old-home proof cannot be inferred from matching grant or rule metadata", async (t) => {
	const f = await fixture(t);
	await f.journal.retire(f.originals[0]!.origin, f.originals[0]!.producerId, f.originals[0]!.sequence);
	assert.match((await f.transition.preview(f.legacy)).reason!, /immutable_home_proof/);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_transfers")!.n, 0);
});

test("an untracked live storage owner blocks transition even with a revoked metadata grant", async (t) => {
	const f = await fixture(t);
	const file = join(f.sessions["dir"](f.legacy.reportSessionId), "durable", "owner.sqlite");
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync(process.argv[1],{timeout:0}); db.exec("BEGIN EXCLUSIVE"); console.log("ready"); process.stdin.resume(); process.stdin.on("end",()=>db.close());',
			file,
		],
		{ stdio: ["pipe", "pipe", "inherit"] },
	);
	let exited = false;
	const exit = once(child, "exit").then(() => {
		exited = true;
	});
	t.after(async () => {
		if (!exited) child.kill("SIGTERM");
		await exit;
	});
	await Promise.race([
		once(child.stdout, "data"),
		exit.then(() => {
			throw new Error("Synthetic lease owner exited before readiness");
		}),
	]);
	try {
		assert.match((await f.transition.preview(f.legacy)).reason!, /storage_busy_or_unavailable/);
	} finally {
		child.stdin.end();
		await exit;
	}
	assert.equal((await f.transition.preview(f.legacy)).state, "ready");
	await rm(file);
	assert.match((await f.transition.preview(f.legacy)).reason!, /storage_busy_or_unavailable/);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_transfers")!.n, 0);
});

test("stale Stop and lineage confirmations reject before any entered marker or cancellation", async (t) => {
	const f = await fixture(t),
		{ op, payload } = await f.prepare();
	await f.sessions.stop(f.legacy.reportSessionId);
	assert.equal((await f.run(op)).state, "rejected");
	const changed = structuredClone(payload);
	changed.owner.expectedHome.lineageId = "foreign";
	assert.equal((await f.run(f.operation(op.kind, changed, op.targetId))).state, "rejected");
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_transfers")!.n, 0);
	assert.equal(f.schedules.store.require(payload.rules[0]!.id).state, "pending");
});

test("transfer confirmation requires its live admission epoch, not persistent daemon IDs", async (t) => {
	const f = await fixture(t),
		{ op, payload } = await f.prepare();
	Object.defineProperty(f.sessions, "insightsAdmissionEpoch", { value: randomUUID() });
	assert.equal((await f.run(op)).state, "rejected");
	assert.equal(f.schedules.store.require(payload.rules[0]!.id).state, "pending");
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_transfers")!.n, 0);
});

test("a reserved operation without an entered transfer never reconstructs native consent on recovery", async (t) => {
	const f = await fixture(t),
		{ op, payload } = await f.prepare();
	assert.equal(
		(
			await f.journal.execute(op, async () => {
				throw new Error("Synthetic crash before handler entry");
			})
		).state,
		"pending",
	);
	await f.journal.recover((op) => f.transition.admit(op, false));
	assert.equal((await f.journal.lookup(op))!.state, "rejected");
	assert.equal(f.schedules.store.require(payload.rules[0]!.id).state, "pending");
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_transfers")!.n, 0);
});

for (const committed of [false, true])
	test(`cold transfer ${committed ? "receipt" : "entered cancellation"} remains exact and never resumes effects`, async (t) => {
		const f = await fixture(t),
			{ op, payload } = await f.prepare();
		if (!committed) {
			const cancel = f.schedules.cancelLegacyForTransfer.bind(f.schedules);
			t.mock.method(f.schedules, "cancelLegacyForTransfer", async (...args: Parameters<typeof cancel>) => {
				await cancel(...args);
				throw new Error("Synthetic lost cancellation ACK");
			});
		}
		assert.equal((await f.run(op)).state, committed ? "accepted" : "pending");
		await f.close();
		const store = new MissionStore(join(f.home, "missions.sqlite"));
		// Register the cold manager with the owning fixture, so shutdown precedes root deletion.
		const sessions = await f.manager();
		new MissionService(store, sessions, f.projects);
		assert.notEqual(sessions.insightsAdmissionEpoch, JSON.parse(op.payload).admissionEpoch);
		const scheduleStore = new ScheduleStore(join(f.home, "schedules.sqlite"));
		const schedules = new ScheduleService(scheduleStore, {
			sessions,
			projects: f.projects,
			missions: store,
			home: host,
			automationsEnabled: () => false,
		});
		await schedules.load();
		t.after(async () => {
			await sessions.shutdown();
			await schedules.stop();
			await scheduleStore.close();
			await store.close();
		});
		const journal = new OperationJournal(join(f.home, "operations"), host);
		const transition = new InsightsTransition({
			home: f.home,
			projects: f.projects,
			mission: (id) => {
				const m = store.require(id);
				return { projectId: m.projectId, status: m.status };
			},
			workspace: store.insightsWorkspace,
			store: store.insightsTransition,
			journal,
			sessions,
			schedules,
		});
		const before = schedules.store.require(payload.rules[0]!.id);
		assert.equal((await transition.check(op)).transfer.state, committed ? "committed" : "entered");
		await journal.recover((op) => transition.admit(op, false));
		assert.equal(
			(await journal.execute(op, (op, entry) => transition.admit(op, entry.firstEntry))).state,
			committed ? "accepted" : "pending",
		);
		assert.deepEqual(schedules.store.require(before.id), before);
		assert.throws(() => sessions.insightsReplacementTarget(f.legacy.reportSessionId.toUpperCase()), /fenced/);
		assert.equal(store["one"]("SELECT COUNT(*) n FROM insights_workspace_items")!.n, committed ? 1 : 0);
		assert.equal(f.specs.length, 0);
	});

test("native HTTP transfer preview, confirmation, status and Check are authenticated and passive until confirmation", async (t) => {
	const f = await fixture(t);
	const args: Parameters<typeof createDaemonServer> = [
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		f.models,
		new TerminalManager(),
		{ service: f.service, store: f.store },
	];
	args[8] = f.schedules;
	args[12] = {
		...host,
		daemonVersion: "synthetic",
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		platform: "darwin",
		arch: "arm64",
		capabilities: {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: false,
			coordinatorIsolation: true,
			independentExecution: true,
		},
	};
	args[17] = {
		authenticate: async (token: unknown) => {
			if (token !== "native") throw new Conflict("Native confirmation required");
		},
	} as NonNullable<(typeof args)[17]>;
	const server = createDaemonServer(...args);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const previewPath = `insights/workspace/transfer/preflight?selector=${encodeURIComponent(JSON.stringify(f.legacy))}`;
	const headers = { "x-pilot-github-capability": "native" };
	const hello = await (await fetch(`${root}/hello`)).json();
	assert.equal(hello.capabilities.insightsWorkspace, 2);
	assert.equal(hello.capabilities.insightsWorkspaceExecution, 2);
	assert.equal(hello.capabilities.insightsWorkspaceTransition, 2);
	assert.notEqual((await fetch(`${root}/${previewPath}`)).status, 200);
	const response = await fetch(`${root}/${previewPath}`, { headers });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	const preview = await response.json();
	assert.equal(preview.state, "ready", JSON.stringify(preview));
	const op = f.operation("insights-workspace-transfer", preview.payload, preview.payload.owner.workspaceId);
	const post = (path: string, body: unknown, native = true) =>
		fetch(`${root}/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(native ? headers : {}) },
			body: JSON.stringify(body),
		});
	assert.equal(f.specs.length, 0);
	assert.notEqual((await post("operations", op, false)).status, 200);
	assert.notEqual((await post("operations/receipt", op, false)).status, 200);
	assert.notEqual((await post("insights/workspace/transfer/check", op, false)).status, 200);
	assert.equal((await (await post("insights/workspace/transfer/check", op)).json()).transfer.state, "absent");
	const receipt = await (await post("operations", op)).json();
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	const check = await (await post("insights/workspace/transfer/check", op)).json();
	assert.equal(check.receipt.state, "accepted");
	assert.equal(check.transfer.state, "committed");
	assert.equal(check.transfer.result.activation, "not_activated");
	assert.equal(
		(await (await fetch(`${root}/insights/workspace/execution`, { headers })).json()).state,
		"not_activated",
	);
	assert.equal(f.specs.length, 0);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import type { DurableOperation, InsightsWorkspaceReservePayload, ModelOption } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { parseInsightsBacklog } from "./insights-backlog.ts";
import { InsightsWorkspace, type InsightsWorkspaceDependencies } from "./insights-workspace.ts";
import type { InsightsWorkspaceAdmission, InsightsWorkspaceAuthority } from "./insights-workspace-store.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import type { ModelCatalog } from "./models.ts";
import { OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

const host = { hostId: "daemon", daemonId: "synthetic", lineageId: "synthetic-lineage" };
const model: ModelOption = {
	id: "synthetic/terra",
	provider: "synthetic",
	name: "Terra 6.1",
	thinkingLevels: ["low", "high"],
};
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
async function fixture(t: TestContext) {
	const cleanup: Array<() => Promise<void>> = [];
	const root = await mkdtemp(join(tmpdir(), "insights-workspace-"));
	const home = join(root, "home"),
		path = join(root, "project");
	await mkdir(path);
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path });
	const file = join(home, "missions.sqlite");
	let missions = new MissionStore(file);
	let journal = new OperationJournal(join(home, "operations"), host);
	let catalog = [model],
		catalogCalls = 0,
		legacy = false;
	const models = {
		list: async (cwd: string) => {
			assert.equal(cwd, projects.require(project.id).path);
			catalogCalls++;
			return { models: catalog };
		},
	} as Pick<ModelCatalog, "list">;
	const deps = (): InsightsWorkspaceDependencies => ({
		home,
		host,
		projects,
		models,
		store: missions.insightsWorkspace,
		journal,
		legacyGuard: () => {
			if (legacy) throw new Conflict("legacy_transition_required");
		},
	});
	let workspace = new InsightsWorkspace(deps());
	let sequence = 0;
	const operation = (kind: string, payload: unknown, targetId: string): DurableOperation => {
		const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: "native-fixture",
			sequence: ++sequence,
			origin: { ...host, hostId: "local" },
			destination: { ...host, hostId: "local" },
			kind,
			targetId,
			payload: raw,
			payloadHash: payloadHash(raw),
		};
	};
	const intent = async () => {
		const preview = await workspace.preflight(project.id);
		assert.equal(preview.state, "ready");
		assert.ok(preview.payload);
		return operation("insights-workspace-reserve", preview.payload, preview.payload.owner.workspaceId);
	};
	const run = (op: DurableOperation, service = workspace) => journal.execute(op, (op) => service.admit(op));
	const lease = (op: DurableOperation): InsightsWorkspaceAdmission => {
		const p = JSON.parse(op.payload) as InsightsWorkspaceReservePayload;
		const authority: InsightsWorkspaceAuthority = { owner: p.owner, home, projectPath: project.path };
		return {
			authority,
			revision: missions.insightsWorkspace.current(authority)!.revision,
			revalidate: () => {
				assert.equal(projects.require(project.id).path, authority.projectPath);
			},
		};
	};
	t.after(async () => {
		for (const close of cleanup.reverse()) await close();
		await missions.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
	});
	return {
		cleanup: (close: () => Promise<void>) => cleanup.push(close),
		root,
		home,
		project,
		projects,
		models,
		operation,
		intent,
		run,
		lease,
		deps,
		get missions() {
			return missions;
		},
		get journal() {
			return journal;
		},
		get workspace() {
			return workspace;
		},
		get catalogCalls() {
			return catalogCalls;
		},
		setCatalog: (value: ModelOption[]) => {
			catalog = value;
		},
		legacy: () => {
			legacy = true;
		},
		reopen: async () => {
			await missions.close();
			missions = new MissionStore(file);
			journal = new OperationJournal(join(home, "operations"), host);
			workspace = new InsightsWorkspace(deps());
		},
	};
}
function finding(key = randomUUID(), operationId = randomUUID()) {
	return {
		action: "propose",
		key,
		expectedRevision: 0,
		operationId,
		patternKey: "tools repeated work",
		draft: {
			title: "Repeated tools",
			priority: "medium",
			observation: "Observed repeated reads",
			uncertainty: "Unknown baseline",
			proposedChange: "Review tool use",
			expectedBenefit: "Less repeated work",
			targets: [],
			implementationLinks: [],
		},
		evidence: [],
	};
}

test("passive workspace reads create nothing and require explicit execution context", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.workspace.status()).state, "absent");
	assert.equal((await f.workspace.page("finding", 0)).state, "unavailable");
	assert.equal((await f.workspace.preflight()).reason, "execution_project_required");
	assert.equal(f.catalogCalls, 0);
	await assert.rejects(readdir(join(f.home, "operations")), { code: "ENOENT" });
	const preview = await f.workspace.preflight(f.project.id);
	assert.equal(preview.state, "ready");
	assert.equal(f.catalogCalls, 1);
	assert.equal((await f.workspace.status()).state, "absent");
	f.setCatalog([]);
	assert.equal((await f.workspace.preflight(f.project.id)).reason, "model_unavailable");
	f.setCatalog([model, { ...model, id: "other/terra" }]);
	assert.equal((await f.workspace.preflight(f.project.id)).reason, "model_ambiguous");
	assert.equal((await f.workspace.preflight(f.project.id, model.id)).state, "ready");
});

test("concurrent windows reserve one owner and exact report/rule, restart preserves bytes", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	const other = f.operation(op.kind, op.payload, op.targetId);
	const outcomes = await Promise.all([f.run(op), f.run(other, new InsightsWorkspace(f.deps()))]);
	assert.deepEqual(outcomes.map((r) => r.state).sort(), ["accepted", "rejected"]);
	const winner = outcomes[0]!.state === "accepted" ? op : other;
	const accepted = outcomes.find((r) => r.state === "accepted")!;
	assert.equal((accepted.result as { activation: string }).activation, "not_activated");
	const before = await readFile(join(f.home, "operations", `${payloadHash(winner.operationId)}.json`));
	await f.reopen();
	assert.deepEqual(await f.run(winner), accepted);
	assert.deepEqual(await readFile(join(f.home, "operations", `${payloadHash(winner.operationId)}.json`)), before);
	assert.equal((await f.workspace.status()).workspace?.owner.workspaceId, winner.targetId);
	assert.throws(() => f.workspace.assertLegacyAllowed(), /app_owned_workspace_reserved/);
	const db = new DatabaseSync(join(f.home, "missions.sqlite"));
	try {
		assert.equal(
			db.prepare("SELECT envelope FROM insights_workspace_owners").get()!.envelope,
			JSON.stringify(winner),
		);
	} finally {
		db.close();
	}
});

test("held durability reserves synchronously and withholds ACK; stale absent reads refuse", async (t) => {
	const f = await fixture(t),
		op = await f.intent(),
		lease = f.lease;
	const a = {
		home: f.home,
		projectPath: f.project.path,
		owner: (JSON.parse(op.payload) as InsightsWorkspaceReservePayload).owner,
	};
	const wait = gate();
	const durable = f.missions.durable.bind(f.missions);
	const mock = t.mock.method(f.missions, "durable", () => wait.promise.then(durable));
	t.after(wait.release);
	const oldRead = f.missions.insightsWorkspace.read(f.home, () => {});
	let ack = false;
	const write = f.missions.insightsWorkspace
		.reserve(a, op, model.id, () => {})
		.then(() => {
			ack = true;
		});
	assert.equal(f.missions.insightsWorkspace.current(a)?.revision, 1);
	assert.equal(ack, false);
	wait.release();
	await assert.rejects(oldRead, /changed_during_read/);
	await write;
	assert.equal(ack, true);
	mock.mock.restore();
	assert.equal(lease(op).revision, 1);
});

test("owner records are independent of mission lifecycle and preserve original UTF-8 request bytes", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	await f.run(op);
	const x = finding();
	x.draft.title = "Évidence 日 🐦";
	const raw = ` ${JSON.stringify(x, null, 2)}\n`;
	const store = f.missions.insightsWorkspace,
		lease = f.lease(op);
	const receipt = await store.write(lease, raw);
	assert.deepEqual(await store.write(lease, raw), receipt);
	await assert.rejects(store.write(lease, JSON.stringify(x)), /bytes_changed/);
	const mission = f.missions.create({ title: "Ordinary", projectId: f.project.id });
	assert.equal(f.missions.detail(mission.id).tasks.length, 0);
	assert.throws(() => f.missions.updateTask(mission.id, x.key, { title: "Not a task" }));
	assert.throws(() => f.missions.removeTask(mission.id, x.key));
	f.missions.update(mission.id, { status: "archived" });
	f.missions.remove(mission.id);
	assert.equal(f.missions.list().length, 0);
	assert.equal((await store.item(lease, "finding", x.key)).request, raw);
	await f.reopen();
	assert.equal((await f.missions.insightsWorkspace.item(f.lease(op), "finding", x.key)).request, raw);
	assert.equal((await f.workspace.page("finding", 0)).items[0]!.title, x.draft.title);
});

test("cross-owner writes and changed profile/project/lineage refuse without rebinding", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	await f.run(op);
	const lease = f.lease(op);
	await assert.rejects(
		f.missions.insightsWorkspace.write(
			{
				...lease,
				authority: { ...lease.authority, owner: { ...lease.authority.owner, workspaceId: randomUUID() } },
			},
			JSON.stringify(finding()),
		),
		/identity_changed/,
	);
	const foreign = new InsightsWorkspace({ ...f.deps(), host: { ...host, lineageId: "changed" } });
	assert.equal((await foreign.status()).state, "blocked");
	assert.equal((await foreign.page("finding", 0)).state, "unavailable");
	const copied = new InsightsWorkspace({ ...f.deps(), home: join(f.root, "copied-home") });
	assert.equal((await copied.status()).reason, "workspace_foreign_profile");
	await mkdir(join(f.root, "moved"));
	await f.projects.update(f.project.id, { path: join(f.root, "moved") });
	assert.equal((await f.workspace.status()).state, "blocked");
	assert.equal((await f.workspace.preflight(f.project.id)).payload, null);
});

test("bounded lists and unavailable lists remain distinct", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	await f.run(op);
	for (let i = 0; i < 23; i++) {
		const x = finding();
		x.patternKey = `pattern ${i}`;
		await f.missions.insightsWorkspace.write(f.lease(op), JSON.stringify(x));
	}
	const page = await f.workspace.page("finding", 0);
	assert.equal(page.state, "available");
	assert.equal(page.items.length, 20);
	assert.ok(page.nextCursor);
	const last = await f.workspace.page("finding", page.nextCursor);
	assert.equal(last.items.length, 3);
	assert.equal(last.nextCursor, null);
	t.mock.method(f.missions, "durable", async () => {
		throw new Error("Synthetic unavailable disk");
	});
	assert.deepEqual((await f.workspace.page("finding", 0)).items, []);
	assert.equal((await f.workspace.page("finding", 0)).state, "unavailable");
});

test("legacy journal reservations fence new UUIDs and preserve immutable v1 bytes/receipts", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	const old = f.operation(
		"insights-create",
		` {"projectId":"old","missionId":"backlog","model":"old/model","disclosure":"insights-history-v1"}\n`,
		randomUUID(),
	);
	const receipt = await f.journal.execute(old, async () => ({ sessionId: old.targetId }));
	const bytes = await readFile(join(f.home, "operations", `${payloadHash(old.operationId)}.json`));
	assert.equal((await f.workspace.preflight(f.project.id)).reason, "legacy_transition_required");
	assert.equal((await f.run(op)).state, "rejected");
	await f.reopen();
	assert.deepEqual(await f.journal.lookup(old), receipt);
	assert.deepEqual(await readFile(join(f.home, "operations", `${payloadHash(old.operationId)}.json`)), bytes);
	assert.equal((await f.workspace.status()).state, "blocked");
});

test("a retained guard sees legacy reservation before its filesystem publication finishes", async (t) => {
	const f = await fixture(t);
	const guard = await f.journal.legacyInsightsGuard();
	guard();
	const journal = f.journal as unknown as { persist(file: string, value: unknown): Promise<void> };
	const persist = journal.persist.bind(journal),
		wait = gate(),
		entered = gate();
	t.mock.method(journal, "persist", async (file: string, value: unknown) => {
		entered.release();
		await wait.promise;
		await persist(file, value);
	});
	t.after(wait.release);
	const old = f.operation("insights-create", { projectId: "old", missionId: "old" }, randomUUID());
	const pending = f.journal.reserve(old);
	await entered.promise;
	assert.throws(guard, /journal_busy_refresh/);
	wait.release();
	await pending;
	assert.throws(guard, /legacy_transition_required/);
});

test("v2 strict payloads do not extend the original closed backlog parser", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	for (const patch of [
		{ schemaVersion: 1 },
		{ missionId: "fake-hidden-mission" },
		{ disclosure: "insights-weekly-v1" },
	]) {
		const p = { ...JSON.parse(op.payload), ...patch };
		assert.equal((await f.run(f.operation(op.kind, p, op.targetId))).state, "rejected");
	}
	assert.throws(() => parseInsightsBacklog({ ...finding(), workspaceId: op.targetId }), /Unknown Insights field/);
	assert.deepEqual(parseInsightsBacklog(finding()).action, "propose");
	assert.equal((await f.run(op)).state, "accepted");
});

test("native lifecycle/settings/pause/revoke are scoped CAS actions and never executable tasks", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	await f.run(op);
	const owner = (JSON.parse(op.payload) as InsightsWorkspaceReservePayload).owner;
	const x = finding();
	await f.missions.insightsWorkspace.write(f.lease(op), JSON.stringify(x));
	const change = (lifecycle: string, expectedRevision: number) =>
		f.operation(
			"insights-workspace-lifecycle",
			{ schemaVersion: 2, owner, key: x.key, expectedRevision, lifecycle },
			owner.workspaceId,
		);
	assert.equal((await f.run(change("verified", 1))).state, "rejected");
	assert.equal((await f.run(change("approved", 1))).state, "accepted");
	assert.equal((await f.run(change("shipped", 2))).state, "accepted");
	assert.equal((await f.run(change("verified", 3))).state, "accepted");
	const settings = (await f.workspace.settings()).record!;
	settings.settings.budget.usd = 7;
	const save = f.operation(
		"insights-workspace-settings",
		{ schemaVersion: 2, owner, expectedRevision: settings.revision, settings: settings.settings },
		owner.workspaceId,
	);
	assert.equal((await f.run(save)).state, "accepted");
	assert.equal((await f.workspace.settings()).record!.revision, 2);
	const pause = f.operation(
		"insights-workspace-state",
		{ schemaVersion: 2, owner, expectedRevision: 1, state: "paused" },
		owner.workspaceId,
	);
	assert.equal((await f.run(pause)).state, "accepted");
	await assert.rejects(
		f.missions.insightsWorkspace.write(f.lease(op), JSON.stringify(finding())),
		/authority_changed/,
	);
	const revoke = f.operation(
		"insights-workspace-state",
		{ schemaVersion: 2, owner, expectedRevision: 2, state: "revoked" },
		owner.workspaceId,
	);
	assert.equal((await f.run(revoke)).state, "accepted");
	assert.equal((await f.workspace.page("finding", 0)).items.length, 1);
	assert.equal(f.missions.list().length, 0);
});

test("lost reservation ACK recovers only its exact receipt without catalog work or duplicates", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	const reserve = f.missions.insightsWorkspace.reserve.bind(f.missions.insightsWorkspace);
	const lost = t.mock.method(f.missions.insightsWorkspace, "reserve", async (...args: Parameters<typeof reserve>) => {
		await reserve(...args);
		throw new Conflict("Synthetic lost reservation ACK");
	});
	assert.equal((await f.run(op)).state, "pending");
	lost.mock.restore();
	const calls = f.catalogCalls;
	await f.reopen();
	const receipt = await f.run(op);
	assert.equal(receipt.state, "accepted");
	assert.equal(f.catalogCalls, calls);
	assert.equal((await f.workspace.status()).workspace!.owner.workspaceId, op.targetId);
	assert.deepEqual(await f.journal.lookup(op), receipt);
});

test("committed writes withhold ACK after Stop lease invalidation and recover exact bytes", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	await f.run(op);
	const lease = f.lease(op);
	let stopped = false;
	const guarded = {
		...lease,
		revalidate: () => {
			if (stopped) throw new Conflict("Stopped");
		},
	};
	const wait = gate(),
		entered = gate(),
		durable = f.missions.durable.bind(f.missions);
	const mock = t.mock.method(f.missions, "durable", async () => {
		entered.release();
		await wait.promise;
		await durable();
	});
	t.after(wait.release);
	const x = finding(),
		raw = JSON.stringify(x);
	const pending = f.missions.insightsWorkspace.write(guarded, raw);
	await entered.promise;
	stopped = true;
	wait.release();
	await assert.rejects(pending, /Stopped/);
	mock.mock.restore();
	const receipt = await f.missions.insightsWorkspace.writeReceipt(lease, x.operationId, raw);
	assert.equal(receipt.state, "committed");
	assert.equal((await f.missions.insightsWorkspace.writeReceipt(lease, "missing", raw)).state, "unknown");
	assert.equal((await f.missions.insightsWorkspace.item(lease, "finding", x.key)).revision, 1);
});

test("reports/checkpoints survive restart as partial claims with explicit stream gaps", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	await f.run(op);
	const point = {
		sessionId: randomUUID(),
		streamId: null,
		before: null,
		after: null,
		throughEntry: null,
		coverage: "unavailable",
		gaps: ["Unavailable synthetic source"],
	};
	const request = {
		action: "save_checkpoint",
		key: randomUUID(),
		operationId: randomUUID(),
		expectedRevision: 0,
		record: {
			status: "partial",
			windowStart: "2026-01-01T00:00:00Z",
			windowEnd: "2026-01-02T00:00:00Z",
			markdown: "Partial sample",
			checkpoints: [point],
			findingKeys: [],
			gaps: ["Source unavailable"],
		},
	};
	await f.missions.insightsWorkspace.write(f.lease(op), JSON.stringify(request));
	const report = { ...request, action: "save_report", key: randomUUID(), operationId: randomUUID() };
	await f.missions.insightsWorkspace.write(f.lease(op), JSON.stringify(report));
	await assert.rejects(
		f.missions.insightsWorkspace.write(
			f.lease(op),
			JSON.stringify({
				...report,
				key: randomUUID(),
				operationId: randomUUID(),
				record: { ...report.record, status: "completed" },
			}),
		),
		/partial claims/,
	);
	await assert.rejects(
		f.missions.insightsWorkspace.write(
			f.lease(op),
			JSON.stringify({
				...request,
				key: randomUUID(),
				operationId: randomUUID(),
				record: { ...request.record, checkpoints: [{ ...point, gaps: [] }] },
			}),
		),
		/requires a gap/,
	);
	await f.reopen();
	assert.equal((await f.workspace.page("report", 0)).items.length, 1);
	assert.equal(
		(await f.missions.insightsWorkspace.item(f.lease(op), "checkpoint", request.key)).request,
		JSON.stringify(request),
	);
});

test("immutable history keeps evidence, patterns and user-confirmed scope", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	await f.run(op);
	const x = {
		...finding(),
		evidence: [
			{
				key: randomUUID(),
				sessionId: randomUUID(),
				ref: "entry:1",
				observedAt: "2026-01-01T00:00:00Z",
				classification: "observed",
				summary: "Synthetic evidence",
			},
		],
	};
	const store = f.missions.insightsWorkspace,
		lease = f.lease(op);
	const raw = JSON.stringify(x);
	await store.write(lease, raw);
	await assert.rejects(
		store.write(lease, JSON.stringify({ ...finding(), patternKey: x.patternKey })),
		/pattern_already_recorded/,
	);
	const amend = {
		...x,
		action: "amend",
		operationId: randomUUID(),
		expectedRevision: 1,
		evidence: [{ ...x.evidence[0], summary: "Changed evidence" }],
	};
	await assert.rejects(store.write(lease, JSON.stringify(amend)), /immutable/);
	const approved = f.operation(
		"insights-workspace-lifecycle",
		{ schemaVersion: 2, owner: lease.authority.owner, expectedRevision: 1, key: x.key, lifecycle: "approved" },
		op.targetId,
	);
	assert.equal((await f.run(approved)).state, "accepted");
	await assert.rejects(
		store.write(
			lease,
			JSON.stringify({
				...x,
				action: "amend",
				operationId: randomUUID(),
				expectedRevision: 2,
				draft: { ...x.draft, title: "Changed scope" },
			}),
		),
		/scope is frozen/,
	);
	const history = await store.history(lease, "finding", x.key);
	assert.equal(history.items.length, 2);
	assert.equal(history.items[0]!.request, raw);
	assert.equal(history.items[1]!.lifecycle, "approved");
	assert.equal(history.nextCursor, null);
});

test("pause during an asynchronous scoped model read refuses the stale desired save", async (t) => {
	const f = await fixture(t),
		reserve = await f.intent();
	await f.run(reserve);
	const owner = (JSON.parse(reserve.payload) as InsightsWorkspaceReservePayload).owner;
	const record = (await f.workspace.settings()).record!;
	const wait = gate(),
		entered = gate();
	t.after(wait.release);
	t.mock.method(f.models, "list", async () => {
		entered.release();
		await wait.promise;
		return { models: [model] };
	});
	const save = f.operation(
		"insights-workspace-settings",
		{ schemaVersion: 2, owner, expectedRevision: record.revision, settings: record.settings },
		owner.workspaceId,
	);
	const pending = f.run(save);
	await entered.promise;
	const pause = f.operation(
		"insights-workspace-state",
		{ schemaVersion: 2, owner, expectedRevision: 1, state: "paused" },
		owner.workspaceId,
	);
	assert.equal((await f.run(pause)).state, "accepted");
	wait.release();
	assert.equal((await pending).state, "rejected");
	assert.equal((await f.workspace.settings()).record!.revision, 1);
});

test("legacy metadata fences fresh reservation before any owner is created", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	f.legacy();
	assert.equal((await f.run(op)).state, "rejected");
	assert.equal((await f.workspace.status()).state, "blocked");
	assert.equal(f.missions.insightsWorkspace.hasOwner(f.home), false);
});

test("native HTTP routes are passive, capability-gated and never wake source/report workers", async (t) => {
	const f = await fixture(t);
	const sourceId = randomUUID(),
		sourceDir = join(f.home, "sessions", sourceId);
	await mkdir(sourceDir, { recursive: true });
	await writeFile(
		join(sourceDir, "meta.json"),
		JSON.stringify({
			id: sourceId,
			title: "Synthetic source",
			cwd: f.project.path,
			projectId: f.project.id,
			mode: "ask",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	let starts = 0;
	const sessions = new SessionManager(
		f.home,
		f.projects,
		undefined,
		{
			worker: () => {
				starts++;
				throw new Error("No workers permitted");
			},
		},
		{},
		{ diagnosticHost: host },
	);
	const service = new MissionService(f.missions, sessions, f.projects);
	await sessions.load();
	const sourceBytes = await readFile(join(sourceDir, "meta.json"));
	const scheduleStore = new ScheduleStore(join(f.home, "schedules.sqlite"));
	const schedules = new ScheduleService(scheduleStore, {
		sessions,
		projects: f.projects,
		missions: f.missions,
		home: host,
		automationsEnabled: () => false,
	});
	await schedules.load();
	f.cleanup(async () => {
		await sessions.shutdown();
		await schedules.stop();
		await scheduleStore.close();
	});
	const args: Parameters<typeof createDaemonServer> = [
		{ home: f.home, host: "127.0.0.1", port: 0 },
		sessions,
		f.projects,
		f.models as ModelCatalog,
		new TerminalManager(),
		{ store: f.missions, service },
	];
	args[8] = schedules;
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
	f.cleanup(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	assert.equal((await (await fetch(`${root}/hello`)).json()).capabilities.insightsWorkspace, 2);
	for (const path of ["", "/findings", "/reports", "/preflight"]) {
		const response = await fetch(`${root}/insights/workspace${path}`);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.status, 200);
	}
	const preview = await (await fetch(`${root}/insights/workspace/preflight?projectId=${f.project.id}`)).json();
	assert.equal(preview.state, "ready", JSON.stringify(preview));
	assert.equal(sessions.list().length, 1);
	assert.equal(schedules.list().length, 0);
	assert.equal((await fetch(`${root}/insights/workspace?missionId=forged`)).status, 400);
	assert.equal((await fetch(`${root}/insights/workspace`, { method: "POST" })).status, 405);
	const op = f.operation("insights-workspace-reserve", preview.payload, preview.payload.owner.workspaceId);
	const post = (native: boolean, path = "operations", intent = op) =>
		fetch(`${root}/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(native ? { "x-pilot-github-capability": "native" } : {}) },
			body: JSON.stringify(intent),
		});
	assert.notEqual((await post(false)).status, 200);
	assert.equal((await (await post(false, "operations/receipt")).json()).state, "unknown");
	assert.equal((await (await post(true)).json()).state, "accepted");
	const old = f.operation(
		"insights-create",
		{ projectId: f.project.id, missionId: "forged", model: model.id, disclosure: "insights-history-v1" },
		randomUUID(),
	);
	assert.equal((await post(true, "operations", old)).status, 409);
	assert.equal(starts, 0);
	assert.equal(sessions.list().length, 1);
	assert.deepEqual(await readFile(join(sourceDir, "meta.json")), sourceBytes);
	assert.equal(schedules.list().length, 0);
});

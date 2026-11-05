// biome-ignore-all lint/complexity/useLiteralKeys: Synthetic failure injection checks private admission fences.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
	DurableOperation,
	InsightsReplacementPayload,
	InsightsReplacementProgress,
	ModelOption,
} from "@pilot/protocol";
import { InsightsEnable } from "./insights-enable.ts";
import { InsightsReplacement } from "./insights-replacement.ts";
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

const host = { hostId: "daemon", daemonId: "synthetic", lineageId: "replacement-fixture" };
const model: ModelOption = {
	id: "synthetic/terra",
	provider: "synthetic",
	name: "Terra 6.1",
	thinkingLevels: ["high"],
};
async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "insights-replacement-"));
	const home = join(root, "home"),
		source = join(root, "source");
	await mkdir(source);
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: source });
	let missions = new MissionStore(join(home, "missions.sqlite"));
	const mission = missions.create({ title: "Synthetic exact backlog", projectId: project.id });
	await missions.durable();
	let catalog = [model],
		starts = 0,
		enabled = true;
	const models = { list: async () => ({ models: catalog }) } as unknown as ModelCatalog;
	let sessions!: SessionManager,
		schedules!: ScheduleService,
		scheduleStore!: ScheduleStore,
		journal!: OperationJournal;
	let enable!: InsightsEnable, replacement!: InsightsReplacement, service!: MissionService;
	const open = async () => {
		sessions = new SessionManager(
			home,
			projects,
			undefined,
			{
				worker: () => {
					starts++;
					throw new Error("Provider/worker input forbidden");
				},
			},
			{},
			{ diagnosticHost: { ...host } },
		);
		service = new MissionService(missions, sessions, projects);
		await sessions.load();
		scheduleStore = new ScheduleStore(join(home, "schedules.sqlite"));
		schedules = new ScheduleService(scheduleStore, {
			sessions,
			projects,
			missions,
			home: host,
			automationsEnabled: () => enabled,
			clock: { now: () => Date.parse("2026-03-27T17:00:00Z"), setTimeout: () => () => {} },
		});
		await schedules.load();
		journal = new OperationJournal(join(home, "operations"), host);
		const deps = {
			home,
			host,
			projects,
			missions,
			models,
			sessions,
			schedules,
			journal,
			now: () => Date.parse("2026-03-27T17:00:00Z"),
		};
		enable = new InsightsEnable(deps);
		replacement = new InsightsReplacement(deps);
	};
	await open();
	const close = async () => {
		await schedules.stop();
		await scheduleStore.close();
		await sessions.shutdown();
		await missions.close();
	};
	t.after(async () => {
		await close();
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
	});
	let seq = 0;
	const operation = (kind: string, targetId: string, payload: unknown): DurableOperation => {
		const bytes = JSON.stringify(payload);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: "synthetic-native",
			sequence: ++seq,
			origin: { ...host, hostId: "local" },
			destination: { ...host, hostId: "local" },
			kind,
			targetId,
			payload: bytes,
			payloadHash: payloadHash(bytes),
		};
	};
	const initial = await enable.preflight(project.id, mission.id);
	assert.equal(initial.state, "ready");
	assert.ok(initial.payload);
	const oldOp = operation("insights-enable", initial.targetId, initial.payload);
	assert.equal((await journal.execute(oldOp, (op) => enable.enable(op, JSON.parse(op.payload)))).state, "accepted");
	const oldId = oldOp.targetId,
		oldRule = schedules.list()[0]!;
	return {
		home,
		projects,
		project,
		mission,
		models,
		oldOp,
		oldId,
		oldRule,
		operation,
		get missions() {
			return missions;
		},
		get sessions() {
			return sessions;
		},
		get schedules() {
			return schedules;
		},
		get journal() {
			return journal;
		},
		get replacement() {
			return replacement;
		},
		get enable() {
			return enable;
		},
		get service() {
			return service;
		},
		get scheduleStore() {
			return scheduleStore;
		},
		get starts() {
			return starts;
		},
		disable() {
			enabled = false;
		},
		setModels(value: ModelOption[]) {
			catalog = value;
		},
		async deleteOld() {
			// User-reported filesystem deletion, not a supported deletion API.
			sessions["metas"].delete(oldId);
			await rm(join(home, "sessions", oldId), { recursive: true });
		},
		preview: () => replacement.preview(project.id, mission.id, oldId),
		async intent() {
			const p = await replacement.preview(project.id, mission.id, oldId);
			assert.equal(p.state, "ready", JSON.stringify(p));
			assert.ok(p.payload);
			return operation("insights-replace", p.payload.successorSessionId, p.payload);
		},
		run: (op: DurableOperation) => journal.execute(op, (op) => replacement.replace(op, JSON.parse(op.payload))),
		async reopen() {
			await close();
			missions = new MissionStore(join(home, "missions.sqlite"));
			await open();
		},
	};
}

test("confirmed deleted report replacement fences old identities and preserves receipts across restart", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.preview()).reason, "old_report_present");
	await f.deleteOld();
	const p = await f.preview();
	assert.equal(p.state, "ready");
	assert.ok(p.payload);
	assert.equal(p.rules[0]!.disposition, "cancel");
	assert.equal(p.rules[0]!.revision, f.oldRule.revision);
	assert.equal(p.cost.spendUsd, null);
	assert.equal(p.nextAt, Date.parse("2026-04-03T16:00:00Z"));
	assert.equal((await f.enable.preflight(f.project.id, f.mission.id)).reason, "report_identity_unavailable");
	const op = await f.intent();
	const [a, b] = await Promise.all([f.run(op), f.run(op)]);
	assert.equal(a.state, "accepted", JSON.stringify(a));
	assert.deepEqual(a, b);
	const progress = a.result as InsightsReplacementProgress;
	assert.equal(progress.phase, "replaced");
	assert.equal(progress.oldSessionId, f.oldId);
	assert.notEqual(op.targetId, f.oldId);
	assert.equal(f.schedules.list().length, 2);
	assert.equal(f.schedules.list().find((r) => r.id === f.oldRule.id)!.state, "cancelled");
	assert.equal(f.sessions.get(op.targetId)?.working, false);
	assert.equal(f.starts, 0);
	assert.deepEqual(await f.journal.lookup(f.oldOp), { ...(await f.journal.lookup(f.oldOp))!, state: "accepted" });
	assert.equal((await f.replacement.status(op)).state, "replaced");
	assert.equal((await f.enable.preflight(f.project.id, f.mission.id)).targetId, op.targetId);
	assert.equal((await f.enable.preflight(f.project.id, f.mission.id)).state, "existing");
	assert.equal(
		(await f.enable.preflight(f.project.id, f.mission.id, undefined, undefined, undefined, f.oldId)).reason,
		"report_superseded_use_replacement_status",
	);
	await assert.rejects(
		f.sessions.spawnInsightsDurable(
			{ projectId: f.project.id, missionId: f.mission.id, model: model.id, message: "no" },
			f.oldId,
			randomUUID(),
			true,
		),
		/fenced/,
	);
	await f.reopen();
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal((await f.preview()).state, "replaced");
	assert.equal((await f.replacement.status(op)).state, "replaced");
	assert.equal(f.schedules.list().length, 2);
	assert.equal(f.starts, 0);
});

test("missing index is unavailable, never deletion proof; preview reads do not settle or grant", async (t) => {
	const f = await fixture(t);
	const oldReceipt = await f.journal.lookup(f.oldOp);
	f.sessions["metas"].delete(f.oldId);
	assert.equal((await f.preview()).reason, "old_storage_present_or_unavailable");
	assert.equal((await f.preview()).payload, null);
	assert.deepEqual(await f.journal.lookup(f.oldOp), oldReceipt);
	assert.equal(f.schedules.list().length, 1);
	assert.equal(f.sessions.list().length, 0);
	assert.equal(f.starts, 0);
});

for (const kind of ["insights-create", "insights-enable", "insights-apply", "insights-settings", "chat-send"]) {
	test(`pending ${kind} refuses replacement and remains unchanged through passive reads/restart`, async (t) => {
		const f = await fixture(t);
		await f.deleteOld();
		const pending = f.operation(kind, f.oldId, { projectId: f.project.id, missionId: f.mission.id });
		const before = await f.journal.reserve(pending);
		for (let n = 0; n < 2; n++) {
			assert.equal((await f.preview()).reason, "old_operation_pending_use_receipt");
			assert.deepEqual(await f.journal.lookup(pending), before);
		}
		await f.reopen();
		assert.equal((await f.preview()).payload, null);
		assert.deepEqual(await f.journal.lookup(pending), before);
		assert.equal(f.schedules.list().length, 1);
		assert.equal(f.starts, 0);
	});
}

test("admitted creation, worker, saves and uncertain old reviews refuse without effects", async (t) => {
	const f = await fixture(t);
	const admission = f.sessions.insightsHostAdmission(f.oldId);
	await f.missions.insights.reviews.reserve(admission, {
		runId: randomUUID(),
		windowStart: "2026-03-20T17:00:00Z",
		windowEnd: "2026-03-27T17:00:00Z",
		bounds: { inventoryPages: 1, historyPages: 2, entriesPerPage: 4 },
	});
	await f.deleteOld();
	assert.equal((await f.preview()).reason, "old_review_uncertain");
	await f.missions.insights.reviews.interrupt(f.oldId, "cancelled", "Synthetic Stop; no provider started");
	for (const map of [f.sessions["saving"], f.sessions["starting"], f.sessions["changingModels"]]) {
		map.set(f.oldId, Promise.resolve() as never);
		assert.equal((await f.preview()).reason, "old_work_admitted_wait_for_quiescence");
		map.delete(f.oldId);
	}
	f.sessions["workers"].set(f.oldId, {} as never);
	assert.equal((await f.preview()).reason, "old_work_admitted_wait_for_quiescence");
	f.sessions["workers"].delete(f.oldId);
	f.sessions["diagnosticContextReads"].set(`${f.oldId}:synthetic`, new AbortController());
	assert.equal((await f.preview()).reason, "old_work_admitted_wait_for_quiescence");
	f.sessions["diagnosticContextReads"].clear();
	const key = randomUUID();
	f.sessions["durableCreateAdmissions"].set(key, {
		targetId: key,
		operationId: randomUUID(),
		insightsSetup: "synthetic",
		insightsScope: [f.project.id, f.mission.id],
		result: Promise.resolve({} as never),
	});
	assert.equal((await f.preview()).reason, "report_creation_admitted_wait_for_quiescence");
	f.sessions["durableCreateAdmissions"].delete(key);
	assert.equal((await f.preview()).state, "ready");
	assert.equal(f.starts, 0);
});

test("stale preview, rule revisions, foreign home, altered disclosure and ambiguous references refuse", async (t) => {
	const f = await fixture(t);
	await f.deleteOld();
	const op = await f.intent();
	const payload = JSON.parse(op.payload) as InsightsReplacementPayload;
	for (const changed of [
		{ ...payload, expectedHome: { ...host, hostId: "local" } },
		{ ...payload, context: "0".repeat(64) },
		{ ...payload, disclosure: "wrong" },
		{ ...payload, expectedReplacementRevision: 1 },
		{ ...payload, successorSessionId: randomUUID() },
		{ ...payload, enable: { ...payload.enable, budget: { ...payload.enable.budget, usd: 50 } } },
	]) {
		assert.equal((await f.run(f.operation("insights-replace", op.targetId, changed))).state, "rejected");
	}
	await f.scheduleStore.replace(f.oldRule, { ...f.oldRule, title: "Concurrent exact revision edit" });
	assert.equal((await f.run(op)).state, "rejected");
	assert.equal(f.missions.insights.replacements.link(f.oldId), null);
	const ambiguous = f.operation("insights-enable", randomUUID(), { projectId: f.project.id, missionId: f.mission.id });
	await f.journal.execute(ambiguous, async () => ({ synthetic: true }));
	assert.equal((await f.preview()).reason, "report_references_ambiguous");
	assert.equal(f.sessions.list().length, 0);
	assert.equal(f.schedules.list().length, 1);
	assert.equal(f.starts, 0);
});

test("unknown identity, changed local path, disabled Automations and untrusted rules refuse", async (t) => {
	const f = await fixture(t);
	await f.deleteOld();
	assert.equal(
		(await f.replacement.preview(f.project.id, f.mission.id, randomUUID())).reason,
		"old_identity_home_unqualified",
	);
	const other = f.missions.create({ title: "Other exact backlog", projectId: f.project.id });
	await f.missions.durable();
	assert.equal((await f.replacement.preview(f.project.id, other.id, f.oldId)).payload, null);
	const oldPath = f.projects.require(f.project.id).path;
	f.projects.require(f.project.id).path = `${oldPath}-moved`;
	assert.equal((await f.preview()).reason, "old_identity_home_unqualified");
	f.projects.require(f.project.id).path = oldPath;
	await f.scheduleStore.replace(f.oldRule, { ...f.oldRule, insightsEnableOperationId: undefined });
	assert.equal((await f.preview()).reason, "old_automation_untrusted_or_uncertain");
	f.disable();
	assert.equal((await f.preview()).payload, null);
	assert.equal(f.starts, 0);
});

test("concurrent confirmations reserve one successor; a fresh ID cannot bypass a pending replacement", async (t) => {
	const f = await fixture(t);
	await f.deleteOld();
	const a = await f.intent(),
		b = await f.intent();
	assert.equal(a.targetId, b.targetId);
	const outcomes = await Promise.all([f.run(a), f.run(b)]);
	assert.deepEqual(outcomes.map((r) => r.state).sort(), ["accepted", "rejected"]);
	assert.equal(f.sessions.list().length, 1);
	assert.equal(f.schedules.list().length, 2);
	assert.equal(f.starts, 0);
});

for (const effect of ["fence", "cancel", "chat", "schedule", "complete"] as const) {
	for (const placement of ["before", "after"] as const) {
		test(`lost ${effect} ACK ${placement} effect is lookup-only after restart, never duplicates`, async (t) => {
			const f = await fixture(t);
			await f.deleteOld();
			const op = await f.intent();
			let calls = 0;
			const fail = async <T>(work: () => Promise<T>) => {
				calls++;
				if (placement === "after") await work();
				throw new Error("Synthetic lost ACK");
			};
			if (effect === "fence" || effect === "complete") {
				const store = f.missions.insights.replacements,
					original = store[effect].bind(store);
				if (effect === "fence")
					t.mock.method(store, effect, (...args: Parameters<typeof store.fence>) =>
						fail(() => (original as typeof store.fence)(...args)),
					);
				else
					t.mock.method(store, effect, (...args: Parameters<typeof store.complete>) =>
						fail(() => (original as typeof store.complete)(...args)),
					);
			} else if (effect === "cancel") {
				const original = f.schedules.cancelInsights.bind(f.schedules);
				t.mock.method(f.schedules, "cancelInsights", (...args: Parameters<typeof original>) =>
					fail(() => original(...args)),
				);
			} else if (effect === "chat") {
				const original = f.sessions.spawnInsightsDurable.bind(f.sessions);
				t.mock.method(f.sessions, "spawnInsightsDurable", (...args: Parameters<typeof original>) =>
					fail(() => original(...args)),
				);
			} else {
				const original = f.schedules.createInsights.bind(f.schedules);
				t.mock.method(f.schedules, "createInsights", (...args: Parameters<typeof original>) =>
					fail(() => original(...args)),
				);
			}
			const receipt = await f.run(op);
			assert.equal(receipt.state, "pending");
			assert.equal(calls, 1);
			const before = await f.journal.lookup(op);
			for (let n = 0; n < 2; n++) await f.replacement.status(op);
			assert.deepEqual(await f.journal.lookup(op), before, "status never settles a pending receipt");
			assert.equal(calls, 1);
			await f.reopen();
			const recoveredEffect =
				effect === "fence"
					? t.mock.method(f.missions.insights.replacements, "fence")
					: effect === "cancel"
						? t.mock.method(f.schedules, "cancelInsights")
						: effect === "chat"
							? t.mock.method(f.sessions, "spawnInsightsDurable")
							: effect === "schedule"
								? t.mock.method(f.schedules, "createInsights")
								: null;
			await f.journal.recover(
				(op) => f.replacement.replace(op, JSON.parse(op.payload)),
				(op) => op.kind === "insights-replace",
			);
			const recovered = await f.journal.lookup(op);
			assert.equal(recoveredEffect?.mock.callCount() ?? 0, 0, "an entered effect is lookup-only, not invoked again");
			const completes = effect === "complete" || (placement === "after" && effect !== "cancel");
			assert.equal(recovered!.state, completes ? "accepted" : "pending", JSON.stringify(recovered));
			const chatCount = f.sessions.list().length,
				ruleCount = f.schedules.list().length;
			await f.run(op);
			await f.run(op);
			assert.equal(f.sessions.list().length, chatCount);
			assert.equal(f.schedules.list().length, ruleCount);
			assert.ok(chatCount <= 1);
			assert.ok(ruleCount <= 2);
			assert.equal(f.starts, 0);
			if (!completes) {
				assert.equal((await f.preview()).payload, null);
				const fresh = f.operation("insights-replace", op.targetId, JSON.parse(op.payload));
				assert.equal((await f.run(fresh)).state, "rejected");
			}
		});
	}
}

test("Stop after passive successor placement fences schedule admission and survives restart", async (t) => {
	const f = await fixture(t);
	await f.deleteOld();
	const op = await f.intent();
	const original = f.sessions.spawnInsightsDurable.bind(f.sessions);
	t.mock.method(f.sessions, "spawnInsightsDurable", async (...args: Parameters<typeof original>) => {
		const ack = await original(...args);
		await f.sessions.stop(op.targetId);
		return ack;
	});
	assert.equal((await f.run(op)).state, "pending");
	assert.equal((await f.replacement.status(op)).state, "blocked");
	await f.reopen();
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(f.schedules.list().length, 1);
	assert.equal(f.starts, 0);
});

test("exact old rule CAS drift after fencing refuses successor admission", async (t) => {
	const f = await fixture(t);
	await f.deleteOld();
	const op = await f.intent();
	const original = f.schedules.cancelInsights.bind(f.schedules);
	t.mock.method(f.schedules, "cancelInsights", async (...args: Parameters<typeof original>) => {
		await f.scheduleStore.replace(f.oldRule, { ...f.oldRule, paused: true });
		return original(...args);
	});
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(f.sessions.list().length, 0);
	assert.equal(f.starts, 0);
	assert.equal((await f.preview()).reason, "replacement_pending_use_status");
	await f.reopen();
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(f.schedules.list()[0]!.paused, true);
});

test("a replacement chain keeps both old IDs and qualifies only the completed current successor", async (t) => {
	const f = await fixture(t);
	await f.deleteOld();
	const first = await f.intent();
	assert.equal((await f.run(first)).state, "accepted");
	f.sessions["metas"].delete(first.targetId);
	await rm(join(f.home, "sessions", first.targetId), { recursive: true });
	const preview = await f.replacement.preview(f.project.id, f.mission.id, first.targetId);
	assert.equal(preview.state, "ready", JSON.stringify(preview));
	assert.ok(preview.payload);
	const second = f.operation("insights-replace", preview.payload.successorSessionId, preview.payload);
	assert.equal((await f.run(second)).state, "accepted");
	assert.equal(
		f.missions.insights.replacements.resolves(
			f.oldId,
			second.targetId,
			f.project.id,
			f.mission.id,
			preview.payload.context,
		),
		true,
	);
	const ordinary = await f.enable.preflight(f.project.id, f.mission.id);
	assert.equal(ordinary.state, "existing", JSON.stringify(ordinary));
	assert.equal(ordinary.targetId, second.targetId);
	assert.equal(f.schedules.list().length, 3);
	assert.equal(f.starts, 0);
});

test("reference and rule overflow are qualified refusals, never truncated admission", async (t) => {
	const f = await fixture(t);
	await f.deleteOld();
	await f.scheduleStore.replace(f.oldRule, { ...f.oldRule, state: "cancelled" });
	for (let n = 0; n < 8; n++) await f.scheduleStore.create({ ...f.oldRule, id: randomUUID(), state: "cancelled" });
	let preview = await f.preview();
	assert.equal(preview.coverage, "overflow");
	assert.equal(preview.reason, "rule_overflow");
	assert.equal(preview.rules.length, 8);
	assert.equal(preview.payload, null);
	for (let n = 0; n < 32; n++) {
		const op = f.operation("chat-send", f.oldId, { synthetic: true });
		await f.journal.execute(op, async () => ({ synthetic: true }));
	}
	preview = await f.preview();
	assert.equal(preview.reason, "reference_overflow");
	assert.equal(preview.references.length, 32);
	assert.equal(preview.payload, null);
	assert.equal(f.starts, 0);
});

test("restored old metadata and late create recovery cannot restore old authority", async (t) => {
	const f = await fixture(t);
	const bytes = await readFile(join(f.home, "sessions", f.oldId, "meta.json"), "utf8");
	await f.deleteOld();
	const op = await f.intent();
	assert.equal((await f.run(op)).state, "accepted");
	await assert.rejects(
		f.sessions.spawnDurable({ projectId: f.project.id, mode: "build", message: "no" }, f.oldId, randomUUID()),
		/fenced/,
	);
	await mkdir(join(f.home, "sessions", f.oldId));
	await writeFile(join(f.home, "sessions", f.oldId, "meta.json"), bytes);
	await f.reopen();
	assert.throws(() => f.sessions.insightsHostAdmission(f.oldId));
	await assert.rejects(
		f.sessions.spawnInsightsDurable(
			{ projectId: f.project.id, missionId: f.mission.id, model: model.id, message: "no" },
			f.oldId,
			f.oldOp.operationId,
			true,
		),
		/fenced/,
	);
	assert.equal(f.starts, 0);
});

test("changed host and disabled Automations refuse before any replacement fence", async (t) => {
	const f = await fixture(t);
	await f.deleteOld();
	f.sessions["diagnosticHost"]!.lineageId = "changed";
	assert.equal((await f.preview()).reason, "replacement_host_changed");
	f.sessions["diagnosticHost"]!.lineageId = host.lineageId;
	f.disable();
	assert.equal((await f.preview()).reason, "automations_disabled");
	assert.equal(f.missions.insights.replacements.link(f.oldId), null);
	assert.equal(f.starts, 0);
});

test("disabled scheduling and saved successor settings refuse implicit activation", async (t) => {
	const f = await fixture(t);
	await f.deleteOld();
	const op = await f.intent();
	const original = f.sessions.spawnInsightsDurable.bind(f.sessions);
	t.mock.method(f.sessions, "spawnInsightsDurable", async (...args: Parameters<typeof original>) => {
		const ack = await original(...args);
		const snapshot = await f.enable.settings(op.targetId);
		const settings = { ...snapshot.settings, budget: { ...snapshot.settings.budget, usd: 8 } };
		await f.missions.insights.settings.save(
			f.sessions.insightsHostAdmission(op.targetId),
			randomUUID(),
			{ synthetic: "desired-only" },
			0,
			settings,
			model.id,
		);
		return ack;
	});
	assert.equal((await f.run(op)).state, "pending");
	assert.equal((await f.replacement.status(op)).state, "blocked");
	assert.equal(f.schedules.list().length, 1);
	assert.equal(f.starts, 0);
	f.disable();
	assert.equal((await f.replacement.status(op)).state, "blocked");
});

test("HTTP replacement is native-gated; preview and status are passive, scoped, no-store and lineage-bound", async (t) => {
	const f = await fixture(t);
	await f.deleteOld();
	const args: Parameters<typeof createDaemonServer> = [
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		f.models,
		new TerminalManager(),
		{ store: f.missions, service: f.service },
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
			if (token !== "native-confirmed") throw new Error("Native confirmation required");
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
	assert.equal((await (await fetch(`${root}/hello`)).json()).capabilities.insightsReplacement, 1);
	assert.equal((await fetch(`${root}/insights/replacement/preflight`)).status, 400);
	assert.equal((await fetch(`${root}/insights/replacement/status`)).status, 405);
	const url = `${root}/insights/replacement/preflight?projectId=${f.project.id}&missionId=${f.mission.id}&reportSessionId=${f.oldId}`;
	const response = await fetch(url);
	assert.equal(response.headers.get("cache-control"), "no-store");
	const text = await response.text();
	const preview = JSON.parse(text);
	assert.equal(preview.state, "ready");
	assert.ok(preview.payload);
	assert.equal(text.includes(f.home), false);
	assert.equal(text.includes("grantId"), false);
	assert.equal(text.includes("Prepare the next"), false);
	assert.equal(preview.references[0].payload, undefined);
	assert.equal(preview.rules[0].target, undefined);
	const op = f.operation("insights-replace", preview.payload.successorSessionId, preview.payload);
	const post = (path: string, native = false, intent = op) =>
		fetch(`${root}/${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(native ? { "x-pilot-github-capability": "native-confirmed" } : {}),
			},
			body: JSON.stringify(intent),
		});
	assert.equal((await (await post("insights/replacement/status")).json()).state, "not_found");
	assert.notEqual((await post("operations")).status, 200);
	assert.equal((await (await post("operations/receipt")).json()).state, "unknown");
	assert.equal(
		(
			await post("insights/replacement/status", false, {
				...op,
				destination: { ...op.destination, lineageId: "changed" },
			})
		).status,
		400,
	);
	const accepted = await (await post("operations", true)).json();
	assert.equal(accepted.state, "accepted", JSON.stringify(accepted));
	const receiptBytes = await readFile(join(f.home, "operations", `${payloadHash(op.operationId)}.json`), "utf8");
	const status = await post("insights/replacement/status");
	assert.equal(status.headers.get("cache-control"), "no-store");
	assert.equal((await status.json()).state, "replaced");
	assert.equal(
		await readFile(join(f.home, "operations", `${payloadHash(op.operationId)}.json`), "utf8"),
		receiptBytes,
	);
	assert.equal(f.sessions.list().length, 1);
	assert.equal(f.schedules.list().length, 2);
	assert.equal(f.starts, 0);
});

// biome-ignore-all lint/complexity/useLiteralKeys: Fault injection exercises private persistence fences.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
	DurableOperation,
	InsightsEnablePayload,
	InsightsEnableProgress,
	ModelOption,
	OperationReceipt,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { INSIGHTS_INITIAL_DEFAULTS } from "./insights-defaults.ts";
import { InsightsEnable } from "./insights-enable.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import type { ModelCatalog } from "./models.ts";
import { OperationExpired, OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

const host = { hostId: "daemon", daemonId: "synthetic", lineageId: "synthetic-lineage" };
const model: ModelOption = {
	id: "synthetic/terra-exact",
	provider: "synthetic",
	name: "Terra 6.1",
	thinkingLevels: ["off", "low", "high"],
};

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "insights-enable-"));
	const home = join(root, "home"),
		source = join(root, "source");
	await mkdir(source);
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: source, model: "synthetic/not-the-default" });
	const missions = new MissionStore(join(home, "missions.sqlite"));
	const mission = missions.create({ title: "Synthetic backlog", projectId: project.id });
	await missions.durable();
	let options = [model];
	const models = {
		list: async () => ({ models: options, defaultModel: "synthetic/not-the-default" }),
	} as unknown as ModelCatalog;
	let now = Date.parse("2026-03-27T17:00:00Z");
	let enabled = true;
	let workerStarts = 0;
	let sessions: SessionManager,
		service: MissionService,
		schedules: ScheduleService,
		scheduleStore: ScheduleStore,
		journal: OperationJournal,
		enable: InsightsEnable;
	const open = async () => {
		sessions = new SessionManager(
			home,
			projects,
			undefined,
			{
				worker: () => {
					workerStarts++;
					throw new Error("No provider/kernel turn permitted");
				},
			},
			{},
			{ diagnosticHost: host },
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
			clock: { now: () => now, setTimeout: () => () => {} },
		});
		await schedules.load();
		journal = new OperationJournal(join(home, "operations"), host);
		enable = new InsightsEnable({
			home,
			host,
			projects,
			missions,
			models,
			sessions,
			schedules,
			journal,
			now: () => now,
		});
	};
	await open();
	t.after(async () => {
		await sessions.shutdown();
		await schedules.stop();
		await scheduleStore.close();
		await missions.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
	});
	let sequence = 0;
	const operation = (payload: InsightsEnablePayload, targetId: string): DurableOperation => {
		const bytes = JSON.stringify(payload);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: "synthetic-native",
			sequence: ++sequence,
			origin: { ...host, hostId: "local" },
			destination: { ...host, hostId: "local" },
			kind: "insights-enable",
			targetId,
			payload: bytes,
			payloadHash: payloadHash(bytes),
		};
	};
	return {
		home,
		source,
		projects,
		project,
		missions,
		mission,
		models,
		operation,
		get sessions() {
			return sessions;
		},
		get service() {
			return service;
		},
		get schedules() {
			return schedules;
		},
		get journal() {
			return journal;
		},
		get enable() {
			return enable;
		},
		get workerStarts() {
			return workerStarts;
		},
		setModels(value: ModelOption[]) {
			options = value;
		},
		setTime(value: number) {
			now = value;
		},
		disable() {
			enabled = false;
		},
		preflight: (explicit?: string, thinking?: string) => enable.preflight(project.id, mission.id, explicit, thinking),
		run: (op: DurableOperation) => journal.execute(op, (op) => enable.enable(op, JSON.parse(op.payload))),
		async intent(explicit?: string, thinking?: string) {
			const p = await enable.preflight(project.id, mission.id, explicit, thinking);
			assert.ok(p.payload, p.reason ?? "Missing payload");
			return operation(p.payload, p.targetId);
		},
		async reopen() {
			await sessions.shutdown();
			await schedules.stop();
			await scheduleStore.close();
			await open();
		},
	};
}

test("passive preflight/status creates nothing, resolves exact default and requires exact existing backlog", async (t) => {
	const f = await fixture(t);
	const before = await readdir(f.home);
	const p = await f.preflight();
	assert.equal(p.state, "ready");
	assert.deepEqual(p.model, { state: "available", id: model.id });
	assert.deepEqual(p.payload?.scope, INSIGHTS_INITIAL_DEFAULTS.scope);
	assert.deepEqual(p.payload?.bounds, { inventoryPages: 1, historyPages: 2, entriesPerPage: 4 });
	assert.deepEqual(p.payload?.budget, INSIGHTS_INITIAL_DEFAULTS.budget);
	assert.deepEqual(p.cost, { pricing: "unknown", spendUsd: null });
	assert.equal(
		new Date(p.nextAt!).toISOString(),
		"2026-04-03T16:00:00.000Z",
		"strictly future Paris occurrence across DST",
	);
	const op = f.operation(p.payload!, p.targetId);
	assert.equal((await f.enable.status(op)).state, "not_found");
	const knownMissing = randomUUID();
	const pinned = await f.enable.preflight(f.project.id, f.mission.id, undefined, undefined, undefined, knownMissing);
	assert.equal(pinned.state, "blocked");
	assert.equal(pinned.reason, "report_identity_unavailable");
	assert.equal(pinned.targetId, knownMissing);
	assert.equal(pinned.payload, null);
	await assert.rejects(f.enable.preflight(f.project.id, "missing"));
	const other = f.missions.create({ projectId: "other", title: "Not this project" });
	await assert.rejects(f.enable.preflight(f.project.id, other.id), /Backlog/);
	assert.deepEqual(await readdir(f.home), before);
	assert.deepEqual(f.sessions.list(), []);
	assert.deepEqual(f.schedules.list(), []);
	assert.equal(f.workerStarts, 0);
});

test("fresh confirmed enable is durable, deduplicated and never starts an immediate review", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	const receipts = await Promise.all(Array.from({ length: 12 }, () => f.run(op)));
	assert.ok(receipts.every((r) => r.state === "accepted"));
	assert.deepEqual(receipts[0]!.result, receipts[11]!.result);
	assert.equal(f.sessions.list().length, 1);
	const [rule] = f.schedules.list();
	assert.equal(rule!.insightsEnableOperationId, op.operationId);
	assert.equal(rule!.at, Date.parse("2026-04-03T16:00Z"));
	assert.deepEqual(rule!.runs, []);
	const saved = JSON.parse(await readFile(join(f.home, "sessions", op.targetId, "meta.json"), "utf8"));
	assert.deepEqual(saved.pending, []);
	assert.equal(saved.initializing, undefined);
	assert.equal(saved.model, model.id);
	assert.equal(f.workerStarts, 0);
	assert.equal((await f.enable.status(op)).state, "enabled");
	await f.reopen();
	assert.deepEqual(await f.journal.lookup(op), receipts[0]);
	assert.equal((await f.enable.status(op)).state, "enabled");
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal(f.workerStarts, 0);
});

test("exact trusted existing chat and manual rule reuse preserves user model/thinking/cadence/message", async (t) => {
	const f = await fixture(t);
	const custom = { ...model, id: "synthetic/user-choice", name: "Custom" };
	f.setModels([model, custom]);
	const first = await f.intent(custom.id, "low");
	assert.equal((await f.run(first)).state, "accepted");
	const rule = f.schedules.list()[0]!;
	const recurrence = { every: "week" as const, weekday: 2, time: "11:45", timeZone: "Europe/Paris" };
	await f.schedules.update(rule.id, {
		expectedHome: host,
		expectedRevision: rule.revision,
		recurrence,
		target: { kind: "message", sessionId: first.targetId, message: "User-selected reminder" },
		title: "Keep this title",
	});
	const before = f.schedules.list();
	const chat = f.sessions.insightsEnableChat(first.targetId);
	const p = await f.preflight();
	assert.equal(p.state, "existing");
	assert.equal(p.payload?.model, custom.id);
	assert.equal(p.payload?.thinking, "low");
	assert.deepEqual(p.payload?.recurrence, recurrence);
	const second = f.operation(p.payload!, p.targetId);
	assert.equal((await f.run(second)).state, "accepted");
	assert.deepEqual(f.schedules.list(), before);
	assert.deepEqual(f.sessions.insightsEnableChat(first.targetId), chat);
	assert.equal((await f.preflight(model.id)).reason, "existing_model_choice_differs");
	assert.equal(f.workerStarts, 0);
});

test("manual admitted chat without a rule is reused, ordinary Insights title/membership is not authority", async (t) => {
	const f = await fixture(t);
	const ordinary = randomUUID();
	f.sessions["metas"].set(ordinary, {
		id: ordinary,
		title: "Insights",
		cwd: f.source,
		mode: "ask",
		projectId: f.project.id,
		createdAt: 1,
		updatedAt: 1,
		pending: [],
	});
	f.missions.join(ordinary, f.mission.id);
	assert.notEqual((await f.preflight()).targetId, ordinary);
	const id = randomUUID();
	await f.sessions.spawnInsightsDurable(
		{
			projectId: f.project.id,
			missionId: f.mission.id,
			model: model.id,
			thinking: "low",
			message: "Manual synthetic setup",
		},
		id,
		randomUUID(),
		true,
	);
	const chat = f.sessions.insightsEnableChat(id);
	const p = await f.preflight();
	assert.equal(p.state, "ready");
	assert.equal(p.targetId, id);
	assert.deepEqual(p.payload!.chat, chat);
	assert.equal(p.payload!.schedule, null);
	assert.equal((await f.run(f.operation(p.payload!, id))).state, "accepted");
	assert.deepEqual(f.sessions.insightsEnableChat(id), chat);
	assert.equal(f.sessions.list().length, 2);
	assert.equal(f.schedules.list().length, 1);
	assert.equal(f.workerStarts, 0);
});

test("existing revoked, paused, untrusted or multiple setups never get silently adopted", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	await f.run(op);
	const rule = f.schedules.list()[0]!;
	await f.schedules.update(rule.id, { expectedHome: host, expectedRevision: rule.revision, paused: true });
	assert.equal((await f.preflight()).reason, "existing_rule_not_ready");
	const paused = f.schedules.list()[0]!;
	await f.schedules.update(rule.id, { expectedHome: host, expectedRevision: paused.revision, paused: false });
	const active = f.schedules.list()[0]!;
	await f.schedules.store.replace(active, { ...active, insightsDestination: undefined });
	assert.equal((await f.preflight()).reason, "existing_rule_identity_unavailable");
	await f.sessions.revokeInsights(op.targetId, 1);
	assert.equal((await f.preflight()).reason, "report_chat_unavailable");
	await f.sessions.spawnInsightsDurable(
		{ projectId: f.project.id, missionId: f.mission.id, model: model.id, message: "Separate manual setup" },
		randomUUID(),
		randomUUID(),
		true,
	);
	assert.equal((await f.preflight()).reason, "multiple_report_chats");
});

test("manual create and target replacement share the atomic Insights overlap guard", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	await f.run(op);
	const request = {
		trigger: "recurring" as const,
		recurrence: { ...INSIGHTS_INITIAL_DEFAULTS.recurrence },
		expectedHome: host,
		target: { kind: "message" as const, sessionId: op.targetId, message: "Do not duplicate" },
	};
	await assert.rejects(f.schedules.create(request), /already has a recurring rule/);
	const ordinary = randomUUID();
	f.sessions["metas"].set(ordinary, {
		id: ordinary,
		title: "Other",
		cwd: f.source,
		mode: "ask",
		projectId: f.project.id,
		createdAt: 1,
		updatedAt: 1,
		pending: [],
	});
	const other = await f.schedules.create({ ...request, target: { ...request.target, sessionId: ordinary } });
	await assert.rejects(
		f.schedules.update(other.id, { expectedHome: host, expectedRevision: other.revision, target: request.target }),
		/already has a recurring rule/,
	);
	assert.equal(
		f.schedules.list().filter((r) => r.target.kind === "message" && r.target.sessionId === op.targetId).length,
		1,
	);
});

test("refused membership leaves a disabled partial chat, never an automatic replacement grant", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	t.mock.method(f.sessions["missions"]!, "joinSpawn", () => {
		throw new Conflict("Synthetic refused membership");
	});
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(f.sessions.insightsStatus(op.targetId)!.enabled, false);
	assert.equal((await f.enable.status(op)).state, "blocked");
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(f.sessions.list().length, 1);
	assert.equal(f.schedules.list().length, 0);
});

for (const field of [
	"enabled",
	"home",
	"projectPath",
	"hostId",
	"daemonId",
	"lineageId",
	"projectId",
	"missionId",
	"missingGrant",
	"missionProject",
] as const) {
	test(`stale ${field} binding explicitly refuses preflight and frozen reuse before effects`, async (t) => {
		const f = await fixture(t),
			id = randomUUID();
		await f.sessions.spawnInsightsDurable(
			{ projectId: f.project.id, missionId: f.mission.id, model: model.id, message: "Synthetic admitted report" },
			id,
			randomUUID(),
			true,
		);
		const before = await f.preflight();
		assert.equal(before.targetId, id);
		const op = f.operation(before.payload!, id);
		const meta = f.sessions["metas"].get(id)!;
		const grant = meta.insightsGrant!;
		if (field === "enabled") grant.enabled = false;
		else if (field === "missingGrant") delete meta.insightsGrant;
		else if (field === "missionProject")
			t.mock.method(f.sessions["missions"]!, "spawnProject", () => "different-project");
		else if (field === "home" || field === "projectPath") grant[field] = "/synthetic/different";
		else if (field === "projectId" || field === "missionId") grant[field] = "different";
		else grant.host[field] = "different";
		const unchanged = structuredClone(meta);
		const preflight = await f.preflight();
		assert.equal(preflight.state, "blocked");
		assert.equal(preflight.reason, "report_chat_unavailable");
		assert.equal(preflight.targetId, id, "retain the exact unavailable identity, never derive a substitute");
		assert.equal(preflight.payload, null);
		const spawn = t.mock.method(f.sessions, "spawnInsightsDurable");
		const schedule = t.mock.method(f.schedules, "createInsights");
		const receipt = await f.run(op);
		assert.equal(receipt.state, "rejected");
		assert.equal(receipt.result, undefined, "no step entered for stale binding");
		assert.deepEqual(meta, unchanged, "no rebind or regrant");
		assert.equal(spawn.mock.callCount(), 0);
		assert.equal(schedule.mock.callCount(), 0);
		assert.equal(f.schedules.list().length, 0);
		assert.equal(f.workerStarts, 0);
	});
}

for (const reference of ["enable-receipt", "legacy-create-receipt", "schedule-intent"] as const) {
	test(`Unknown session with retained ${reference} refuses substitution, without inferring deletion/revocation`, async (t) => {
		const f = await fixture(t);
		let id: string;
		if (reference === "enable-receipt") {
			const op = await f.intent();
			id = op.targetId;
			await f.run(op);
		} else {
			id = randomUUID();
			const create = () =>
				f.sessions.spawnInsightsDurable(
					{
						projectId: f.project.id,
						missionId: f.mission.id,
						model: model.id,
						message: "Synthetic existing report",
					},
					id,
					"synthetic-legacy-create",
					true,
				);
			if (reference === "legacy-create-receipt") {
				const template = await f.intent();
				const payload = JSON.stringify({
					projectId: f.project.id,
					missionId: f.mission.id,
					model: model.id,
					disclosure: "insights-history-v1",
				});
				await f.journal.execute(
					{ ...template, kind: "insights-create", targetId: id, payload, payloadHash: payloadHash(payload) },
					async () => {
						await create();
						return { sessionId: id };
					},
				);
			} else {
				await create();
				await f.schedules.create({
					trigger: "recurring",
					recurrence: { ...INSIGHTS_INITIAL_DEFAULTS.recurrence },
					expectedHome: host,
					target: { kind: "message", sessionId: id, message: "Existing manual rule" },
				});
			}
		}
		const frozen = await f.preflight();
		assert.ok(frozen.payload);
		const stale = f.operation(frozen.payload, id);
		const file = join(f.home, "sessions", id, "meta.json");
		const bytes = await readFile(file);
		f.sessions["metas"].delete(id); // Synthetic unavailable index only; retain actual bytes and enabled grant.
		const nextSource = join(f.home, "other-project-path");
		await mkdir(nextSource);
		await f.projects.update(f.project.id, { path: nextSource }); // Changed context must not mint another ID.
		const preflight = await f.preflight();
		assert.equal(preflight.state, "blocked");
		assert.equal(preflight.reason, "report_identity_unavailable");
		assert.equal(preflight.targetId, id);
		assert.equal(preflight.payload, null);
		assert.equal((await f.run(stale)).state, "rejected");
		assert.deepEqual(await readFile(file), bytes);
		assert.equal(
			JSON.parse(bytes.toString()).insightsGrant.enabled,
			true,
			"Unknown index is not evidence of revocation",
		);
		assert.equal(f.sessions.list().length, 0);
		assert.equal(f.schedules.list().length, reference === "legacy-create-receipt" ? 0 : 1);
		assert.equal(f.workerStarts, 0);
	});
}

test("autumn Paris recurrence remains strictly future and 169 hours across DST", async (t) => {
	const f = await fixture(t);
	f.setTime(Date.parse("2026-10-23T16:00Z"));
	const p = await f.preflight();
	assert.equal(p.nextAt, Date.parse("2026-10-30T17:00Z"));
	assert.equal((p.nextAt! - Date.parse("2026-10-23T16:00Z")) / 3_600_000, 169);
	assert.equal((await f.run(f.operation(p.payload!, p.targetId))).state, "accepted");
	assert.equal(f.schedules.list()[0]!.at, p.nextAt);
	assert.equal(f.workerStarts, 0);
});

test("unavailable/ambiguous models refuse without fallback; explicit configured model remains exact", async (t) => {
	const f = await fixture(t);
	f.setModels([]);
	assert.equal((await f.preflight()).reason, "model_unavailable");
	f.setModels([model, { ...model, id: "synthetic/second" }]);
	assert.equal((await f.preflight()).reason, "model_ambiguous");
	assert.equal((await f.preflight("synthetic/second")).payload?.model, "synthetic/second");
	const op = await f.intent("synthetic/second", "high");
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal(f.sessions.insightsEnableChat(op.targetId).model, "synthetic/second");
});

test("mismatched admission, values, home, stale CAS and malformed input refuse before effects", async (t) => {
	const f = await fixture(t),
		original = await f.intent();
	const payload = JSON.parse(original.payload) as InsightsEnablePayload;
	for (const patch of [
		{ context: "0".repeat(64) },
		{ disclosure: "old" },
		{ model: "synthetic/missing" },
		{ bounds: { inventoryPages: 4, historyPages: 8, entriesPerPage: 20 } },
		{ scope: { ...payload.scope, sourceAccess: "write" } },
		{ expectedHome: { ...host, hostId: "local" } },
		{ expectedHome: { ...host, daemonId: "different" } },
		{ expectedHome: { ...host, lineageId: "different" } },
		{ ignored: true },
		{ projectId: undefined },
	]) {
		const op = f.operation({ ...payload, ...patch } as InsightsEnablePayload, original.targetId);
		assert.equal((await f.run(op)).state, "rejected");
	}
	const wrongTarget = f.operation(payload, randomUUID());
	assert.equal((await f.run(wrongTarget)).state, "rejected");
	assert.deepEqual(f.sessions.list(), []);
	assert.deepEqual(f.schedules.list(), []);
	assert.equal((await f.run(original)).state, "accepted");
	const stale = await f.intent();
	const rule = f.schedules.list()[0]!;
	await f.schedules.update(rule.id, { expectedHome: host, expectedRevision: rule.revision, paused: true });
	assert.equal((await f.run(stale)).state, "rejected");
});

test("different concurrent operations cannot duplicate grants/chats/rules", async (t) => {
	const f = await fixture(t),
		first = await f.intent(),
		second = f.operation(JSON.parse(first.payload), first.targetId);
	const receipts = await Promise.all([f.run(first), f.run(second)]);
	assert.equal(receipts.filter((r) => r.state === "accepted").length, 1);
	assert.equal(f.sessions.list().length, 1);
	assert.equal(f.schedules.list().length, 1);
});

for (const phase of ["chat_pending", "chat_ready", "schedule_pending"] as const) {
	test(`crash at persisted ${phase} step reconciles without replaying entered effects`, async (t) => {
		const f = await fixture(t),
			op = await f.intent();
		const checkpoint = f.journal.checkpoint.bind(f.journal);
		const injected = t.mock.method(f.journal, "checkpoint", async (intent: DurableOperation, value: unknown) => {
			await checkpoint(intent, value);
			if ((value as InsightsEnableProgress).phase === phase)
				throw new Error("Synthetic crash after step publication");
		});
		const receipt = await f.run(op);
		assert.equal(receipt.state, "pending");
		assert.equal((receipt.result as InsightsEnableProgress).phase, phase);
		injected.mock.restore();
		await f.reopen();
		const spawn = t.mock.method(f.sessions, "spawnInsightsDurable");
		const create = t.mock.method(f.schedules, "createInsights");
		await f.journal.recover((intent) => f.enable.enable(intent, JSON.parse(intent.payload)));
		assert.equal(spawn.mock.callCount(), 0, "entered chat creation is never replayed");
		assert.equal(
			create.mock.callCount(),
			phase === "chat_ready" ? 1 : 0,
			"only an unentered schedule step can proceed",
		);
		assert.equal(
			(await f.enable.status(op)).state,
			phase === "chat_ready" ? "enabled" : phase === "chat_pending" ? "unknown" : "partial",
		);
		if (phase !== "chat_ready") assert.equal((await f.preflight()).reason, "enable_pending_use_status");
		assert.equal(f.workerStarts, 0);
	});
}

for (const phase of ["chat_pending", "chat_ready", "schedule_pending"] as const) {
	test(`same confirmed command re-admission after ${phase} never replays entered effects`, async (t) => {
		const f = await fixture(t),
			op = await f.intent();
		const frozen = structuredClone(op);
		assert.equal((await f.enable.status(op)).receipt.state, "unknown");
		// That observation can be stale before Check re-admits the immutable command.
		const checkpoint = f.journal.checkpoint.bind(f.journal);
		const injected = t.mock.method(f.journal, "checkpoint", async (intent: DurableOperation, value: unknown) => {
			await checkpoint(intent, value);
			if ((value as InsightsEnableProgress).phase === phase) throw new Error("Synthetic interrupted command");
		});
		assert.equal((await f.run(op)).state, "pending");
		injected.mock.restore();
		await f.reopen();
		const file = join(f.home, "operations", `${payloadHash(op.operationId)}.json`);
		const saved = await readFile(file);
		const spawn = t.mock.method(f.sessions, "spawnInsightsDurable");
		const create = t.mock.method(f.schedules, "createInsights");
		for (let i = 0; i < 3; i++) assert.equal((await f.enable.status(op)).receipt.state, "pending");
		assert.deepEqual(await readFile(file), saved, "status cannot advance an entered step");
		assert.equal(spawn.mock.callCount(), 0);
		assert.equal(create.mock.callCount(), 0);
		for (let i = 0; i < 3; i++) await f.run(op);
		assert.equal(spawn.mock.callCount(), 0, "even stale unknown lookup cannot replay entered chat create");
		assert.equal(create.mock.callCount(), phase === "chat_ready" ? 1 : 0, "only an unentered step can run");
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")).operation, frozen);
		assert.deepEqual(op, frozen, "no new attempt, sequence, target or payload");
		assert.equal(f.workerStarts, 0, "command re-admission is not review/provider-input resend");
	});
}

test("unknown lookup grants no authority; changed settings and retired commands refuse without effects", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	assert.equal((await f.enable.status(op)).state, "not_found");
	f.disable();
	const spawn = t.mock.method(f.sessions, "spawnInsightsDurable");
	const create = t.mock.method(f.schedules, "createInsights");
	assert.equal((await f.run(op)).state, "rejected");
	await f.journal.retire(op.origin, op.producerId, op.sequence);
	await f.reopen();
	await assert.rejects(f.enable.status(op), OperationExpired);
	await assert.rejects(f.run(op), OperationExpired);
	assert.equal(spawn.mock.callCount(), 0);
	assert.equal(create.mock.callCount(), 0);
	assert.equal(f.sessions.list().length, 0);
	assert.equal(f.schedules.list().length, 0);
	assert.equal(f.workerStarts, 0);
});

test("disconnect after report placement plus missing index retains Unknown, never replacement authority", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	const original = f.sessions.spawnInsightsDurable.bind(f.sessions);
	const spawn = t.mock.method(
		f.sessions,
		"spawnInsightsDurable",
		async (...args: Parameters<SessionManager["spawnInsightsDurable"]>) => {
			await original(...args);
			throw new Error("Synthetic IPC disconnect after placement");
		},
	);
	assert.equal((await f.run(op)).state, "pending");
	const file = join(f.home, "sessions", op.targetId, "meta.json");
	const bytes = await readFile(file);
	f.sessions["metas"].delete(op.targetId); // Index unavailable, not deletion or revocation.
	assert.equal((await f.enable.status(op)).state, "unknown");
	assert.equal((await f.preflight()).reason, "enable_pending_use_status");
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(spawn.mock.callCount(), 1, "no re-placement after disconnect");
	assert.deepEqual(await readFile(file), bytes);
	assert.equal(JSON.parse(bytes.toString()).insightsGrant.enabled, true);
	assert.equal(f.schedules.list().length, 0);
	assert.equal(f.workerStarts, 0);
});

for (const effect of ["chat", "schedule"] as const) {
	test(`lost ${effect} ACK is read-only reconciled after restart without duplicate effects`, async (t) => {
		const f = await fixture(t),
			op = await f.intent();
		if (effect === "chat") {
			const original = f.sessions.spawnInsightsDurable.bind(f.sessions);
			t.mock.method(
				f.sessions,
				"spawnInsightsDurable",
				async (...args: Parameters<SessionManager["spawnInsightsDurable"]>) => {
					await original(...args);
					throw new Error("Synthetic lost chat ACK");
				},
			);
		} else {
			const original = f.schedules.createInsights.bind(f.schedules);
			t.mock.method(
				f.schedules,
				"createInsights",
				async (...args: Parameters<ScheduleService["createInsights"]>) => {
					await original(...args);
					throw new Error("Synthetic lost schedule ACK");
				},
			);
		}
		const pending = await f.run(op);
		assert.equal(pending.state, "pending");
		const progress = pending.result as InsightsEnableProgress;
		assert.equal(progress.phase, effect === "chat" ? "chat_pending" : "schedule_pending");
		const file = join(f.home, "operations", `${payloadHash(op.operationId)}.json`);
		const saved = await readFile(file);
		const status = await f.enable.status(op);
		assert.deepEqual(status.receipt, pending, "current enabled is not an invented accepted receipt");
		assert.equal(status.sessionId, op.targetId);
		assert.equal(status.scheduleId, progress.scheduleId);
		assert.equal(status.state, effect === "chat" ? "partial" : "enabled");
		if (effect === "schedule") {
			assert.deepEqual(progress.chat, f.sessions.insightsEnableChat(op.targetId));
			assert.equal(status.nextAt, f.schedules.list()[0]!.at);
		}
		assert.deepEqual(await readFile(file), saved, "passive reconciliation preserves the pending marker");
		assert.equal(f.schedules.list().length, effect === "chat" ? 0 : 1, "status never provisions a missing step");
		await f.reopen();
		await f.journal.recover((intent) => f.enable.enable(intent, JSON.parse(intent.payload)));
		assert.equal((await f.enable.status(op)).state, "enabled");
		assert.equal(f.sessions.list().length, 1);
		assert.equal(f.schedules.list().length, 1);
		assert.equal(f.workerStarts, 0);
	});
}

test("pending enabled status becomes blocked on revoke without changing the receipt or replaying", async (t) => {
	const f = await fixture(t),
		op = await f.intent();
	const original = f.schedules.createInsights.bind(f.schedules);
	const create = t.mock.method(
		f.schedules,
		"createInsights",
		async (...args: Parameters<ScheduleService["createInsights"]>) => {
			await original(...args);
			throw new Error("Synthetic lost schedule ACK");
		},
	);
	const pending = await f.run(op);
	assert.equal(pending.state, "pending");
	assert.equal((pending.result as InsightsEnableProgress).phase, "schedule_pending");
	assert.equal((await f.enable.status(op)).state, "enabled");
	const file = join(f.home, "operations", `${payloadHash(op.operationId)}.json`);
	const bytes = await readFile(file);
	await f.sessions.revokeInsights(op.targetId, 1);
	for (let i = 0; i < 3; i++) {
		const blocked = await f.enable.status(op);
		assert.equal(blocked.state, "blocked", "same pending receipt must not cache an earlier enabled observation");
		assert.deepEqual(blocked.receipt, pending);
		assert.equal(blocked.sessionId, op.targetId);
		assert.equal(blocked.scheduleId, (pending.result as InsightsEnableProgress).scheduleId);
	}
	assert.deepEqual(await readFile(file), bytes);
	assert.deepEqual(await f.run(op), pending, "re-admission cannot bypass revocation");
	assert.equal(create.mock.callCount(), 1);
	assert.equal(f.sessions.list().length, 1);
	assert.equal(f.schedules.list().length, 1);
	assert.equal(f.workerStarts, 0);
});

for (const fence of ["Stop", "revoke", "home", "project", "backlog", "disable"] as const) {
	test(`${fence} fences partial recovery and never mints replacement authority`, async (t) => {
		const f = await fixture(t),
			op = await f.intent();
		const checkpoint = f.journal.checkpoint.bind(f.journal);
		const injected = t.mock.method(f.journal, "checkpoint", async (intent: DurableOperation, value: unknown) => {
			await checkpoint(intent, value);
			if ((value as InsightsEnableProgress).phase === "chat_ready")
				throw new Error("Interrupted before schedule entry");
		});
		assert.equal((await f.run(op)).state, "pending");
		injected.mock.restore();
		if (fence === "Stop") await f.sessions.stop(op.targetId);
		if (fence === "revoke") await f.sessions.revokeInsights(op.targetId, 1);
		if (fence === "home") f.sessions["metas"].get(op.targetId)!.insightsGrant!.home = "/different";
		if (fence === "project") f.sessions["metas"].get(op.targetId)!.projectId = "different";
		if (fence === "backlog") f.missions.leave(op.targetId);
		if (fence === "disable") f.disable();
		if (fence === "Stop" || fence === "revoke") await f.reopen();
		assert.equal((await f.run(op)).state, "pending");
		assert.equal((await f.enable.status(op)).state, "blocked");
		assert.equal(f.schedules.list().length, 0);
		assert.equal(f.sessions.list().length, 1);
	});
}

test("native HTTP contract gates only enable, passive reads/status never provision or read history", async (t) => {
	const f = await fixture(t);
	const terminals = new TerminalManager();
	const args: Parameters<typeof createDaemonServer> = [
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		f.models,
		terminals,
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
			if (token !== "native-confirmed") throw new Conflict("Native confirmation required");
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
	assert.equal((await (await fetch(`${root}/hello`)).json()).capabilities.insightsEnable, 1);
	assert.equal((await fetch(`${root}/insights/enable/preflight`)).status, 400);
	const knownMissing = randomUUID();
	const pinned = await (
		await fetch(
			`${root}/insights/enable/preflight?projectId=${f.project.id}&missionId=${f.mission.id}&reportSessionId=${knownMissing}`,
		)
	).json();
	assert.equal(pinned.reason, "report_identity_unavailable");
	assert.equal(pinned.targetId, knownMissing);
	assert.equal(pinned.payload, null);
	const preflight = await (
		await fetch(`${root}/insights/enable/preflight?projectId=${f.project.id}&missionId=${f.mission.id}`)
	).json();
	const op = f.operation(preflight.payload, preflight.targetId);
	const frozenPayload = op.payload;
	assert.equal(op.destination.hostId, "local");
	assert.equal(preflight.payload.expectedHome.hostId, "daemon");
	const post = (path: string, native = false, intent = op) =>
		fetch(`${root}/${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(native ? { "x-pilot-github-capability": "native-confirmed" } : {}),
			},
			body: JSON.stringify(intent),
		});
	assert.equal((await (await post("insights/enable/status")).json()).state, "not_found");
	assert.notEqual((await post("operations")).status, 200);
	const spawn = t.mock.method(f.sessions, "spawnInsightsDurable");
	const create = t.mock.method(f.schedules, "createInsights");
	for (const field of ["daemonId", "lineageId"] as const) {
		const mismatched = { ...op, destination: { ...op.destination, [field]: "different" } };
		for (const path of ["operations", "insights/enable/status", "operations/receipt"]) {
			const response = await post(path, true, mismatched);
			assert.equal(response.status, 400);
			assert.match((await response.json()).error, /Destination lineage changed/);
		}
	}
	for (const field of ["hostId", "daemonId", "lineageId"] as const) {
		const changed = f.operation(
			{ ...preflight.payload, expectedHome: { ...preflight.payload.expectedHome, [field]: "different" } },
			op.targetId,
		);
		const response = await post("operations", true, changed);
		assert.equal(response.status, 200);
		const refused = (await response.json()) as OperationReceipt;
		assert.equal(refused.state, "rejected");
		assert.equal(refused.result, undefined, "frozen home mismatch enters no step");
		assert.deepEqual((await (await post("insights/enable/status", false, changed)).json()).receipt, refused);
	}
	assert.equal(spawn.mock.callCount(), 0);
	assert.equal(create.mock.callCount(), 0);
	assert.equal(f.sessions.list().length, 0);
	assert.equal(f.schedules.list().length, 0);
	const accepted = (await (await post("operations", true)).json()) as OperationReceipt;
	assert.equal(accepted.state, "accepted");
	assert.deepEqual(accepted.destination, op.destination);
	const status = await post("insights/enable/status");
	assert.equal(status.headers.get("cache-control"), "no-store");
	const enabled = await status.json();
	assert.equal(enabled.state, "enabled");
	assert.deepEqual(enabled.receipt, accepted);
	assert.deepEqual(await (await post("operations/receipt")).json(), accepted);
	assert.deepEqual(await (await post("operations", true)).json(), accepted);
	const record = JSON.parse(await readFile(join(f.home, "operations", `${payloadHash(op.operationId)}.json`), "utf8"));
	assert.equal(record.operation.payload, frozenPayload, "persist actual preflight bytes without home-label rewriting");
	assert.equal(record.operation.payloadHash, payloadHash(frozenPayload));
	assert.deepEqual(record.receipt, accepted);
	const restored = new OperationJournal(join(f.home, "operations"), host);
	assert.deepEqual(await restored.lookup(op), accepted, "native label survives cold receipt loading");
	const relabeled = { ...op, destination: host };
	assert.equal((await post("insights/enable/status", false, relabeled)).status, 400);
	assert.equal((await post("operations", true, relabeled)).status, 400);
	const existing = await (
		await fetch(`${root}/insights/enable/preflight?projectId=${f.project.id}&missionId=${f.mission.id}`)
	).json();
	const stale = f.operation(existing.payload, existing.targetId);
	f.sessions["metas"].get(op.targetId)!.insightsGrant!.host.hostId = "different";
	assert.equal(((await (await post("operations", true, stale)).json()) as OperationReceipt).state, "rejected");
	const blocked = await (await post("insights/enable/status")).json();
	assert.equal(blocked.state, "blocked");
	assert.deepEqual(blocked.receipt, accepted, "stale grant blocks current status, never rewrites accepted receipt");
	assert.equal(spawn.mock.callCount(), 1);
	assert.equal(create.mock.callCount(), 1);
	assert.equal(f.sessions.list().length, 1);
	assert.equal(f.schedules.list().length, 1);
	assert.equal(f.workerStarts, 0);
	assert.equal(await stat(join(f.home, "sessions", op.targetId, "history.sqlite")).catch(() => null), null);
});

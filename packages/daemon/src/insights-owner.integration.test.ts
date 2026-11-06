// biome-ignore-all lint/complexity/useLiteralKeys: Probe supervised IPC and persistence without a live provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { DurableOperation, ModelOption } from "@pilot/protocol";
import { NativeAdapter } from "../../kernel/src/native-adapter.ts";
import { KernelSession } from "../../kernel/src/session.ts";
import { openSessionStorage } from "../../kernel/src/storage.ts";
import { Conflict } from "./errors.ts";
import { InsightsOwner, isInsightsOwnerOperation } from "./insights-owner.ts";
import { InsightsWorkspace } from "./insights-workspace.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import type { ModelCatalog } from "./models.ts";
import { OperationJournal, payloadHash } from "./operation-journal.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionFactories, SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { fixture as sessionFixture, until } from "./testing/session-workspace.ts";

const host = { hostId: "daemon", daemonId: "synthetic", lineageId: "synthetic-lineage" };
const model: ModelOption = {
	id: "synthetic/terra",
	provider: "synthetic",
	name: "Terra 6.1",
	thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
};
async function fixture(
	t: TestContext,
	factories: import("./sessions.ts").SessionFactories = {},
	configuration: { thinking?: string } = { thinking: "high" },
) {
	const f = await sessionFixture(t, { diagnosticHost: host }, factories);
	const missions = new MissionStore(join(f.home, "missions.sqlite"));
	// Real bridge, not workflow-host's empty MissionService. No ordinary mission is created.
	const missionService = new MissionService(missions, f.sessions, f.projects);
	f.sessions.setInsightsOwnerStore(missions.insightsOwner);
	let now = Date.parse("2026-11-02T09:00:00Z"),
		enabled = true;
	const scheduleStore = new ScheduleStore(join(f.home, "schedules.sqlite"));
	const schedules = new ScheduleService(scheduleStore, {
		sessions: f.sessions,
		projects: f.projects,
		missions,
		home: host,
		automationsEnabled: () => enabled,
		clock: { now: () => now, setTimeout: () => () => {} },
		triggers: { online: true, refreshOnline: async () => true, subscribe: () => () => {} },
	});
	await schedules.load();
	const journal = new OperationJournal(join(f.home, "operations"), host);
	let catalog = [model];
	const models = {
		list: async (path: string) => {
			assert.equal(path, f.project.path);
			return { models: catalog };
		},
	};
	const workspace = new InsightsWorkspace({
		home: f.home,
		host,
		projects: f.projects,
		models,
		store: missions.insightsWorkspace,
		journal,
		legacyGuard: () => {
			f.sessions.assertNoLegacyInsights();
			schedules.assertNoLegacyInsights(host);
		},
	});
	const ownerService = new InsightsOwner({
		home: f.home,
		projects: f.projects,
		models,
		workspace: missions.insightsWorkspace,
		store: missions.insightsOwner,
		sessions: f.sessions,
		schedules,
		journal,
	});
	let sequence = 0;
	const operation = (kind: string, payload: unknown, targetId: string): DurableOperation => {
		const raw = JSON.stringify(
			isInsightsOwnerOperation(kind)
				? { admissionEpoch: f.sessions.insightsAdmissionEpoch, ...(payload as object) }
				: payload,
		);
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
	const preview = await workspace.preflight(f.project.id, model.id, configuration.thinking);
	assert.equal(preview.state, "ready");
	assert.ok(preview.payload);
	const owner = preview.payload.owner;
	const reservation = operation("insights-workspace-reserve", preview.payload, owner.workspaceId);
	assert.equal((await journal.execute(reservation, (op) => workspace.admit(op))).state, "accepted");
	const authority = { owner, home: f.home, projectPath: f.project.path };
	const enable = operation("insights-workspace-enable", await ownerService.preview(owner), owner.workspaceId);
	const run = (op: DurableOperation) => journal.execute(op, (op, entry) => ownerService.admit(op, entry.firstEntry));
	let storeClosed = false;
	const closeStore = async () => {
		if (storeClosed) return;
		storeClosed = true;
		await missions.close();
	};
	t.after(async () => {
		await schedules.stop();
		await scheduleStore.close();
		await f.sessions.shutdown();
		await closeStore();
	});
	return {
		...f,
		missions,
		missionService,
		schedules,
		journal,
		workspace,
		ownerService,
		models,
		closeStore,
		setCatalog: (value: ModelOption[]) => {
			catalog = value;
		},
		automations: (value: boolean) => {
			enabled = value;
		},
		owner,
		authority,
		enable,
		operation,
		run,
		due: async () => {
			now = schedules.store.require(owner.scheduleId).at!;
			await schedules.signal({ type: "online", online: true });
		},
	};
}

async function seedSource(f: Awaited<ReturnType<typeof fixture>>) {
	const sourceId = randomUUID(),
		dir = join(f.home, "sessions", sourceId);
	await mkdir(dir, { recursive: true });
	const source = {
		id: sourceId,
		projectId: f.project.id,
		mode: "ask" as const,
		title: "Synthetic source",
		cwd: f.project.path,
		createdAt: 1,
		updatedAt: 1,
	};
	// Load an actual metadata file through a fresh manager rather than fabricating ready metadata.
	const { writeFile } = await import("node:fs/promises");
	await writeFile(join(dir, "meta.json"), JSON.stringify(source));
	const owned = await openSessionStorage(join(dir, "durable"));
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			for (let n = 0; n < 10; n++)
				await tx.appendEntry(root.id, {
					kind: "pi.user",
					model: [{ role: "user", content: `Synthetic correction ${n}`, timestamp: 1 }],
				});
		}, context);
	} finally {
		await harness.close(context);
		owned.release();
	}
	// This reload reads the newly saved source. It starts no worker.
	await f.sessions.load();
	const sourceBytes = await readFile(join(dir, "meta.json"));
	return { sourceId, dir, sourceBytes };
}

test("fresh confirmed owner creates one inert report/rule, scheduler uses closed reader for two partial reports", async (t) => {
	const f = await fixture(t);
	assert.equal(f.workers.length, 0);
	const receipt = await f.run(f.enable);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal(f.workers.length, 0, "Enable is not a review");
	assert.equal(f.missions.list().length, 0, "No hidden mission");
	assert.equal(f.sessions.get(f.owner.reportSessionId)?.role, "insights");
	assert.equal((await f.stored(f.owner.reportSessionId)).insightsGrant, undefined);
	assert.equal(f.schedules.store.list().length, 1);
	assert.deepEqual(await f.run(f.enable), receipt);
	const { dir, sourceBytes } = await seedSource(f);
	f.schedules.start();
	for (let cycle = 0; cycle < 2; cycle++) {
		await f.due();
		const rule = f.schedules.store.require(f.owner.scheduleId),
			runId = rule.runs!.at(-1)!.insightsReview!.runId;
		assert.equal(
			(await f.sessions.insightsOwnerReviewStatus(f.owner.reportSessionId, runId))?.state,
			"sent",
			JSON.stringify(rule.runs),
		);
		let cursor: number | null = 0,
			excerpts = 0;
		do {
			const page = (await f.sessions.insightsOwnerBacklog(f.owner.reportSessionId, {
				action: "review_context",
				cursor,
			})) as { nextCursor: number | null; evidence: unknown; gaps: string[] };
			assert.ok(page.gaps.length);
			if (page.evidence) excerpts++;
			cursor = page.nextCursor;
		} while (cursor !== null);
		assert.ok(excerpts > 0, "Actual closed-reader receipts must be present");
		const request = f.missions["one"]("SELECT request FROM insights_owner_runs WHERE run_id=?", runId)!;
		const window = JSON.parse(String(request.request));
		await f.sessions.insightsOwnerBacklog(f.owner.reportSessionId, {
			action: "save_report",
			operationId: randomUUID(),
			key: runId,
			expectedRevision: 0,
			record: {
				status: "partial",
				windowStart: window.windowStart,
				windowEnd: window.windowEnd,
				markdown: "Synthetic observation only. No implementation permission.",
				checkpoints: [],
				findingKeys: [],
				gaps: ["Bounded sample only"],
			},
		});
		assert.equal((await f.sessions.insightsOwnerReviewStatus(f.owner.reportSessionId, runId))?.state, "partial");
		const worker = f.workers.at(-1)!;
		worker.state = "idle";
		worker.busy = false;
		worker["onPacket"]({ type: "working", working: false });
	}
	assert.equal(f.workers.length, 1, "Only the report worker starts");
	assert.equal(f.specs[0]!.insightsBinding, undefined);
	assert.equal(f.specs[0]!.mission, undefined);
	assert.deepEqual(f.specs[0]!.insightsOwnerBinding?.owner, f.owner);
	assert.deepEqual(await readFile(join(dir, "meta.json")), sourceBytes);
	assert.equal(Number(f.missions["one"]("SELECT COUNT(*) n FROM insights_owner_reports")!.n), 2);
	await f.assertSourceUnchanged();
});

test("concurrent confirmations cannot create another report, grant or rule", async (t) => {
	const f = await fixture(t);
	const other = f.operation("insights-workspace-enable", JSON.parse(f.enable.payload), f.owner.workspaceId);
	const results = await Promise.allSettled([f.run(f.enable), f.run(other)]);
	assert.equal(results.filter((r) => r.status === "fulfilled" && r.value.state === "accepted").length, 1);
	assert.equal(f.schedules.store.list().length, 1);
	assert.equal(Number(f.missions["one"]("SELECT COUNT(*) n FROM insights_owner_execution")!.n), 1);
	assert.equal(f.workers.length, 0);
});

test("owner recovery without an entered marker never reconstructs native grant consent", async (t) => {
	const f = await fixture(t);
	assert.equal(
		(
			await f.journal.execute(f.enable, async () => {
				throw new Error("Synthetic crash before native handler entry");
			})
		).state,
		"pending",
	);
	t.mock.method(f.models, "list", async () => {
		throw new Error("Recovery cannot read the catalog or reconstruct approval");
	});
	await f.journal.recover((op) => f.ownerService.admit(op, false));
	assert.equal((await f.journal.lookup(f.enable))!.state, "rejected");
	assert.equal(f.missions["one"]("SELECT COUNT(*) n FROM insights_owner_grants")!.n, 0);
	assert.equal(f.sessions.get(f.owner.reportSessionId), undefined);
});

test("owner confirmation cannot survive a new daemon admission epoch with identical home IDs", async (t) => {
	const f = await fixture(t);
	Object.defineProperty(f.sessions, "insightsAdmissionEpoch", { value: randomUUID() });
	assert.equal((await f.run(f.enable)).state, "rejected");
	assert.equal(f.missions["one"]("SELECT COUNT(*) n FROM insights_owner_grants")!.n, 0);
});

test("owner desired Save and lifecycle decisions do not change effective authority, rule or model", async (t) => {
	const f = await fixture(t);
	await f.run(f.enable);
	await assert.rejects(f.sessions.changeModel(f.owner.reportSessionId, model.id, f.models), /require_confirmed_apply/);
	const before = f.missions.insightsOwner.current(f.authority)!;
	const desired = (await f.workspace.settings()).record!;
	const save = f.operation(
		"insights-workspace-settings",
		{
			schemaVersion: 2,
			owner: f.owner,
			expectedRevision: desired.revision,
			settings: { ...desired.settings, budget: { ...desired.settings.budget, usd: 7 } },
		},
		f.owner.workspaceId,
	);
	assert.equal((await f.journal.execute(save, (op) => f.workspace.admit(op))).state, "accepted");
	assert.equal((await f.workspace.settings()).record!.revision, 2);
	assert.deepEqual(f.missions.insightsOwner.current(f.authority), before);
	assert.equal(f.schedules.store.require(f.owner.scheduleId).insightsSettingsRevision, 1);
	const trackingOnlyPause = f.operation(
		"insights-workspace-state",
		{ schemaVersion: 2, owner: f.owner, expectedRevision: 1, state: "paused" },
		f.owner.workspaceId,
	);
	assert.equal(
		(await f.journal.execute(trackingOnlyPause, (op) => f.workspace.admit(op))).state,
		"rejected",
		"A row-only Pause cannot replace real Stop",
	);
	assert.equal(f.workers.length, 0);
});

test("Check reports exact entered/committed receipts independently from current authority", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.ownerService.check(f.enable)).receipt.state, "absent");
	assert.equal(f.workers.length, 0);
	await f.run(f.enable);
	const check = await f.ownerService.check(f.enable);
	assert.equal(check.receipt.state, "committed");
	assert.equal(check.current.state, "enabled");
	assert.ok(!JSON.stringify(check).includes(f.home), "Public receipts and status disclose no private home/path");
	assert.equal(f.workers.length, 0);
});

async function desiredSave(f: Awaited<ReturnType<typeof fixture>>, usd: number) {
	const record = (await f.workspace.settings()).record!;
	const op = f.operation(
		"insights-workspace-settings",
		{
			schemaVersion: 2,
			owner: f.owner,
			expectedRevision: record.revision,
			settings: { ...record.settings, budget: { ...record.settings.budget, usd, basis: "user_choice" } },
		},
		f.owner.workspaceId,
	);
	assert.equal((await f.journal.execute(op, (op) => f.workspace.admit(op))).state, "accepted");
}
test("owner Apply requires fresh confirmation and admission, reuses one rule and leaves history intact", async (t) => {
	const f = await fixture(t);
	await f.run(f.enable);
	const before = f.missions.insightsOwner.current(f.authority)!;
	await desiredSave(f, 7);
	assert.equal(f.missions.insightsOwner.current(f.authority)!.settings.revision, 1);
	const apply = f.operation(
		"insights-workspace-apply",
		await f.ownerService.previewApply(f.owner),
		f.owner.workspaceId,
	);
	const result = await f.run(apply);
	assert.equal(result.state, "accepted", JSON.stringify(result));
	const after = f.missions.insightsOwner.current(f.authority)!;
	assert.equal(after.settings.revision, 2);
	assert.equal(after.settings.settings.budget.usd, 7);
	assert.notEqual(after.binding.grantId, before.binding.grantId);
	assert.equal(after.binding.revision, 2);
	assert.equal(f.schedules.store.list().length, 1);
	assert.equal(f.schedules.store.require(f.owner.scheduleId).insightsSettingsRevision, 2);
	assert.equal(f.workers.length, 0, "Settings-only Apply starts no review or worker");
	assert.equal(Number(f.missions["one"]("SELECT COUNT(*) n FROM insights_owner_grants")!.n), 2);
	assert.deepEqual(await f.run(apply), result);
});

test("cold model Apply keeps reported Default thinking, never the new model's switch default", async (t) => {
	let configurations = 0;
	const f = await fixture(
		t,
		{
			worker: (spec, onPacket) => {
				assert.equal(spec.configurationOnly, true);
				assert.equal(spec.stopOnOpen, true);
				let guardError: string | undefined;
				const worker: SessionWorker = {
					modelConfiguration: 1,
					ready: Promise.resolve(),
					state: "idle",
					busy: false,
					close: async () => {},
					send: (command) => {
						if (command.type === "model.configuration.result") guardError = command.error;
					},
					request: async (command) => {
						assert.equal(command.type, "changeModelConfiguration");
						if (command.type !== "changeModelConfiguration") throw new Error("No model turn permitted");
						assert.equal(command.thinking, "high", "preserve the native ready ACK, not omitted switch thinking");
						configurations++;
						onPacket({ type: "model.configuration.guard", callId: randomUUID(), requestId: command.requestId });
						if (guardError) throw new Error(guardError);
						onPacket({
							type: "modelChanged",
							requestId: command.requestId,
							model: command.model,
							thinking: command.thinking,
							usage: {},
						});
					},
				};
				queueMicrotask(() =>
					onPacket({
						type: "ready",
						model: spec.model!,
						thinking: "high",
						working: false,
						usage: {},
						modelConfiguration: 1,
					}),
				);
				return worker;
			},
		},
		{},
	);
	await f.run(f.enable);
	const changed = { ...model, id: "synthetic/terra-two", modelChangeThinking: "off" };
	f.setCatalog([model, changed]);
	const record = (await f.workspace.settings()).record!;
	const save = f.operation(
		"insights-workspace-settings",
		{
			schemaVersion: 2,
			owner: f.owner,
			expectedRevision: record.revision,
			settings: { ...record.settings, requestedModel: { kind: "id", value: changed.id } },
		},
		f.owner.workspaceId,
	);
	assert.equal((await f.journal.execute(save, (op) => f.workspace.admit(op))).state, "accepted");
	const apply = f.operation(
		"insights-workspace-apply",
		await f.ownerService.previewApply(f.owner),
		f.owner.workspaceId,
	);
	const receipt = await f.run(apply);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal(configurations, 1);
	assert.equal(f.missions.insightsOwner.current(f.authority)!.thinking, undefined, "Default preference is unchanged");
	assert.equal(f.missions.insightsOwner.current(f.authority)!.effectiveThinking, "high");
	const status = await f.ownerService.status(f.owner);
	assert.ok("thinkingSource" in status);
	assert.equal(status.thinkingSource, "default");
});

test("Stop reaches a configuration-only owner worker and vetoes fresh activation during model Apply", async (t) => {
	let f!: Awaited<ReturnType<typeof fixture>>,
		aborts = 0,
		stops = 0;
	f = await fixture(t, {
		worker: (spec, onPacket) => {
			let guardError: string | undefined;
			const worker: SessionWorker = {
				modelConfiguration: 1,
				ready: Promise.resolve(),
				state: "idle",
				busy: false,
				close: async () => {},
				send: (command) => {
					if (command.type === "model.configuration.result") guardError = command.error;
				},
				request: async (command) => {
					if (command.type === "abort") {
						aborts++;
						return;
					}
					assert.equal(command.type, "changeModelConfiguration");
					if (command.type !== "changeModelConfiguration") throw new Error("No model input permitted");
					assert.equal((await f.sessions.stop(spec.sessionId)).ok, true);
					stops++;
					onPacket({ type: "model.configuration.guard", callId: randomUUID(), requestId: command.requestId });
					assert.ok(guardError, "Stop must revoke the model change's original guard");
					throw new Error(guardError);
				},
			};
			queueMicrotask(() =>
				onPacket({
					type: "ready",
					model: spec.model!,
					thinking: "high",
					working: false,
					usage: {},
					modelConfiguration: 1,
				}),
			);
			return worker;
		},
	});
	assert.equal((await f.run(f.enable)).state, "accepted");
	const changed = { ...model, id: "synthetic/terra-two" };
	f.setCatalog([model, changed]);
	const record = (await f.workspace.settings()).record!;
	const save = f.operation(
		"insights-workspace-settings",
		{
			schemaVersion: 2,
			owner: f.owner,
			expectedRevision: record.revision,
			settings: { ...record.settings, requestedModel: { kind: "id", value: changed.id } },
		},
		f.owner.workspaceId,
	);
	assert.equal((await f.journal.execute(save, (op) => f.workspace.admit(op))).state, "accepted");
	const apply = f.operation(
		"insights-workspace-apply",
		await f.ownerService.previewApply(f.owner),
		f.owner.workspaceId,
	);
	assert.equal((await f.run(apply)).state, "pending");
	assert.equal(stops, 1);
	assert.equal(aborts, 1);
	assert.equal(f.missions.insightsOwner.current(f.authority)!.state, "configuring");
	assert.equal(f.sessions.insightsOwnerStatus(f.owner.reportSessionId)!.available, false);
	assert.equal((await f.run(apply)).state, "pending");
	assert.equal(stops, 1);
});

test("Apply after acknowledged Pause is a new grant, never ordinary Save reactivation", async (t) => {
	const f = await fixture(t);
	await f.run(f.enable);
	const current = f.missions.insightsOwner.current(f.authority)!;
	const pause = f.operation(
		"insights-workspace-pause",
		{
			schemaVersion: 2,
			owner: f.owner,
			expectedRevision: 1,
			reportInputGeneration: 0,
			grantRevision: current.binding.revision,
			rule: f.schedules.store.require(f.owner.scheduleId),
			disclosure: "insights-workspace-pause-v2",
		},
		f.owner.workspaceId,
	);
	assert.equal((await f.run(pause)).state, "accepted");
	await desiredSave(f, 8);
	assert.equal(f.sessions.insightsOwnerStatus(f.owner.reportSessionId)?.available, false);
	const apply = f.operation(
		"insights-workspace-apply",
		await f.ownerService.previewApply(f.owner),
		f.owner.workspaceId,
	);
	const result = await f.run(apply);
	assert.equal(result.state, "accepted", JSON.stringify(result));
	assert.equal(f.sessions.insightsOwnerStatus(f.owner.reportSessionId)?.available, true);
	assert.equal(f.missions.insightsOwner.current(f.authority)!.binding.revision, 3);
});

test("lost Apply final ACK recovers only its transaction receipt", async (t) => {
	const f = await fixture(t);
	await f.run(f.enable);
	await desiredSave(f, 9);
	const apply = f.operation(
		"insights-workspace-apply",
		await f.ownerService.previewApply(f.owner),
		f.owner.workspaceId,
	);
	const original = f.missions.insightsOwner.activate.bind(f.missions.insightsOwner);
	const fault = t.mock.method(f.missions.insightsOwner, "activate", async (...args: Parameters<typeof original>) => {
		await original(...args);
		throw new Error("Synthetic lost Apply ACK");
	});
	assert.equal((await f.run(apply)).state, "pending");
	fault.mock.restore();
	t.mock.method(f.models, "list", async () => {
		throw new Error("No catalog during receipt recovery");
	});
	assert.equal((await f.run(apply)).state, "accepted");
	assert.equal(Number(f.missions["one"]("SELECT COUNT(*) n FROM insights_owner_grants")!.n), 2);
	assert.equal(f.schedules.store.list().length, 1);
});

test("Stop after Apply rule ACK blocks activation and entered effects remain status-only", async (t) => {
	const f = await fixture(t);
	await f.run(f.enable);
	await desiredSave(f, 7);
	const apply = f.operation(
		"insights-workspace-apply",
		await f.ownerService.previewApply(f.owner),
		f.owner.workspaceId,
	);
	const original = f.schedules.rearmOwnerInsights.bind(f.schedules);
	let calls = 0;
	t.mock.method(f.schedules, "rearmOwnerInsights", async (...args: Parameters<typeof original>) => {
		calls++;
		const row = await original(...args);
		await f.sessions.stop(f.owner.reportSessionId);
		return row;
	});
	assert.equal((await f.run(apply)).state, "pending");
	assert.equal((await f.run(apply)).state, "pending");
	assert.equal(calls, 1);
	assert.equal(f.sessions.insightsOwnerStatus(f.owner.reportSessionId)?.available, false);
	assert.equal(f.missions.insightsOwner.current(f.authority)!.state, "provisioning");
	assert.equal((await f.ownerService.check(apply)).receipt.state, "entered");
});

test("concurrent Apply confirmations mint only one fresh grant and one rule revision", async (t) => {
	const f = await fixture(t);
	await f.run(f.enable);
	await desiredSave(f, 7);
	const payload = await f.ownerService.previewApply(f.owner),
		first = f.operation("insights-workspace-apply", payload, f.owner.workspaceId),
		second = f.operation("insights-workspace-apply", payload, f.owner.workspaceId);
	const receipts = await Promise.all([f.run(first), f.run(second)]);
	assert.equal(receipts.filter((r) => r.state === "accepted").length, 1);
	assert.equal(f.schedules.store.list().length, 1);
	assert.equal(f.schedules.store.require(f.owner.scheduleId).revision, 3);
	assert.equal(f.missions["one"]("SELECT COUNT(*) n FROM insights_owner_grants")!.n, 2);
});

test("cold recovery keeps owner receipts, grants and entered Apply effects without replay", async (t) => {
	const f = await fixture(t);
	await f.run(f.enable);
	await desiredSave(f, 9);
	const apply = f.operation(
		"insights-workspace-apply",
		await f.ownerService.previewApply(f.owner),
		f.owner.workspaceId,
	);
	const original = f.schedules.rearmOwnerInsights.bind(f.schedules);
	t.mock.method(f.schedules, "rearmOwnerInsights", async (...args: Parameters<typeof original>) => {
		await original(...args);
		throw new Error("Synthetic crash after rearm");
	});
	assert.equal((await f.run(apply)).state, "pending");
	const grantsBefore = f.missions["all"]("SELECT * FROM insights_owner_grants");
	await f.schedules.stop();
	await f.schedules.store.close();
	await f.sessions.shutdown();
	await f.closeStore();
	const store = new MissionStore(join(f.home, "missions.sqlite")),
		sessions = await f.manager();
	new MissionService(store, sessions, f.projects);
	sessions.setInsightsOwnerStore(store.insightsOwner);
	const schedules = new ScheduleService(new ScheduleStore(join(f.home, "schedules.sqlite")), {
		sessions,
		projects: f.projects,
		home: host,
		automationsEnabled: () => true,
	});
	await schedules.load();
	const journal = new OperationJournal(join(f.home, "operations"), host);
	const service = new InsightsOwner({
		home: f.home,
		projects: f.projects,
		models: { list: async () => assert.fail("Cold entered recovery cannot resolve or configure a model") },
		workspace: store.insightsWorkspace,
		store: store.insightsOwner,
		sessions,
		schedules,
		journal,
	});
	t.after(async () => {
		await schedules.stop();
		await schedules.store.close();
		await sessions.shutdown();
		await store.close();
	});
	assert.equal((await journal.execute(apply, (op) => service.apply(op))).state, "pending");
	assert.equal((await service.check(apply)).receipt.state, "entered");
	assert.equal((await service.status(f.owner)).state, "pending");
	assert.deepEqual(store["all"]("SELECT * FROM insights_owner_grants"), grantsBefore);
	assert.equal(schedules.store.list().length, 1);
	assert.equal(sessions.insightsOwnerStatus(f.owner.reportSessionId)?.available, false);
});

test("native owner HTTP admits Enable Save Apply Pause Revoke and passive Check without report startup", async (t) => {
	const f = await fixture(t);
	const args: Parameters<typeof createDaemonServer> = [
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		f.models as ModelCatalog,
		new TerminalManager(),
		{ store: f.missions, service: f.missionService },
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
	const read = async (path: string) => {
		const response = await fetch(`${root}/${path}`, { headers: { "x-pilot-github-capability": "native" } });
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal(response.headers.get("cache-control"), "no-store");
		return response.json();
	};
	const post = (path: string, body: unknown, native = true) =>
		fetch(`${root}/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(native ? { "x-pilot-github-capability": "native" } : {}) },
			body: JSON.stringify(body),
		});
	const execution = "insights/workspace/execution";
	assert.notEqual((await fetch(`${root}/${execution}`)).status, 200);
	assert.equal((await read(execution)).state, "not_activated");
	const enablePreview = await read(`${execution}/preflight`);
	const enable = f.operation("insights-workspace-enable", enablePreview.payload, f.owner.workspaceId);
	assert.notEqual((await post("operations", enable, false)).status, 200);
	assert.equal((await (await post(`${execution}/check`, enable)).json()).receipt.state, "absent");
	assert.equal(f.missions["one"]("SELECT COUNT(*) n FROM insights_owner_effects")!.n, 0);
	const original = f.missions.insightsOwner.activate.bind(f.missions.insightsOwner);
	const fault = t.mock.method(f.missions.insightsOwner, "activate", async (...params: Parameters<typeof original>) => {
		await original(...params);
		throw new Error("Synthetic native lost final ACK");
	});
	assert.equal((await (await post("operations", enable)).json()).state, "pending");
	fault.mock.restore();
	const check = await (await post(`${execution}/check`, enable)).json();
	assert.equal(check.receipt.state, "committed");
	assert.equal(check.current.state, "enabled");
	assert.equal(
		(await (await post("operations/receipt", enable)).json()).state,
		"pending",
		"Check does not settle the native journal",
	);
	assert.equal((await (await post("operations", enable)).json()).state, "accepted");
	const desired = (await read("insights/workspace/settings")).record;
	const save = f.operation(
		"insights-workspace-settings",
		{
			schemaVersion: 2,
			owner: f.owner,
			expectedRevision: desired.revision,
			settings: { ...desired.settings, budget: { ...desired.settings.budget, usd: 7 } },
		},
		f.owner.workspaceId,
	);
	assert.equal((await (await post("operations", save)).json()).state, "accepted");
	const apply = f.operation(
		"insights-workspace-apply",
		(await read(`${execution}/apply-preflight`)).payload,
		f.owner.workspaceId,
	);
	assert.equal((await (await post("operations", apply)).json()).state, "accepted");
	for (const state of ["pause", "revoke"] as const) {
		const preview = await read(`${execution}/${state}-preflight`);
		assert.equal(preview.state, "ready", JSON.stringify(preview));
		const op = f.operation(`insights-workspace-${state}`, preview.payload, f.owner.workspaceId);
		assert.equal((await (await post("operations", op)).json()).state, "accepted");
	}
	assert.equal((await read(execution)).state, "revoked");
	assert.equal(f.workers.length, 0);
	assert.equal(f.schedules.store.list().length, 1);
	assert.equal(f.missions.list().length, 0);
});

test("lost Enable ACK reconciles the exact transaction receipt, never catalog or effects", async (t) => {
	const f = await fixture(t),
		original = f.missions.insightsOwner.activate.bind(f.missions.insightsOwner);
	const fault = t.mock.method(f.missions.insightsOwner, "activate", async (...args: Parameters<typeof original>) => {
		await original(...args);
		throw new Error("Synthetic lost ACK");
	});
	assert.equal((await f.run(f.enable)).state, "pending");
	fault.mock.restore();
	t.mock.method(f.models, "list", async () => {
		throw new Error("Recovery must not resolve a model");
	});
	assert.equal((await f.run(f.enable)).state, "accepted");
	assert.equal(f.schedules.store.list().length, 1);
	assert.equal(f.workers.length, 0);
});

test("crash after entered report creation remains lookup-only and cannot mint a second grant", async (t) => {
	const f = await fixture(t),
		original = f.sessions.spawnInsightsOwnerDurable.bind(f.sessions);
	t.mock.method(f.sessions, "spawnInsightsOwnerDurable", async (...args: Parameters<typeof original>) => {
		await original(...args);
		throw new Error("Synthetic crash after create");
	});
	assert.equal((await f.run(f.enable)).state, "pending");
	const first = f.missions.insightsOwner.current(f.authority)!;
	assert.equal(first.state, "provisioning");
	assert.equal((await f.run(f.enable)).state, "pending");
	assert.equal(f.schedules.store.list().length, 0);
	assert.deepEqual(f.missions.insightsOwner.current(f.authority), first);
	assert.throws(() => f.sessions.insightsOwnerAdmission(f.owner.reportSessionId), /not_active/);
	await f.missions.durable();
	const { DatabaseSync } = await import("node:sqlite");
	const disk = new DatabaseSync(join(f.home, "missions.sqlite"), { readOnly: true });
	try {
		assert.equal(
			disk.prepare("SELECT state FROM insights_owner_effects WHERE operation_id=?").get(f.enable.operationId)!.state,
			"entered",
		);
	} finally {
		disk.close();
	}
});

test("Stop during rule creation prevents activation and retained effects never replay", async (t) => {
	const f = await fixture(t),
		original = f.schedules.createOwnerInsights.bind(f.schedules);
	t.mock.method(f.schedules, "createOwnerInsights", async (...args: Parameters<typeof original>) => {
		const rule = await original(...args);
		await f.sessions.stop(f.owner.reportSessionId);
		return rule;
	});
	assert.equal((await f.run(f.enable)).state, "pending");
	assert.equal(f.missions.insightsOwner.current(f.authority)!.state, "provisioning");
	assert.equal((await f.run(f.enable)).state, "pending");
	f.schedules.start();
	await f.due();
	assert.equal(f.workers.length, 0);
	assert.equal(f.schedules.store.require(f.owner.scheduleId).runs!.at(-1)!.outcome, "failed");
});

for (const state of ["pause", "revoke"] as const)
	test(`${state} fences actual owner execution, Stop, scheduled dispatch and closed writes`, async (t) => {
		const f = await fixture(t);
		assert.equal((await f.run(f.enable)).state, "accepted");
		f.schedules.start();
		await f.due();
		const lease = f.sessions.insightsOwnerAdmission(f.owner.reportSessionId);
		const current = f.missions.insightsOwner.current(f.authority)!;
		f.automations(false);
		const op = f.operation(
			`insights-workspace-${state}`,
			{
				schemaVersion: 2,
				owner: f.owner,
				expectedRevision: 1,
				reportInputGeneration: f.sessions.insightsOwnerControl(f.owner.reportSessionId).inputGeneration,
				grantRevision: current.binding.revision,
				rule: f.schedules.store.require(f.owner.scheduleId),
				disclosure: `insights-workspace-${state}-v2`,
			},
			f.owner.workspaceId,
		);
		const result = await f.run(op);
		assert.equal(result.state, "accepted", JSON.stringify(result));
		assert.throws(() => lease.revalidate(), /changed|not_active/);
		assert.equal(f.sessions.get(f.owner.reportSessionId)?.working, false);
		assert.equal(f.schedules.store.require(f.owner.scheduleId).state, "cancelled");
		assert.equal(f.missions.insightsOwner.current(f.authority)!.state, state === "pause" ? "paused" : "revoked");
		assert.throws(() => f.sessions.insightsOwnerAdmission(f.owner.reportSessionId), /not_active/);
		await assert.rejects(
			f.sessions.insightsOwnerBacklog(f.owner.reportSessionId, { action: "list", kind: "finding" }),
			/not_active/,
		);
		assert.equal((await f.run(op)).state, "accepted", "Exact receipt retry is not another Stop");
	});

test("unknown cancellation stays fenced and cannot repeat the cancellation or Enable", async (t) => {
	const f = await fixture(t);
	await f.run(f.enable);
	const current = f.missions.insightsOwner.current(f.authority)!;
	let cancels = 0;
	t.mock.method(f.schedules, "cancelOwnerInsights", async () => {
		cancels++;
		throw new Error("Synthetic unknown cancel");
	});
	const op = f.operation(
		"insights-workspace-pause",
		{
			schemaVersion: 2,
			owner: f.owner,
			expectedRevision: 1,
			reportInputGeneration: f.sessions.insightsOwnerControl(f.owner.reportSessionId).inputGeneration,
			grantRevision: current.binding.revision,
			rule: f.schedules.store.require(f.owner.scheduleId),
			disclosure: "insights-workspace-pause-v2",
		},
		f.owner.workspaceId,
	);
	assert.equal((await f.run(op)).state, "pending");
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(cancels, 1);
	assert.equal(f.missions.insightsOwner.current(f.authority)!.state, "paused");
	assert.equal(f.sessions.insightsOwnerStatus(f.owner.reportSessionId)?.available, false);
	assert.equal((await f.run(f.enable)).state, "accepted", "Historical receipt is separate from current authority");
});

test("Revoke after Pause uses the prior transaction ACK, not a matching cancelled rule", async (t) => {
	const f = await fixture(t);
	await f.run(f.enable);
	for (const state of ["pause", "revoke"] as const) {
		const current = f.missions.insightsOwner.current(f.authority)!;
		const op = f.operation(
			`insights-workspace-${state}`,
			{
				schemaVersion: 2,
				owner: f.owner,
				expectedRevision: 1,
				reportInputGeneration: f.sessions.insightsOwnerControl(f.owner.reportSessionId).inputGeneration,
				grantRevision: current.binding.revision,
				rule: f.schedules.store.require(f.owner.scheduleId),
				disclosure: `insights-workspace-${state}-v2`,
			},
			f.owner.workspaceId,
		);
		assert.equal((await f.run(op)).state, "accepted");
	}
	assert.equal(f.missions.insightsOwner.current(f.authority)!.state, "revoked");
	assert.equal(f.schedules.store.require(f.owner.scheduleId).revision, 2);
});

test("owner scheduler and closed tools complete two cycles through a real Harness with a faux provider", async (t) => {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({
		provider: "synthetic",
		models: [
			{ id: "terra", reasoning: true, contextWindow: 64000 },
			{ id: "terra-two", reasoning: true, contextWindow: 64000 },
		],
	});
	runtime.registerNativeProvider(faux.provider);
	const openAdapter = NativeAdapter.open;
	t.mock.method(globalThis, "fetch", () => assert.fail("No live provider or catalog access"));
	t.mock.method(NativeAdapter, "open", (options: Parameters<typeof NativeAdapter.open>[0]) => {
		assert.ok(
			!options.hostTools?.some((tool) => tool.name === "insights_history"),
			"Owner cannot list the legacy direct-history tool",
		);
		return openAdapter.call(NativeAdapter, {
			...options,
			agentDir: join(options.cwd, "..", "synthetic-agent"),
			projectTrusted: false,
			bundledExtensions: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
			sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
			loaderOptions: {
				cwd: options.cwd,
				agentDir: join(options.cwd, "..", "synthetic-agent"),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
	});
	let f!: Awaited<ReturnType<typeof fixture>>;
	let nextCursor: number | null = 0,
		activeRun = "",
		phase = "context",
		toolCalls = 0,
		launches = 0;
	const findingKey = randomUUID();
	const workers: SessionWorker[] = [];
	const factory: SessionFactories["worker"] = (spec, onPacket, onExit) => {
		launches++;
		let kernel!: KernelSession;
		const guards = new Map<string, { resolve(): void; reject(error: Error): void }>();
		const accounting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
		const worker: SessionWorker = {
			state: "idle",
			busy: false,
			modelConfiguration: 1,
			ready: Promise.resolve(),
			send: (command) => {
				if (command.type === "usage-history.epoch.result" || command.type === "usage-history.result") {
					const pending = accounting.get(command.callId);
					accounting.delete(command.callId);
					if (command.error) pending?.reject(new Error(command.error));
					else pending?.resolve(command.result);
					return;
				}
				if (command.type !== "model.configuration.result") return;
				const pending = guards.get(command.callId);
				guards.delete(command.callId);
				if (command.error) pending?.reject(new Error(command.error));
				else pending?.resolve();
			},
			request: async (command) => {
				await worker.ready;
				if (command.type === "input") {
					activeRun = command.requestId.slice("insights-review:".length);
					await kernel.submit(command.requestId, command.content, command.mode, command.onlyIfIdle);
				} else if (command.type === "changeModelConfiguration") {
					const result = await kernel.changeModel(command.model, command.thinking, {
						revalidate: () =>
							new Promise<void>((resolve, reject) => {
								const callId = randomUUID();
								guards.set(callId, { resolve, reject });
								onPacket({ type: "model.configuration.guard", callId, requestId: command.requestId });
							}),
					});
					onPacket({
						type: "modelChanged",
						requestId: command.requestId,
						model: kernel.model,
						thinking: kernel.thinkingLevel,
						usage: kernel.usage,
						...result,
					});
				} else if (command.type === "abort") {
					await kernel.abort();
				} else throw new Error(`Unexpected synthetic kernel command ${command.type}`);
			},
			close: async () => {
				await worker.ready;
				await kernel.close();
				onExit(worker, 0);
			},
			hasChildren: async () => {
				await worker.ready;
				return kernel.hasChildren();
			},
		};
		const ready = KernelSession.open(spec, {
			acquireUsageEpoch: () =>
				new Promise<import("../../kernel/src/usage-capture.ts").UsageCaptureEpoch>((resolve, reject) => {
					const callId = randomUUID();
					accounting.set(callId, {
						resolve: (v) => resolve(v as import("../../kernel/src/usage-capture.ts").UsageCaptureEpoch),
						reject,
					});
					onPacket({ type: "usage-history.epoch", callId });
				}),
			reportUsageHistory: (row) =>
				new Promise<import("@pilot/protocol").UsageHistoryWriteResult>((resolve, reject) => {
					const callId = randomUUID();
					accounting.set(callId, {
						resolve: (v) => resolve(v as import("@pilot/protocol").UsageHistoryWriteResult),
						reject,
					});
					onPacket({ type: "usage-history", callId, row });
				}),
			onWorking: (working) => {
				worker.state = working ? "working" : "idle";
				Object.assign(worker, { busy: working });
				onPacket({ type: "working", working });
			},
			callInsightsBacklog: async (request) => {
				toolCalls++;
				const result = await f.sessions.insightsOwnerBacklog(spec.sessionId, request, worker);
				if ((request as { action?: string }).action === "review_context")
					nextCursor = (result as { nextCursor: number | null }).nextCursor;
				return result;
			},
			callDiagnosticContext: async () => {
				throw new Error("Dispatched owner cannot request direct source history");
			},
		}).then((value) => {
			kernel = value;
			onPacket({ type: "ready", model: kernel.model, thinking: kernel.thinkingLevel, working: false, usage: {} });
		});
		Object.assign(worker, { ready });
		workers.push(worker);
		return worker;
	};
	f = await fixture(t, { worker: factory }, {});
	assert.equal((await f.run(f.enable)).state, "accepted");
	assert.equal(launches, 0);
	await seedSource(f);
	f.schedules.start();
	for (let cycle = 0; cycle < 2; cycle++) {
		nextCursor = 0;
		phase = "context";
		const respond = () => {
			if (phase === "context") {
				if (nextCursor !== null)
					return fauxAssistantMessage(
						fauxToolCall("insights_backlog", { action: "review_context", cursor: nextCursor }),
						{ stopReason: "toolUse" },
					);
				phase = "finding";
				return fauxAssistantMessage(fauxToolCall("insights_backlog", { action: "list", kind: "finding" }), {
					stopReason: "toolUse",
				});
			}
			if (phase === "finding") {
				phase = "report";
				return fauxAssistantMessage(
					fauxToolCall("insights_backlog", {
						action: cycle === 0 ? "propose" : "amend",
						operationId: randomUUID(),
						key: findingKey,
						expectedRevision: cycle,
						patternKey: "synthetic workflow repeated reads",
						draft: {
							title: "Repeated synthetic correction",
							priority: "medium",
							observation: "Synthetic fixture repeated a correction",
							uncertainty: "No real workflow or cost baseline",
							proposedChange: "Investigate only after separate approval",
							expectedBenefit: "Unknown",
							targets: [],
							implementationLinks: [],
						},
						evidence: [],
					}),
					{ stopReason: "toolUse" },
				);
			}
			if (phase === "report") {
				phase = "finish";
				const request = JSON.parse(
					String(f.missions["one"]("SELECT request FROM insights_owner_runs WHERE run_id=?", activeRun)!.request),
				);
				return fauxAssistantMessage(
					fauxToolCall("insights_backlog", {
						action: "save_report",
						operationId: randomUUID(),
						key: activeRun,
						expectedRevision: 0,
						record: {
							status: "partial",
							windowStart: request.windowStart,
							windowEnd: request.windowEnd,
							markdown: "Synthetic report. No comprehensive coverage or implementation approval.",
							checkpoints: [],
							findingKeys: [findingKey],
							gaps: ["Synthetic bounded sources only."],
						},
					}),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Saved a partial synthetic report.");
		};
		faux.setResponses(Array.from({ length: 20 }, () => respond));
		await f.due();
		await until(
			() =>
				f.missions["one"]("SELECT state FROM insights_owner_runs WHERE run_id=?", activeRun)?.state === "partial" &&
				workers[0]?.state === "idle",
		);
	}
	assert.equal(launches, 1);
	assert.ok(toolCalls >= 4);
	assert.equal(Number(f.missions["one"]("SELECT COUNT(*) n FROM insights_owner_reports")!.n), 2);
	assert.equal(
		Number(
			f.missions["one"]("SELECT revision FROM insights_workspace_items WHERE kind='finding' AND key=?", findingKey)!
				.revision,
		),
		2,
	);
	assert.ok(Number(f.missions["one"]("SELECT COUNT(*) n FROM insights_owner_sources")!.n) > 0);
	assert.equal(f.missions.list().length, 0);
	const oldAdmission = f.sessions.insightsOwnerAdmission(f.owner.reportSessionId);
	const oldSources = f.missions["all"]("SELECT * FROM insights_owner_sources");
	f.setCatalog([model, { ...model, id: "synthetic/terra-two", name: "Terra Two" }]);
	const desired = (await f.workspace.settings()).record!;
	const save = f.operation(
		"insights-workspace-settings",
		{
			schemaVersion: 2,
			owner: f.owner,
			expectedRevision: desired.revision,
			settings: { ...desired.settings, requestedModel: { kind: "id", value: "synthetic/terra-two" } },
		},
		f.owner.workspaceId,
	);
	assert.equal((await f.journal.execute(save, (op) => f.workspace.admit(op))).state, "accepted");
	const callsBeforeApply = faux.state.callCount;
	const apply = f.operation(
		"insights-workspace-apply",
		await f.ownerService.previewApply(f.owner),
		f.owner.workspaceId,
	);
	const applied = await f.run(apply);
	assert.equal(applied.state, "accepted", JSON.stringify(applied));
	assert.equal(faux.state.callCount, callsBeforeApply, "Configuration does not run the provider");
	assert.equal(f.sessions.get(f.owner.reportSessionId)?.model, "synthetic/terra-two");
	assert.equal(f.missions.insightsOwner.current(f.authority)!.settings.model, "synthetic/terra-two");
	assert.throws(() => oldAdmission.revalidate(), /changed/);
	assert.deepEqual(
		f.missions["all"]("SELECT * FROM insights_owner_sources"),
		oldSources,
		"Apply does not reset unfinished source positions",
	);
});

// biome-ignore-all lint/complexity/useLiteralKeys: Probe supervised IPC and persistence without a live provider.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { CredentialClient } from "@pilot/kernel/credential-client";
import { dayInsightsFauxWorkerEntry, openSessionStorage } from "@pilot/kernel/testing";
import {
	type DayInsightsReservation,
	installDayInsightsRuntime,
	KernelSession,
	NativeAdapter,
} from "@pilot/kernel/testing/runtime";
import type { DurableOperation, ModelOption, SessionCompletion } from "@pilot/protocol";
import type { HostCall, HostCallPacket, HostCalls } from "@pilot/kernel";
import { CredentialBroker } from "../../setup/credential-broker.ts";
import { DayInsights } from "../../day/insights/day-insights.ts";
import { DayInsightsExecution } from "../../day/insights/day-insights-execution.ts";
import { Conflict } from "../../runtime/contracts/errors.ts";
import { InsightsOwner, isInsightsOwnerOperation } from "./insights-owner.ts";
import { InsightsWorkspace } from "./insights-workspace.ts";
import { MissionService } from "../../missions/mission-service.ts";
import { MissionStore } from "../../missions/missions.ts";
import type { ModelCatalog } from "../../models/models.ts";
import { AIUsageLedger } from "../../models/usage/ai-usage.ts";
import { OperationJournal, payloadHash } from "../../transport/operations/operation-journal.ts";
import { ScheduleStore } from "../../schedules/schedule-store.ts";
import { ScheduleService } from "../../schedules/schedules.ts";
import { type SessionFactories } from "../../sessions/sessions.ts";
import { type SessionWorker, Worker } from "../../sessions/workers/kernel-worker.ts";
import { TerminalManager } from "../../sessions/terminals/terminals.ts";
import { createDaemonFixtureServer as createDaemonServer } from "../../testing/daemon-server.ts";
import { fixture as sessionFixture, until } from "../../testing/session-workspace.ts";

const host = { hostId: "daemon", daemonId: "synthetic", lineageId: "synthetic-lineage" };
const model: ModelOption = {
	id: "synthetic/terra",
	provider: "synthetic",
	name: "Terra 6.1",
	thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
};
async function fixture(
	t: TestContext,
	factories: import("../../sessions/sessions.ts").SessionFactories = {},
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
			schedules.insights.assertNoLegacyInsights(host);
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

async function seedSource(
	f: Awaited<ReturnType<typeof fixture>>,
	archivedAt?: string,
	marker = "",
	role?: "insights",
	project = f.project,
) {
	const sourceId = randomUUID(),
		dir = join(f.home, "sessions", sourceId);
	await mkdir(dir, { recursive: true });
	const source = {
		id: sourceId,
		projectId: project.id,
		mode: "ask" as const,
		title: "Synthetic source",
		cwd: project.path,
		createdAt: 1,
		updatedAt: 1,
		...(archivedAt === undefined ? {} : { archivedAt }),
		...(role === undefined ? {} : { role }),
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
					model: [{ role: "user", content: `Synthetic correction ${n} ${marker}`, timestamp: 1 }],
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

async function dayRuntimeFixture(
	t: TestContext,
	seed?: (home: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
	factories?: SessionFactories,
) {
	const f = await fixture(t, factories);
	await seed?.(f);
	const settings: import("@pilot/protocol").DayInsightsSettings = {
		model: model.id,
		thinking: "high",
		source: { projects: [f.project.id], excludeProjects: [], excludeSessions: [] },
		weekly: null,
		allowance: { perReportMicros: 1000000, monthlyMicros: 10000000, basis: "catalog_estimate" },
	};
	const attachDay = (sessions = f.sessions) => {
		const day = new DayInsights({
			home: f.home,
			host,
			projects: f.projects,
			models: f.models,
			store: f.missions.dayInsights,
			owners: f.missions.insightsOwner,
			workspace: f.missions.insightsWorkspace,
			sessions,
			allowance: f.missions.dayInsightsAllowance,
			admissionEpoch: sessions.insightsAdmissionEpoch,
			runtime: new DayInsightsExecution({
				sessions,
				owners: f.missions.insightsOwner,
				store: f.missions.dayInsights,
				schedules: f.schedules,
				journal: f.journal,
				models: f.models,
			}),
		});
		sessions.dayInsights = day;
		return day;
	};
	const day = attachDay();
	const intent = async (
		action: import("@pilot/protocol").DayInsightsAction,
		config: typeof settings | null = null,
	) => {
		const review = await day.preflight({
			action,
			expectedRevision: (await day.status()).revision,
			projectId: f.project.id,
			settings: config,
		});
		assert.ok(review.payload, JSON.stringify(review));
		return f.operation("day-insights", review.payload, f.owner.workspaceId);
	};
	const run = (op: DurableOperation) => f.journal.execute(op, (op, entry) => day.admit(op, entry.firstEntry));
	assert.equal((await run(await intent("apply", settings))).state, "accepted");
	return { ...f, day, settings, intent, runDay: run, attachDay };
}

async function seedGoneInsights(f: Awaited<ReturnType<typeof fixture>>, report: string, revision?: number) {
	const create = f.operation(
		"insights-create",
		{
			projectId: f.project.id,
			missionId: randomUUID(),
			model: model.id,
			disclosure: "insights-history-v1",
		},
		report,
	);
	assert.equal((await f.journal.execute(create, async () => ({ sessionId: report }))).state, "accepted");
	if (revision !== undefined) {
		const revoke = f.operation("insights-revoke", { expectedRevision: 1 }, report);
		assert.equal((await f.journal.execute(revoke, async () => ({ sessionId: report, revision }))).state, "accepted");
	}
}

test("Day setup accepts an exact revoked legacy chat that no longer exists", async (t) => {
	const report = randomUUID();
	const f = await dayRuntimeFixture(t, (f) => seedGoneInsights(f, report, 2));
	assert.equal((await f.day.status()).executionSupported, true);
	assert.equal((await f.day.status()).running, false);
	assert.equal(f.sessions.get(report), undefined);
	assert.equal((await f.journal.targetReceipts("insights-revoke", report)).length, 1);
});

for (const problem of ["missing-revoke", "wrong-revision", "remaining-storage"] as const) {
	test(`Day setup refuses a missing legacy chat with ${problem}`, async (t) => {
		await assert.rejects(
			dayRuntimeFixture(t, async (f) => {
				const report = randomUUID();
				await seedGoneInsights(
					f,
					report,
					problem === "missing-revoke" ? undefined : problem === "wrong-revision" ? 3 : 2,
				);
				if (problem === "remaining-storage") await mkdir(join(f.home, "sessions", report));
			}),
			/legacy_execution_not_proven_quiescent/,
		);
	});
}

test("Day Pause fences an older Apply across awaits and its generation cannot reactivate", async (t) => {
	const f = await dayRuntimeFixture(t);
	let arrived!: () => void, release!: () => void;
	const entered = new Promise<void>((r) => {
			arrived = r;
		}),
		hold = new Promise<void>((r) => {
			release = r;
		});
	t.after(release);
	const original = f.missions.insightsOwner.prepareDay;
	const fault = t.mock.method(f.missions.insightsOwner, "prepareDay", async (...args: Parameters<typeof original>) => {
		await original.apply(f.missions.insightsOwner, args);
		arrived();
		await hold;
	});
	const apply = await f.intent("apply", {
		...f.settings,
		allowance: { ...f.settings.allowance, perReportMicros: 2000000 },
	});
	const pending = f.runDay(apply);
	await entered;
	const pause = await f.intent("pause");
	assert.equal((await f.runDay(pause)).state, "accepted");
	assert.equal(f.missions.dayInsights.control(f.owner.workspaceId)?.enabled, 0);
	release();
	assert.equal((await pending).state, "pending");
	fault.mock.restore();
	assert.equal(f.missions.insightsOwner.current(f.authority)?.state, "paused");
	const superseded = await f.day.supersededReceipt(apply);
	assert.equal(superseded?.state, "rejected");
	assert.equal(superseded?.reason, "day_insights_superseded_by_pause");
	assert.deepEqual(superseded?.result, {
		state: "superseded",
		pauseOperationId: pause.operationId,
		execution: "not_inferred",
	});
	assert.equal((await f.runDay(apply)).state, "rejected", "Superseded effects never execute again");
	assert.equal((await f.day.status()).paused, true);
	assert.equal((await f.runDay(await f.intent("resume"))).state, "accepted");
});

test("Day schedule cannot claim an occurrence before exact Apply commit", async (t) => {
	const f = await dayRuntimeFixture(t);
	let arrived!: () => void, release!: () => void;
	const entered = new Promise<void>((r) => {
			arrived = r;
		}),
		hold = new Promise<void>((r) => {
			release = r;
		});
	t.after(release);
	const configure = f.missions.dayInsights.configure;
	const fault = t.mock.method(f.missions.dayInsights, "configure", async (...args: Parameters<typeof configure>) => {
		arrived();
		await hold;
		return configure.apply(f.missions.dayInsights, args);
	});
	const apply = await f.intent("apply", { ...f.settings, weekly: { day: 3, time: "12:00", timezone: "UTC" } });
	const pending = f.runDay(apply);
	await entered;
	f.schedules.start();
	await f.due();
	assert.equal(f.workers.length, 0);
	assert.equal(f.schedules.store.require(f.owner.scheduleId).runs?.length, 0);
	assert.equal(f.sessions.dayInsightsScheduleReady(f.owner.reportSessionId, 2), false);
	release();
	assert.equal((await pending).state, "accepted");
	fault.mock.restore();
	await f.schedules.signal({ type: "online", online: true });
	assert.equal(f.workers.length, 1);
	assert.equal(f.schedules.store.require(f.owner.scheduleId).runs?.length, 1);
	assert.equal((await f.runDay(await f.intent("pause"))).state, "accepted");
});

test("Day prepared excerpts expire before model-facing disclosure and final payload reservation", async (t) => {
	const f = await dayRuntimeFixture(t);
	const clock = Date.now();
	await seedSource(f, new Date(clock - 23 * 3600000).toISOString(), "AGE_LIMIT_MARKER");
	const run = await f.intent("run");
	assert.equal((await f.runDay(run)).state, "accepted");
	assert.equal((await f.day.status()).running, true);
	const before = Number(f.missions["one"]("SELECT COUNT(*) n FROM day_insights_allowance")!.n);
	const time = t.mock.method(Date, "now", () => clock + 2 * 3600000);
	const physical = {
		id: "terra",
		provider: "synthetic",
		api: "anthropic-messages",
		contextWindow: 100,
		maxTokens: 20,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
	};
	await assert.rejects(
		f.day.fundingRequest(
			f.owner.reportSessionId,
			{
				op: "funding-reserve",
				namespace: "pi",
				key: "expired-before-payload",
				value: { provider: physical.provider, model: physical.id, api: physical.api, outputTokens: 20 },
			},
			{ fundingModel: async () => physical } as unknown as Pick<
				import("../../models/shared-model-catalog.ts").SharedCatalogService,
				"fundingModel"
			>,
		),
		/eligibility_changed/,
	);
	assert.equal(Number(f.missions["one"]("SELECT COUNT(*) n FROM day_insights_allowance")!.n), before);
	assert.equal((await f.day.status()).running, false);
	assert.match((await f.day.status()).holdReason!, /eligibility_changed/);
	await assert.rejects(
		f.sessions.insightsOwnerBacklog(f.owner.reportSessionId, { action: "review_context", cursor: 0 }),
		/run_not_active/,
	);
	const packet = JSON.parse(
		String(f.missions["one"]("SELECT packet FROM insights_owner_runs WHERE run_id=?", run.operationId)!.packet),
	);
	assert.ok(packet.gaps.some((g: string) => g.includes("withheld before delivery")));
	time.mock.restore();
	assert.equal((await f.runDay(await f.intent("pause"))).state, "accepted");
});

test("Day denies metrics and other report engines while preserving passive history", async (t) => {
	const f = await dayRuntimeFixture(t);
	const engine = await seedSource(f, undefined, "OTHER_INSIGHTS_ENGINE_MARKER", "insights");
	const source = await seedSource(f);
	assert.equal(
		f.day.sourceAllowed({ id: engine.sourceId, projectId: f.project.id, role: "insights" }, Date.now()),
		false,
	);
	const run = await f.intent("run");
	assert.equal((await f.runDay(run)).state, "accepted");
	assert.equal(f.specs.at(-1)?.scopedMetrics, undefined);
	assert.throws(
		() =>
			f.sessions["scopedMetrics"](f.owner.reportSessionId, { action: "scoped_metrics", sessionId: source.sourceId }),
		/not admitted/,
	);
	const packet = String(
		f.missions["one"]("SELECT packet FROM insights_owner_runs WHERE run_id=?", run.operationId)!.packet,
	);
	assert.ok(!packet.includes("OTHER_INSIGHTS_ENGINE_MARKER"));
	assert.ok((await f.stored(engine.sourceId)).role === "insights", "Passive old metadata is kept");
	assert.equal((await f.runDay(await f.intent("pause"))).state, "accepted");
	assert.equal(await f.day.supersededReceipt(run), null, "Committed Run reservation receipts are never superseded");
});

test("Day samples chat history even when diagnostic inventory truncates mission context", async (t) => {
	const f = await dayRuntimeFixture(t);
	const source = await seedSource(f, undefined, "INSIGHTS_INVENTORY_SAMPLE");
	const mission = f.missions.create({ projectId: f.project.id, title: "Synthetic source mission" });
	f.missions.join(source.sourceId, mission.id);
	for (let n = 0; n < 10; n++)
		f.missions.addDecision(mission.id, `Synthetic decision ${n}: ${"text ".repeat(1000)}`, {}, "all");

	const diagnostic = await f.sessions.readDiagnosticContext({ action: "chats", host, limit: 4 });
	assert.equal(diagnostic.status, "partial", "Ordinary diagnostics still include and limit mission context");

	assert.equal((await f.runDay(await f.intent("run"))).state, "accepted");
	const context = await f.sessions.insightsOwnerBacklog(f.owner.reportSessionId, { action: "review_context" });
	assert.match(JSON.stringify(context), /INSIGHTS_INVENTORY_SAMPLE/, "Insights must reach the eligible chat history");
	assert.equal(f.workers.length, 1, "Only the report worker should start");
	assert.equal((await f.runDay(await f.intent("pause"))).state, "accepted");
});

test("Day first turn completes through real worker IPC without workspace access", async (t) => {
	let firstTurn: SessionCompletion | "workspace.prepare" | "worker exited" | undefined;
	const f = await dayRuntimeFixture(t, undefined, {
		worker(spec, onPacket, onExit) {
			assert.ok(spec.dayInsightsRunId);
			const home = join(spec.cwd, "..");
			const child = fork(dayInsightsFauxWorkerEntry, {
				execArgv: [],
				env: { HOME: home, PATH: process.env.PATH, NODE_ENV: "test", PI_OFFLINE: "1" },
				serialization: "advanced",
			});
			return new Worker(
				spec,
				(packet) => {
					onPacket(packet);
					if (packet.type === "workspace.prepare") firstTurn ??= packet.type;
					if (packet.type === "working" && !packet.working) firstTurn ??= packet.completion;
				},
				(...args) => {
					firstTurn ??= "worker exited";
					onExit(...args);
				},
				undefined,
				{ child },
			);
		},
	});
	assert.equal((await f.runDay(await f.intent("run"))).state, "accepted");
	await until(() => firstTurn !== undefined);
	assert.notEqual(firstTurn, "workspace.prepare", "The closed daemon drops workspace.prepare, stalling generation");
	assert.equal(typeof firstTurn === "object" && firstTurn.outcome, "done", JSON.stringify(firstTurn));
});

test("Day proposes from current evidence without prior reads and refuses duplicate pattern keys", async (t) => {
	const f = await dayRuntimeFixture(t);
	await seedSource(f, undefined, "CURRENT_REVIEW_EVIDENCE");
	assert.equal((await f.runDay(await f.intent("run"))).state, "accepted");
	const backlog = (request: unknown) => f.sessions.insightsOwnerBacklog(f.owner.reportSessionId, request);
	const context = (await backlog({ action: "review_context" })) as {
		limitations: string;
		evidence: { sessionId: string; receipt: import("@pilot/protocol").DiagnosticContextResponse };
	};
	assert.match(JSON.stringify(context.evidence), /CURRENT_REVIEW_EVIDENCE/);
	assert.doesNotMatch(context.limitations, /Page prior findings/);
	assert.match(context.limitations, /Propose from current evidence/i);
	const proposal = {
		action: "propose",
		key: randomUUID(),
		operationId: randomUUID(),
		expectedRevision: 0,
		patternKey: "synthetic workflow repeated reads",
		draft: {
			title: "Repeated synthetic correction",
			priority: "medium",
			observation: "The current synthetic sample contains a repeated correction",
			uncertainty: "Limited sample",
			proposedChange: "Investigate the workflow",
			expectedBenefit: "Fewer repeated corrections",
			targets: [],
			implementationLinks: [],
		},
		evidence: [
			{
				key: randomUUID(),
				sessionId: context.evidence.sessionId,
				ref: (context.evidence.receipt.data as unknown as import("@pilot/protocol").DiagnosticHistoryPage)
					.entries[0]!.ref,
				observedAt: context.evidence.receipt.collectedAt,
				classification: "observed",
				summary: "A source excerpt records a correction.",
			},
		],
	};
	await backlog(proposal);
	assert.deepEqual(await backlog({ action: "list", kind: "finding" }), {
		items: [],
		nextCursor: null,
		state: "unavailable",
		reason: "prior_tracking_not_in_fresh_report_context",
	});
	await assert.rejects(backlog({ ...proposal, operationId: randomUUID(), key: randomUUID() }), (error: Error) => {
		assert.match(error.message, /pattern_already_recorded/);
		assert.ok(!error.message.includes(proposal.key));
		return true;
	});
	assert.equal((await f.runDay(await f.intent("pause"))).state, "accepted");
});

test("Day exposes partial cost for sampled chats and accepts proposals for a selected non-report project", async (t) => {
	const f = await dayRuntimeFixture(t);
	const path = join(f.home, "second-project");
	await mkdir(path);
	const project = await f.projects.create({ path });
	const { sourceId } = await seedSource(f, undefined, "REPEATED_CORRECTION_SECOND_PROJECT", undefined, project);
	const { sourceId: reportProjectSource } = await seedSource(f, undefined, "REPEATED_CORRECTION_REPORT_PROJECT");
	const usage = new AIUsageLedger(f.home);
	const scope = (kind: "model_requests" | "child_operations", estimate?: number) => ({
		tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoningStatus: "unavailable" as const },
		cost: {
			estimateStatus: estimate === undefined ? ("unavailable" as const) : ("catalog_estimate" as const),
			...(estimate === undefined ? {} : { estimatedUsdMicros: estimate, pricingRevision: "pi-ai@1.3.0" }),
			billedStatus: "unavailable" as const,
			subscriptionCoverage: "unknown" as const,
		},
		activity: {
			kind,
			count: 1,
			success: 1,
			failure: 0,
			cancelled: 0,
			usageReports: 1,
			providerAttemptsObserved: 1,
			requestRetriesObserved: 0,
			elapsedMsObserved: 0,
			activeMsObserved: 0,
			outcomeCoverage: "partial" as const,
			timingCoverage: "partial" as const,
		},
	});
	usage.observeUsage(sourceId, {
		conversationId: "0",
		activityEpoch: "initial",
		epochKind: "initial",
		observedAt: 1000,
		timingBoot: randomUUID(),
		direct: scope("model_requests", 12_345),
		child: scope("child_operations"),
	});
	await usage.close();
	await f.sessions.load();
	const settings = { ...f.settings, source: { ...f.settings.source, projects: [f.project.id, project.id] } };
	assert.equal((await f.runDay(await f.intent("apply", settings))).state, "accepted");
	assert.equal((await f.runDay(await f.intent("run"))).state, "accepted");

	const backlog = (request: unknown) => f.sessions.insightsOwnerBacklog(f.owner.reportSessionId, request);
	type Sample = {
		sessionId: string;
		receipt: { collectedAt: string; data: { entries: { ref: string; excerpt: string }[]; sessionCost: unknown } };
	};
	const samples = new Map<string, Sample>();
	let cursor: number | null = 0;
	while (cursor !== null) {
		const page = (await backlog({ action: "review_context", cursor })) as {
			evidence: Sample | null;
			nextCursor: number | null;
		};
		if (page.evidence) samples.set(page.evidence.sessionId, page.evidence);
		assert.notEqual(cursor, page.nextCursor);
		cursor = page.nextCursor;
	}
	assert.equal(samples.size, 2, "The same report can compare evidence across selected projects");
	const secondSample = samples.get(sourceId)!;
	assert.match(secondSample.receipt.data.entries[0]!.excerpt, /REPEATED_CORRECTION_SECOND_PROJECT/);
	assert.match(
		samples.get(reportProjectSource)!.receipt.data.entries[0]!.excerpt,
		/REPEATED_CORRECTION_REPORT_PROJECT/,
	);
	assert.deepEqual(secondSample.receipt.data.sessionCost, {
		coverage: "retained_session_usage_partial",
		observedAt: 1000,
		direct: { status: "catalog_estimate", estimatedUsdMicros: 12_345 },
		child: { status: "unavailable", estimatedUsdMicros: null },
	});
	const proposal = {
		action: "propose",
		key: randomUUID(),
		operationId: randomUUID(),
		expectedRevision: 0,
		patternKey: `${project.id} synthetic correction check`,
		draft: {
			title: "Catch the repeated correction",
			priority: "low",
			observation: "Two sampled chats record the same correction",
			uncertainty: "Other projects may have different checks",
			proposedChange: "Add a regression check in the source project",
			expectedBenefit: "Catch this failure before review",
			targets: [{ projectId: project.id, label: "Source project" }],
			implementationLinks: [],
		},
		evidence: Array.from(samples.values(), (sample) => ({
			key: randomUUID(),
			sessionId: sample.sessionId,
			ref: sample.receipt.data.entries[0]!.ref,
			observedAt: sample.receipt.collectedAt,
			classification: "observed",
			summary: "A correction entered the chat.",
		})),
	};
	await assert.rejects(
		backlog({
			...proposal,
			draft: { ...proposal.draft, targets: [{ projectId: randomUUID(), label: "Not selected" }] },
		}),
		/finding_target_outside_selected_projects/,
	);
	const receipt = (await backlog(proposal)) as { key: string; revision: number };
	assert.equal(receipt.key, proposal.key);
	assert.equal(receipt.revision, 1);
	assert.equal(f.workers.length, 1, "A report never starts implementation or wakes a source chat");
	assert.equal((await f.runDay(await f.intent("pause"))).state, "accepted");
});

test("Day idle without report settles both stores and permits only a distinct run", async (t) => {
	const f = await dayRuntimeFixture(t);
	const op = await f.intent("run");
	assert.equal((await f.runDay(op)).state, "accepted");
	const worker = f.workers.at(-1)!;
	worker.state = "idle";
	worker.busy = false;
	worker["onPacket"]({ type: "working", working: false });
	await f.missions.durable();
	assert.equal(f.missions.dayInsights.run(op.operationId)?.state, "held");
	assert.equal(
		f.missions["one"]("SELECT state FROM insights_owner_runs WHERE run_id=?", op.operationId)?.state,
		"held",
	);
	assert.equal((await f.day.status()).uncertainOperationId, null);
	const next = await f.intent("run");
	assert.notEqual(next.operationId, op.operationId);
	assert.equal((await f.runDay(next)).state, "accepted");
	assert.equal(f.workers.length, 2);
	assert.equal((await f.runDay(await f.intent("pause"))).state, "accepted");
});

test("Day unavailable input placement stays uncertain until native Pause", async (t) => {
	const f = await dayRuntimeFixture(t);
	const fault = t.mock.method(f.sessions, "dispatchInsightsOwnerReview", async () => {
		throw new Error("Synthetic lost placement ACK");
	});
	const op = await f.intent("run");
	assert.equal((await f.runDay(op)).state, "accepted");
	fault.mock.restore();
	assert.equal(f.missions.dayInsights.run(op.operationId)?.state, "unknown");
	assert.equal((await f.day.status()).uncertainOperationId, op.operationId);
	assert.equal(
		(
			await f.day.preflight({
				action: "run",
				expectedRevision: (await f.day.status()).revision,
				projectId: f.project.id,
				settings: null,
			})
		).state,
		"blocked",
	);
	assert.equal((await f.runDay(await f.intent("pause"))).state, "accepted");
});

test("Day Pause cancels a cold report without reopening its worker", async (t) => {
	const f = await dayRuntimeFixture(t);
	const run = await f.intent("run");
	assert.equal((await f.runDay(run)).state, "accepted");
	const worker = f.workers[0]!;
	worker.state = "failed";
	worker["onExit"](worker, 1);
	await f.missions.durable();
	const receipt = await f.runDay(await f.intent("pause"));
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal(f.workers.length, 1);
	assert.equal((await f.runDay(await f.intent("resume"))).state, "accepted");
	assert.equal((await f.runDay(await f.intent("run"))).state, "accepted");
	assert.equal(f.workers.length, 2);
	assert.equal(worker.requests.filter((request) => request.type === "input").length, 1);
	assert.notEqual(f.specs[1]?.dayInsightsRunId, run.operationId);
	assert.equal((await f.runDay(await f.intent("pause"))).state, "accepted");
});

test("Day startup clears a stranded Stop only for an already cancelled report", async (t) => {
	const f = await dayRuntimeFixture(t);
	const run = await f.intent("run");
	assert.equal((await f.runDay(run)).state, "accepted");
	assert.equal((await f.runDay(await f.intent("pause"))).state, "accepted");
	assert.equal((await f.runDay(await f.intent("resume"))).state, "accepted");
	const path = join(f.home, "sessions", f.owner.reportSessionId, "meta.json");
	const saved = JSON.parse(await readFile(path, "utf8"));
	// Reproduce metadata left by earlier versions when their cold Stop tried to open a cancelled run.
	for (const [runId, state] of [
		[randomUUID(), "blocked"],
		[run.operationId, "ready"],
	]) {
		await writeFile(
			path,
			JSON.stringify({
				...saved,
				insightsReviewRun: runId,
				pending: [{ type: "abort", requestId: randomUUID() }],
				kernelRestartPending: true,
				inputError: "Synthetic interrupted input",
				failure: "Session startup: day_insights_run_not_active",
			}),
		);
		const restarted = await f.manager();
		restarted.setInsightsWorkspaceStore(f.missions.insightsWorkspace);
		restarted.setInsightsOwnerStore(f.missions.insightsOwner);
		const day = f.attachDay(restarted);
		await day.recoverCancelledStop();
		const review = await day.preflight({
			action: "run",
			expectedRevision: (await day.status()).revision,
			projectId: f.project.id,
			settings: null,
		});
		assert.equal(review.state, state, JSON.stringify(review));
		await restarted.shutdown();
	}
	assert.equal(f.workers.length, 1, "Startup recovery and review must not open a report worker");
	assert.equal(f.missions.dayInsights.run(run.operationId)?.state, "cancelled");
});

test("Day manual Apply starts no worker; explicit Run uses closed reader, allowances, Pause and distinct Resume", async (t) => {
	const f = await fixture(t);
	const runtime = new DayInsightsExecution({
		sessions: f.sessions,
		owners: f.missions.insightsOwner,
		store: f.missions.dayInsights,
		schedules: f.schedules,
		journal: f.journal,
		models: f.models,
	});
	const day = new DayInsights({
		home: f.home,
		host,
		projects: f.projects,
		models: f.models,
		store: f.missions.dayInsights,
		owners: f.missions.insightsOwner,
		workspace: f.missions.insightsWorkspace,
		runtime,
		sessions: f.sessions,
		allowance: f.missions.dayInsightsAllowance,
		admissionEpoch: f.sessions.insightsAdmissionEpoch,
	});
	f.sessions.dayInsights = day;
	const settings: import("@pilot/protocol").DayInsightsSettings = {
		model: model.id,
		thinking: "high",
		source: { projects: [f.project.id], excludeProjects: [], excludeSessions: [] },
		weekly: null,
		allowance: { perReportMicros: 1000000, monthlyMicros: 10000000, basis: "catalog_estimate" },
	};
	const submit = async (
		action: import("@pilot/protocol").DayInsightsAction,
		config: typeof settings | null = null,
	) => {
		const review = await day.preflight({
			action,
			expectedRevision: (await day.status()).revision,
			projectId: f.project.id,
			settings: config,
		});
		assert.ok(review.payload, JSON.stringify(review));
		const op = f.operation("day-insights", review.payload, f.owner.workspaceId);
		const receipt = await f.journal.execute(op, (op, entry) => day.admit(op, entry.firstEntry));
		assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
		return op;
	};
	await submit("apply", settings);
	assert.equal(f.workers.length, 0);
	assert.equal(f.schedules.store.list().length, 0);
	const { sourceBytes, dir } = await seedSource(f);
	const recent = await seedSource(f, new Date(Date.now() - 3600000).toISOString());
	const expired = await seedSource(f, new Date(Date.now() - 90000000).toISOString());
	const excluded = await seedSource(f);
	settings.source.excludeSessions = [excluded.sourceId];
	await submit("apply", settings);
	const op = await submit("run");
	assert.equal(f.workers.length, 1);
	assert.equal((await day.status()).running, true);
	let cursor: number | null = 0,
		evidence = 0;
	const seen = new Set<string>();
	do {
		const page = (await f.sessions.insightsOwnerBacklog(f.owner.reportSessionId, {
			action: "review_context",
			cursor,
		})) as { nextCursor: number | null; evidence: unknown; gaps: string[] };
		assert.ok(page.gaps.length);
		if (page.evidence) {
			evidence++;
			seen.add((page.evidence as { sessionId: string }).sessionId);
		}
		cursor = page.nextCursor;
	} while (cursor !== null);
	assert.ok(evidence > 0);
	assert.ok(seen.has(recent.sourceId), "Recently archived chat includes its old messages");
	assert.ok(!seen.has(expired.sourceId));
	assert.ok(!seen.has(excluded.sourceId));
	assert.deepEqual(await readFile(join(dir, "meta.json")), sourceBytes);
	const physical = {
		id: "terra",
		provider: "synthetic",
		api: "anthropic-messages",
		contextWindow: 100,
		maxTokens: 20,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
	};
	const catalog = { fundingModel: async () => physical } as unknown as Pick<
		import("../../models/shared-model-catalog.ts").SharedCatalogService,
		"fundingModel"
	>;
	const broker = new CredentialBroker(join(f.home, "synthetic-credentials"));
	await broker.start();
	broker.fundingRequest = async (binding, request) => {
		assert.equal(binding, f.owner.reportSessionId);
		return day.fundingRequest(f.owner.reportSessionId, request, catalog);
	};
	const client = new CredentialClient(broker.grant(false, undefined, f.owner.reportSessionId));
	t.after(async () => {
		client.close();
		await broker.close();
	});
	const funded = await client.request({
		op: "funding-reserve",
		namespace: "pi",
		key: "request-one",
		value: { provider: physical.provider, model: physical.id, api: physical.api, outputTokens: 20 },
	});
	assert.deepEqual(funded, { requestId: "request-one", perReportReserved: true, monthlyReserved: true });
	assert.ok((await day.status()).remaining.uncertainMicros! > 0);
	await client.request({
		op: "funding-settle",
		namespace: "pi",
		key: "request-one",
		value: { input: 5, output: 2, cacheRead: 0, cacheWrite: 5, cacheWrite1h: 5 },
	});
	assert.equal((await day.status()).remaining.uncertainMicros, 0);
	await submit("pause");
	assert.equal((await day.status()).paused, true);
	assert.equal((await day.status()).running, false);
	const weekly = { ...settings, weekly: { day: 2, time: "10:30", timezone: "Europe/Paris" } };
	await submit("apply", weekly);
	assert.equal((await day.status()).paused, true);
	assert.equal((await day.status()).nextAt, null);
	await submit("resume");
	assert.equal((await day.status()).paused, false);
	assert.ok((await day.status()).nextAt);
	f.schedules.start();
	await f.due();
	assert.equal((await day.status()).running, true);
	assert.equal(f.schedules.store.require(f.owner.scheduleId).runs?.length, 1);
	await submit("pause");
	assert.equal(f.schedules.store.require(f.owner.scheduleId).state, "cancelled");
	assert.equal((await day.status()).nextAt, null);
	await submit("resume");
	assert.equal(f.schedules.store.require(f.owner.scheduleId).state, "pending");
	assert.equal(f.schedules.store.require(f.owner.scheduleId).runs?.length, 1);
	assert.equal(
		(await f.sessions.insightsOwnerReviewStatus(f.owner.reportSessionId, op.operationId))?.state,
		"cancelled",
	);
	const disabled = new DayInsights({
		home: f.home,
		host,
		projects: f.projects,
		models: f.models,
		store: f.missions.dayInsights,
		workspace: f.missions.insightsWorkspace,
		sessions: f.sessions,
		allowance: f.missions.dayInsightsAllowance,
		admissionEpoch: f.sessions.insightsAdmissionEpoch,
	});
	f.sessions.dayInsights = disabled;
	assert.equal((await disabled.status()).executionSupported, false);
	assert.throws(() => f.sessions.insightsOwnerAdmission(f.owner.reportSessionId), /adapter_unavailable/);
	const launches = f.workers.length;
	await f.due();
	assert.equal(f.workers.length, launches);
	await assert.rejects(
		disabled.fundingRequest(
			f.owner.reportSessionId,
			{ op: "funding-reserve", namespace: "pi", key: "disabled", value: {} },
			catalog,
		),
		/funding_unavailable/,
	);
	const denial = await disabled.preflight({
		action: "pause",
		expectedRevision: (await disabled.status()).revision,
		projectId: f.project.id,
		settings: null,
	});
	assert.ok(denial.payload);
	const denyOp = f.operation("day-insights", denial.payload, f.owner.workspaceId);
	assert.equal(
		(await f.journal.execute(denyOp, (op, entry) => disabled.admit(op, entry.firstEntry))).state,
		"accepted",
	);
	assert.equal(f.missions.insightsOwner.current(f.authority)?.state, "paused");
});

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
						if (command.type === "host.result") guardError = command.error;
					},
					request: async (command) => {
						assert.equal(command.type, "changeModelConfiguration");
						if (command.type !== "changeModelConfiguration") throw new Error("No model turn permitted");
						assert.equal(command.thinking, "high", "preserve the native ready ACK, not omitted switch thinking");
						configurations++;
						onPacket({
							type: "host.call",
							method: "model.configuration.guard",
							callId: randomUUID(),
							args: { requestId: command.requestId },
						});
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
					if (command.type === "host.result") guardError = command.error;
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
					onPacket({
						type: "host.call",
						method: "model.configuration.guard",
						callId: randomUUID(),
						args: { requestId: command.requestId },
					});
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
	const original = f.schedules.insights.rearmOwnerInsights.bind(f.schedules.insights);
	let calls = 0;
	t.mock.method(f.schedules.insights, "rearmOwnerInsights", async (...args: Parameters<typeof original>) => {
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
	const original = f.schedules.insights.rearmOwnerInsights.bind(f.schedules.insights);
	t.mock.method(f.schedules.insights, "rearmOwnerInsights", async (...args: Parameters<typeof original>) => {
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

test("Day production HTTP installs the qualified adapter and admits inert Apply then explicit Run/Pause", async (t) => {
	const f = await fixture(t);
	f.automations(false);
	const args: Parameters<typeof createDaemonServer>[0] = {
		config: { home: f.home, host: "127.0.0.1", port: 0 },
		sessions: f.sessions,
		projects: f.projects,
		models: f.models as ModelCatalog,
		terminals: new TerminalManager(),
		missions: { store: f.missions, service: f.missionService },
		schedules: f.schedules,
		hello: {
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
		},
		nativeAuthority: {
			authenticate: async (token: unknown) => {
				if (token !== "native") throw new Conflict("Native confirmation required");
			},
		},
	};
	const server = createDaemonServer(args);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	});
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const headers = { "content-type": "application/json", "x-pilot-github-capability": "native" };
	const get = async () => await (await fetch(`${root}/insights/day`, { headers })).json();
	const post = async (path: string, value: unknown) =>
		await (await fetch(`${root}/${path}`, { method: "POST", headers, body: JSON.stringify(value) })).json();
	assert.equal((await get()).executionSupported, true);
	const settings: import("@pilot/protocol").DayInsightsSettings = {
		model: model.id,
		thinking: "high",
		source: { projects: [f.project.id], excludeProjects: [], excludeSessions: [] },
		weekly: null,
		allowance: { perReportMicros: 1000000, monthlyMicros: 10000000, basis: "catalog_estimate" },
	};
	const submit = async (action: string, config: typeof settings | null) => {
		const preview = await post("insights/day/preflight", {
			action,
			expectedRevision: (await get()).revision,
			projectId: f.project.id,
			settings: config,
		});
		assert.equal(preview.state, "ready", JSON.stringify(preview));
		const op = f.operation("day-insights", preview.payload, f.owner.workspaceId);
		assert.equal((await post("operations", op)).state, "accepted");
		return op;
	};
	await submit("apply", settings);
	assert.equal(f.workers.length, 0);
	assert.equal(f.schedules.store.list().length, 0);
	const run = await submit("run", null);
	assert.equal(f.workers.length, 1);
	await submit("pause", null);
	assert.equal((await get()).paused, true);
	assert.equal((await post("operations/receipt", run)).state, "accepted");
	assert.equal((await get()).running, false);
});

test("native owner HTTP admits Enable Save Apply Pause Revoke and passive Check without report startup", async (t) => {
	const f = await fixture(t);
	const args: Parameters<typeof createDaemonServer>[0] = {
		config: { home: f.home, host: "127.0.0.1", port: 0 },
		sessions: f.sessions,
		projects: f.projects,
		models: f.models as ModelCatalog,
		terminals: new TerminalManager(),
		missions: { store: f.missions, service: f.missionService },
	};
	args.schedules = f.schedules;
	args.hello = {
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
	args.nativeAuthority = {
		authenticate: async (token: unknown) => {
			if (token !== "native") throw new Conflict("Native confirmation required");
		},
	};
	const server = createDaemonServer(args);
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
		original = f.schedules.insights.createOwnerInsights.bind(f.schedules.insights);
	t.mock.method(f.schedules.insights, "createOwnerInsights", async (...args: Parameters<typeof original>) => {
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
	t.mock.method(f.schedules.insights, "cancelOwnerInsights", async () => {
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

for (const freshDay of [false, true])
	test(
		freshDay
			? "Day fresh contexts exclude prior transcript and tracking after scope narrows"
			: "owner scheduler and closed tools complete two cycles through a real Harness with a faux provider",
		async (t) => {
			const runtime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
				modelsStore: new InMemoryModelsStore(),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const faux = fauxProvider({
				provider: "synthetic",
				...(freshDay ? { api: "anthropic-messages" } : {}),
				models: [
					{
						id: "terra",
						reasoning: true,
						contextWindow: 64000,
						maxTokens: 1024,
						cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
					},
					{ id: "terra-two", reasoning: true, contextWindow: 64000 },
				],
			});
			if (freshDay) {
				const original = faux.provider.streamSimple.bind(faux.provider);
				const physical: typeof original = (chosen, payload, options) => {
					const out = createAssistantMessageEventStream();
					void (async () => {
						try {
							await options?.onPayload?.({ model: chosen.id, max_tokens: chosen.maxTokens }, chosen);
							const source = original(chosen, payload, options);
							for await (const event of source) out.push(event);
							out.end(await source.result());
						} catch (error) {
							const message = {
								...fauxAssistantMessage("", { stopReason: "error", errorMessage: String(error) }),
								api: chosen.api,
								provider: chosen.provider,
								model: chosen.id,
							};
							out.push({ type: "error", reason: "error", error: message });
							out.end(message);
						}
					})();
					return out;
				};
				runtime.registerNativeProvider({
					...faux.provider,
					stream: (chosen, payload, options) =>
						physical(chosen, payload, { onPayload: options?.onPayload, signal: options?.signal }),
					streamSimple: physical,
				});
			} else runtime.registerNativeProvider(faux.provider);
			const openAdapter = NativeAdapter.open;
			t.mock.method(globalThis, "fetch", () => assert.fail("No live provider or catalog access"));
			t.mock.method(NativeAdapter, "open", (options: Parameters<typeof NativeAdapter.open>[0]) => {
				assert.ok(
					!options.hostTools?.some((tool) => tool.name === "insights_history"),
					"Owner cannot list the legacy direct-history tool",
				);
				if (freshDay)
					assert.ok(
						!options.hostTools?.some((tool) => tool.name === "scoped_metrics"),
						"Fresh Day cannot expose metrics",
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
			let day: DayInsights | undefined;
			const marker = "FIRST_TRANSCRIPT_PRIVATE_MARKER_27";
			let firstSawMarker = false;
			let dayProposalInstructions = false;
			let dayPriorReadInstructions = false;
			let sawRetro = false;
			const storagePaths: string[] = [];
			const workers: SessionWorker[] = [];
			const factory: SessionFactories["worker"] = (spec, onPacket, onExit) => {
				launches++;
				storagePaths.push(spec.storageDir);
				let kernel!: KernelSession;
				const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
				const toPilotd: HostCall = (method, args) =>
					new Promise((resolve, reject) => {
						const callId = randomUUID();
						pending.set(callId, { resolve: (value) => resolve(value as never), reject });
						onPacket({ type: "host.call", method, callId, args } as HostCallPacket);
					});
				const worker: SessionWorker = {
					state: "idle",
					busy: false,
					modelConfiguration: 1,
					ready: Promise.resolve(),
					send: (command) => {
						if (command.type !== "host.result") return;
						const call = pending.get(command.callId);
						pending.delete(command.callId);
						if (command.error) call?.reject(new Error(command.error));
						else call?.resolve(command.result);
					},
					request: async (command) => {
						await worker.ready;
						if (command.type === "input") {
							activeRun = command.requestId.slice("insights-review:".length);
							await kernel.submit(command.requestId, command.content, command.mode, command.onlyIfIdle);
						} else if (command.type === "changeModelConfiguration") {
							const result = await kernel.changeModel(command.model, command.thinking, {
								revalidate: () => toPilotd("model.configuration.guard", { requestId: command.requestId }),
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
					call: async (method, args, signal) => {
						if (method === "diagnostics.context")
							throw new Error("Dispatched owner cannot request direct source history");
						if (method !== "insights.backlog") return toPilotd(method, args, signal);
						const { request } = args as HostCalls["insights.backlog"]["args"];
						toolCalls++;
						const result = await f.sessions.insightsOwnerBacklog(spec.sessionId, request, worker);
						if ((request as { action?: string }).action === "review_context")
							nextCursor = (result as { nextCursor: number | null }).nextCursor;
						return result as never;
					},
					onWorking: (working) => {
						worker.state = working ? "working" : "idle";
						Object.assign(worker, { busy: working });
						onPacket({ type: "working", working });
					},
				}).then((value) => {
					kernel = value;
					onPacket({
						type: "ready",
						model: kernel.model,
						thinking: kernel.thinkingLevel,
						working: false,
						usage: {},
					});
				});
				Object.assign(worker, { ready });
				workers.push(worker);
				return worker;
			};
			f = await fixture(t, { worker: factory }, {});
			let settings: import("@pilot/protocol").DayInsightsSettings = {
				model: model.id,
				source: { projects: [f.project.id], excludeProjects: [], excludeSessions: [] },
				weekly: null,
				allowance: { perReportMicros: 10000000, monthlyMicros: 100000000, basis: "catalog_estimate" },
			};
			const submit = async (
				action: import("@pilot/protocol").DayInsightsAction,
				config: typeof settings | null = null,
			) => {
				const review = await day!.preflight({
					action,
					expectedRevision: (await day!.status()).revision,
					projectId: f.project.id,
					settings: config,
				});
				assert.ok(review.payload, JSON.stringify(review));
				const op = f.operation("day-insights", review.payload, f.owner.workspaceId);
				const receipt = await f.journal.execute(op, (op, entry) => day!.admit(op, entry.firstEntry));
				assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
			};
			if (freshDay) {
				day = new DayInsights({
					home: f.home,
					host,
					projects: f.projects,
					models: f.models,
					store: f.missions.dayInsights,
					workspace: f.missions.insightsWorkspace,
					owners: f.missions.insightsOwner,
					sessions: f.sessions,
					allowance: f.missions.dayInsightsAllowance,
					admissionEpoch: f.sessions.insightsAdmissionEpoch,
					runtime: new DayInsightsExecution({
						sessions: f.sessions,
						owners: f.missions.insightsOwner,
						store: f.missions.dayInsights,
						schedules: f.schedules,
						journal: f.journal,
						models: f.models,
					}),
				});
				f.sessions.dayInsights = day;
				const broker = new CredentialBroker(join(f.home, "fresh-day-credentials"));
				await broker.start();
				broker.fundingRequest = async (_binding, request) =>
					day!.fundingRequest(f.owner.reportSessionId, request, {
						fundingModel: async (provider, id) => (provider === "synthetic" ? faux.getModel(id) : undefined),
					});
				const client = new CredentialClient(broker.grant(false, undefined, f.owner.reportSessionId));
				t.after(async () => {
					await client.close();
					await broker.close();
				});
				installDayInsightsRuntime(runtime, {
					reserve: async (id, chosen, bound) =>
						(await client.request({
							op: "funding-reserve",
							namespace: "pi",
							key: id,
							value: { provider: chosen.provider, model: chosen.id, api: chosen.api, ...bound },
						})) as DayInsightsReservation,
					settle: async (id, usage) => {
						await client.request({ op: "funding-settle", namespace: "pi", key: id, value: usage });
					},
				});
				await submit("apply", settings);
				assert.equal(f.schedules.store.list().length, 0);
				settings = { ...settings, weekly: { day: 5, time: "18:00", timezone: "Europe/Paris" } };
				await submit("apply", settings);
			} else assert.equal((await f.run(f.enable)).state, "accepted");
			assert.equal(launches, 0);
			const source = await seedSource(f, undefined, freshDay ? marker : "");
			if (freshDay) await seedSource(f);
			f.schedules.start();
			for (let cycle = 0; cycle < 2; cycle++) {
				nextCursor = 0;
				phase = "context";
				const respond = (payload: import("@earendil-works/pi-ai").TranscriptContext) => {
					if (freshDay) {
						const serialized = JSON.stringify(payload);
						sawRetro ||= serialized.includes("# /retro");
						dayProposalInstructions ||= /Use insights_backlog propose for supported findings from this run/i.test(
							serialized,
						);
						dayPriorReadInstructions ||= /Page prior findings with list\/get/i.test(serialized);
						if (cycle === 0 && serialized.includes(marker)) firstSawMarker = true;
						if (cycle === 1)
							assert.ok(
								!serialized.includes(marker),
								"Excluded first transcript/tracking leaked into the second provider context",
							);
					}
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
									observation: freshDay && cycle === 0 ? marker : "Synthetic fixture repeated a correction",
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
							String(
								f.missions["one"]("SELECT request FROM insights_owner_runs WHERE run_id=?", activeRun)!.request,
							),
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
									markdown:
										freshDay && cycle === 0
											? marker
											: "Synthetic report. No comprehensive coverage or implementation approval.",
									checkpoints: [],
									findingKeys: [findingKey],
									gaps: ["Synthetic bounded sources only."],
								},
							}),
							{ stopReason: "toolUse" },
						);
					}
					return fauxAssistantMessage(freshDay && cycle === 0 ? marker : "Saved a partial synthetic report.");
				};
				faux.setResponses(Array.from({ length: 20 }, () => respond));
				if (freshDay && cycle === 1) {
					settings = { ...settings, source: { ...settings.source, excludeSessions: [source.sourceId] } };
					await submit("apply", settings);
				}
				if (freshDay && cycle === 0) await submit("run");
				else await f.due();
				await until(
					() =>
						f.missions["one"]("SELECT state FROM insights_owner_runs WHERE run_id=?", activeRun)?.state ===
							"partial" && workers.at(-1)?.state === "idle",
				);
			}
			assert.equal(launches, freshDay ? 2 : 1);
			if (freshDay) {
				assert.equal(new Set(storagePaths).size, 2);
				assert.ok(firstSawMarker);
				assert.ok(dayProposalInstructions, "The Day provider must receive actionable proposal instructions");
				assert.ok(sawRetro, "The Day provider must receive the retrospective skill");
				assert.equal(dayPriorReadInstructions, false, "The Day provider must not be told to read hidden findings");
				assert.equal(
					Number(f.missions["one"]("SELECT COUNT(*) n FROM day_insights_allowance")!.n),
					faux.state.callCount,
				);
				assert.equal(
					Number(f.missions["one"]("SELECT COUNT(*) n FROM day_insights_allowance WHERE usage IS NULL")!.n),
					0,
				);
				assert.ok(storagePaths.every((path) => path.includes("/day-runs/")));
				const calls = faux.state.callCount;
				settings = { ...settings, allowance: { ...settings.allowance, perReportMicros: 1 } };
				await submit("apply", settings);
				for (let attempt = 0; attempt < 2; attempt++) {
					await submit("run");
					await until(
						() =>
							f.missions["one"]("SELECT state FROM insights_owner_runs WHERE run_id=?", activeRun)?.state ===
								"held" && workers.at(-1)?.state === "idle",
					);
					const status = await day!.status();
					assert.equal(status.running, false);
					assert.match(status.holdReason!, /report_allowance_hold/);
					assert.equal(status.uncertainOperationId, null);
				}
				assert.equal(faux.state.callCount, calls, "Allowance hold must precede physical provider dispatch");
				assert.equal(
					Number(f.missions["one"]("SELECT COUNT(*) n FROM day_insights_runs WHERE state='held'")!.n),
					2,
				);
				return;
			}
			assert.ok(toolCalls >= 4);
			assert.equal(Number(f.missions["one"]("SELECT COUNT(*) n FROM insights_owner_reports")!.n), 2);
			assert.equal(
				Number(
					f.missions["one"](
						"SELECT revision FROM insights_workspace_items WHERE kind='finding' AND key=?",
						findingKey,
					)!.revision,
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
		},
	);

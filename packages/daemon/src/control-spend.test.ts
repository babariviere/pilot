import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AIUsageScope } from "@pilot/protocol";
import { AIUsageLedger } from "./ai-usage.ts";
import { createAuthorization } from "./control-authorizations.ts";
import { buildControlDashboard } from "./control-dashboard.ts";
import { controlSpend } from "./control-spend.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

const scope = (kind: AIUsageScope["activity"]["kind"], estimate: number, billed?: number): AIUsageScope => ({
	tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoningStatus: "unavailable" },
	cost: {
		estimateStatus: "catalog_estimate",
		estimatedUsdMicros: estimate,
		pricingRevision: "pi-ai@1.3.0",
		billedStatus: billed === undefined ? "unavailable" : "known",
		...(billed === undefined ? {} : { billedUsdMicros: billed }),
		subscriptionCoverage: "unknown",
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
		elapsedMsObserved: 1,
		activeMsObserved: 1,
		outcomeCoverage: "partial",
		timingCoverage: "partial",
	},
});
test("authorization reporting separates limits/reservations/releases from ledger spend, including archived chats after restart", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-spend-"));
	const ledger = new AIUsageLedger(home);
	const ids = [randomUUID(), randomUUID(), randomUUID()];
	const grant = createAuthorization(
		"approval",
		{ scope: "work", level: "implement", targets: [{ kind: "project", id: "p" }], limits: { budgetUsd: 15 } },
		{ conversationId: "1", submissionId: 1, entryId: 1, requestId: "typed" },
	);
	for (const [i, id] of ids.entries()) {
		const dir = join(home, "sessions", id);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "meta.json"),
			JSON.stringify({
				id,
				cwd: home,
				title: "Offline",
				createdAt: 1,
				updatedAt: 1,
				...(i < 2 ? { controlStart: { authorizationId: grant.id }, ...(i === 1 ? { archivedAt: 2 } : {}) } : {}),
			}),
		);
		ledger.observeUsage(id, {
			conversationId: "1",
			timingBoot: randomUUID(),
			activityEpoch: "initial",
			epochKind: "initial",
			observedAt: 1000,
			direct: scope("model_requests", 200_000),
			child: scope("child_operations", 50_000),
		});
	}
	await ledger.close();
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		worker: () => {
			throw new Error("No worker may start for reporting");
		},
	});
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	// Explicit legacy fixture, never the production default.
	sessions.setControlRoleGuard(() => true);
	await sessions.load();
	await sessions.ensureControlChat();
	const memory = sessions.controlAuthorizations();
	await memory.authorizationCreate(grant);
	await memory.authorizationAdmit(
		{
			operationId: "control:failed",
			caller: "control",
			action: "start",
			args: {},
			phase: "requested",
			at: 1,
			authorizationId: grant.id,
		},
		{
			authorizationId: grant.id,
			level: "implement",
			targets: [[{ kind: "project", id: "p" }]],
			followUps: 0,
			initialStart: true,
			budgetUsd: 15,
		},
	);
	await memory.authorizationRelease({
		operationId: "control:failed",
		caller: "control",
		action: "start",
		args: {},
		phase: "failed",
		at: 2,
		authorizationId: grant.id,
		result: { error: "pre-admission failure" },
	});
	const record = (await sessions.controlAuthorizationPage()).authorizations[0]!;
	assert.equal(record.limits.budgetUsd, 15);
	assert.deepEqual(record.budget, { reservedUsd: 15, releasedUsd: 15 });
	assert.equal(record.usage.budgetUsd, 0);
	assert.equal(record.spend?.sessions, 2, "includes archived, excludes ordinary chat");
	assert.equal(record.spend?.cost.estimatedUsdMicros, 500_000);
	assert.equal(record.spend?.cost.billedStatus, "unavailable");
	assert.equal(record.spend?.cost.billedUsdMicros, undefined, "catalog cost is never called actual billed spend");
	const dashboard = buildControlDashboard({ sessions, projects: () => [], missions: () => [], linear: () => [] });
	const row = dashboard.chats.find((chat) => chat.id === ids[0])!;
	assert.deepEqual(row.controlStart, { authorizationId: grant.id });
	assert.equal(row.spend?.cost.estimatedUsdMicros, 250_000);
	assert.equal(dashboard.chats.find((chat) => chat.id === ids[2])?.spend, undefined);
});
test("unknown ledger coverage is not a zero bill; known bills and catalog estimates remain separate", () => {
	assert.equal(controlSpend([undefined]).cost.billedUsdMicros, undefined);
	assert.equal(controlSpend([undefined]).observedSessions, 0);
	const usage = {
		direct: scope("model_requests", 1_000_000, 10),
		child: scope("child_operations", 100_000, 2),
	} as NonNullable<ReturnType<AIUsageLedger["summary"]>>;
	const spend = controlSpend([usage]);
	assert.equal(spend.cost.estimatedUsdMicros, 1_100_000);
	assert.equal(spend.cost.billedUsdMicros, 12);
	const partial = controlSpend([usage, undefined]);
	assert.equal(partial.cost.billedStatus, "unavailable");
	assert.equal(partial.cost.billedUsdMicros, undefined);
	assert.equal(partial.cost.estimateStatus, "partial_catalog_estimate");
});

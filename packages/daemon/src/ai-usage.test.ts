import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KernelUsage } from "@pilot/kernel";
import type { AIUsageActivity, AIUsageScope } from "@pilot/protocol";
import { configureNodeTelemetry, ExportResultCode, type ReadableSpan, type SpanExporter } from "@pilot/telemetry";
import { AI_USAGE_FILE, AIUsageLedger, MAX_AI_USAGE_CONVERSATIONS, MAX_AI_USAGE_TIMING_BOOTS } from "./ai-usage.ts";

function activity(kind: AIUsageActivity["kind"], overrides: Partial<AIUsageActivity> = {}): AIUsageActivity {
	return {
		kind,
		count: 1,
		success: 1,
		failure: 0,
		cancelled: 0,
		usageReports: 1,
		providerAttemptsObserved: 2,
		requestRetriesObserved: 1,
		elapsedMsObserved: 100,
		activeMsObserved: 80,
		outcomeCoverage: "partial",
		timingCoverage: "partial",
		...overrides,
	};
}

function scope(kind: AIUsageActivity["kind"], input: number, estimate?: number): AIUsageScope {
	return {
		tokens: {
			input,
			output: 10,
			cacheRead: 20,
			cacheWrite: 5,
			reasoning: 2,
			reasoningStatus: "reported",
		},
		cost: {
			estimateStatus: estimate === undefined ? "unavailable" : "catalog_estimate",
			...(estimate === undefined ? {} : { estimatedUsdMicros: estimate, pricingRevision: "pi-ai@1.3.0" }),
			billedStatus: "unavailable",
			subscriptionCoverage: "unknown",
		},
		activity: activity(kind),
	};
}

function report(
	conversationId = "0",
	timingBoot = "00000000-0000-4000-8000-000000000001",
): NonNullable<KernelUsage["accounting"]> {
	return {
		conversationId,
		timingBoot,
		activityEpoch: "initial",
		epochKind: "initial",
		observedAt: 1_000,
		direct: scope("model_requests", 100, 12_345),
		child: scope("child_operations", 25),
	};
}

test("ledger deduplicates conversation and timing snapshots across daemon and worker restarts", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-ai-usage-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const id = "11111111-1111-4111-8111-111111111111";
	await mkdir(join(home, "sessions", id), { recursive: true });
	let now = 1_000;
	const ledger = new AIUsageLedger(home, () => now);
	ledger.observeUsage(id, report());
	ledger.observeUsage(id, report());
	ledger.observeState(id, { working: true, paused: false });
	now += 500;
	ledger.observeState(id, { working: false, paused: true });
	now += 200;
	assert.equal(ledger.summary(id)?.direct.tokens.input, 100);
	assert.equal(ledger.summary(id)?.direct.activity.providerAttemptsObserved, 2);
	assert.deepEqual(ledger.summary(id)?.time, {
		elapsedMs: 700,
		activeMs: 500,
		pausedMs: 200,
		idleMs: 0,
		coverage: "daemon_observed_partial",
	});
	await ledger.close();

	const encoded = await readFile(join(home, "sessions", id, AI_USAGE_FILE), "utf8");
	assert.doesNotMatch(encoded, /secret-provider|secret-model|subagent-private-name|toolName/);

	const reopened = new AIUsageLedger(home, () => now);
	await reopened.load([id]);
	reopened.observeUsage(id, report());
	reopened.observeUsage(id, report("0", "00000000-0000-4000-8000-000000000002"));
	assert.equal(reopened.summary(id)?.direct.tokens.input, 100, "cumulative token snapshots do not add twice");
	assert.equal(reopened.summary(id)?.direct.activity.providerAttemptsObserved, 4, "one counter per worker boot");
	assert.equal(reopened.summary(id)?.direct.cost.estimatedUsdMicros, 12_345);
	assert.equal(reopened.summary(id)?.direct.cost.billedStatus, "unavailable");
	assert.equal(reopened.summary(id)?.child.cost.estimateStatus, "unavailable");
	assert.equal(reopened.summary(id)?.child.cost.subscriptionCoverage, "unknown");
	await reopened.close();
});

test("invalid or unexpected accounting cannot enter the bounded store", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-ai-usage-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const id = "22222222-2222-4222-8222-222222222222";
	const directory = join(home, "sessions", id);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, AI_USAGE_FILE), '{"provider":"private"');
	const ledger = new AIUsageLedger(home, () => 2_000);
	await ledger.load([id]);
	assert.equal(ledger.summary(id), undefined);
	ledger.observeUsage(id, { ...report(), conversationId: "private/provider/model" } as never);
	ledger.observeUsage(id, {
		...report(),
		direct: { ...report().direct, tokens: { ...report().direct.tokens, input: Number.POSITIVE_INFINITY } },
	} as never);
	assert.equal(ledger.summary(id), undefined);
	ledger.observeUsage(id, report());
	assert.equal(ledger.summary(id)?.direct.tokens.input, 100, "derived state can rebuild a malformed aggregate");
	await ledger.close();
	assert.doesNotMatch(await readFile(join(directory, AI_USAGE_FILE), "utf8"), /private/);
});

test("schema-v1 accounting migrates without discarding usage totals", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-ai-usage-v1-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const id = "22222222-2222-4222-8222-222222222223";
	const directory = join(home, "sessions", id);
	await mkdir(directory, { recursive: true });
	const original = new AIUsageLedger(home, () => 2_500);
	original.observeUsage(id, report());
	await original.close();
	const path = join(directory, AI_USAGE_FILE);
	const legacy = JSON.parse(await readFile(path, "utf8"));
	legacy.v = 1;
	delete legacy.efficiency;
	await writeFile(
		path,
		JSON.stringify(legacy, (key, value) => (key === "requestRetriesObserved" ? undefined : value)),
	);
	const migrated = new AIUsageLedger(home, () => 2_600);
	await migrated.load([id]);
	assert.equal(migrated.summary(id)?.direct.tokens.input, 100);
	migrated.observeWorkerLaunch(id);
	await migrated.close();
	const stored = JSON.parse(await readFile(path, "utf8"));
	assert.equal(stored.v, 2);
	assert.equal(stored.efficiency.relaunch.count, 1);
});

test("retention rolls old attempts and timing epochs into bounded aggregate totals", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-ai-usage-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const id = "33333333-3333-4333-8333-333333333333";
	const directory = join(home, "sessions", id);
	await mkdir(directory, { recursive: true });
	const ledger = new AIUsageLedger(home, () => 3_000);
	for (let index = 0; index < 70; index++) ledger.observeUsage(id, report(String(index)));
	for (let conversation = 38; conversation < 70; conversation++) {
		for (let boot = 2; boot <= 4; boot++) {
			ledger.observeUsage(
				id,
				report(String(conversation), `00000000-0000-4000-8000-${String(boot).padStart(12, "0")}`),
			);
		}
	}
	for (let index = 1; index <= 10; index++) {
		ledger.observeUsage(id, report("69", `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
	}
	assert.equal(ledger.summary(id)?.direct.activity.count, 70);
	assert.equal(ledger.summary(id)?.direct.tokens.input, 7_000);
	assert.equal(ledger.summary(id)?.direct.activity.providerAttemptsObserved, 344);
	await ledger.close();
	const stored = JSON.parse(await readFile(join(directory, AI_USAGE_FILE), "utf8"));
	assert.ok((await stat(join(directory, AI_USAGE_FILE))).size <= 128 * 1024);
	assert.equal(Object.keys(stored.conversations).length, MAX_AI_USAGE_CONVERSATIONS);
	assert.equal(Object.keys(stored.conversations["69"].direct.timing).length, MAX_AI_USAGE_TIMING_BOOTS);
	assert.equal(stored.conversations["69"].direct.timingRolled.providerAttemptsObserved, 12);
});

test("mixed pricing revisions stay partial instead of claiming one exact catalog", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-ai-usage-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const id = "44444444-4444-4444-8444-444444444444";
	await mkdir(join(home, "sessions", id), { recursive: true });
	const ledger = new AIUsageLedger(home, () => 4_000);
	ledger.observeUsage(id, report("0"));
	const changed = report("1");
	changed.direct.cost.pricingRevision = "pi-ai@2.0.0";
	ledger.observeUsage(id, changed);
	assert.equal(ledger.summary(id)?.direct.cost.estimateStatus, "partial_catalog_estimate");
	assert.equal(ledger.summary(id)?.direct.cost.pricingRevision, undefined);
	assert.equal(ledger.summary(id)?.direct.cost.estimatedUsdMicros, 24_690);
	await ledger.close();
});

test("active-context outcome snapshots roll across compaction epochs without double counting", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-ai-usage-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const id = "55555555-5555-4555-8555-555555555555";
	await mkdir(join(home, "sessions", id), { recursive: true });
	const ledger = new AIUsageLedger(home, () => 5_000);
	ledger.observeUsage(id, report("0"));
	const afterCompaction = { ...report("0"), activityEpoch: "10", epochKind: "compaction" as const };
	ledger.observeUsage(id, afterCompaction);
	ledger.observeUsage(id, afterCompaction);
	assert.equal(ledger.summary(id)?.direct.activity.count, 2);
	const second = structuredClone(afterCompaction);
	second.direct.activity.count = 2;
	second.direct.activity.success = 2;
	second.direct.activity.usageReports = 2;
	ledger.observeUsage(id, second);
	assert.equal(ledger.summary(id)?.direct.activity.count, 3);
	assert.equal(ledger.summary(id)?.efficiency?.compaction.count, 1);
	assert.equal(ledger.summary(id)?.efficiency?.compaction.pairedMeasurements, 0);
	assert.equal(ledger.summary(id)?.efficiency?.compaction.timingStatus, "unavailable");
	await ledger.close();
});

test("context, cache, compaction and relaunch efficiency keep explicit denominators and partial coverage", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-ai-efficiency-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const id = "77777777-7777-4777-8777-777777777777";
	await mkdir(join(home, "sessions", id), { recursive: true });
	const ledger = new AIUsageLedger(home, () => 7_000);
	ledger.observeWorkerLaunch(id);
	ledger.observeUsage(id, { context: { tokens: 100, contextWindow: 200, percent: 50 }, accounting: report() });
	const grown = structuredClone(report());
	grown.direct.tokens.input = 160;
	grown.direct.tokens.cacheRead = 50;
	grown.direct.tokens.cacheWrite = 7;
	grown.direct.activity.count = 2;
	grown.direct.activity.success = 2;
	grown.direct.activity.usageReports = 2;
	ledger.observeUsage(id, { context: { tokens: 100, contextWindow: 200, percent: 50 }, accounting: grown });
	const compacted = structuredClone(grown);
	compacted.activityEpoch = "10";
	compacted.epochKind = "compaction";
	ledger.observeUsage(id, { context: { tokens: 40, contextWindow: 200, percent: 20 }, accounting: compacted });
	ledger.observeUsage(id, {
		context: { tokens: 80, contextWindow: 200, percent: 40 },
		accounting: report("1"),
	});
	const compactedAgain = structuredClone(compacted);
	compactedAgain.activityEpoch = "11";
	ledger.observeUsage(id, {
		context: { tokens: 30, contextWindow: 200, percent: 15 },
		accounting: compactedAgain,
	});
	ledger.observeWorkerLaunch(id, "parked_wake");
	ledger.observeUsage(id, { context: { tokens: 30, contextWindow: 200, percent: 15 }, accounting: compactedAgain });
	const efficiency = ledger.summary(id)?.efficiency;
	assert.deepEqual(efficiency?.direct, {
		observations: 1,
		inputTokens: 60,
		cacheReadTokens: 30,
		cacheWriteTokens: 2,
		cacheEfficiencyNumerator: 30,
		cacheEfficiencyDenominator: 90,
		coverage: "daemon_observed_deltas_partial",
	});
	assert.deepEqual(efficiency?.context, {
		observedAt: 1_000,
		tokens: 30,
		contextWindow: 200,
		headroomTokens: 170,
		percent: 15,
		coverage: "latest_observation",
	});
	assert.deepEqual(efficiency?.compaction, {
		count: 2,
		pairedMeasurements: 1,
		beforeTokens: 100,
		afterTokens: 40,
		tokensRemoved: 60,
		timingStatus: "unavailable",
		coverage: "epoch_observed_partial",
	});
	assert.equal(efficiency?.relaunch.count, 2);
	assert.equal(efficiency?.relaunch.reasons.initial, 1);
	assert.equal(efficiency?.relaunch.reasons.parked_wake, 1);
	assert.equal(efficiency?.relaunch.contextPreparationsObserved, 2);
	assert.equal(efficiency?.relaunch.contextTokensPrepared, 130);
	assert.equal(efficiency?.relaunch.estimatedCostStatus, "unavailable");
	await ledger.close();
	const reopened = new AIUsageLedger(home, () => 8_000);
	await reopened.load([id]);
	assert.equal(reopened.summary(id)?.efficiency?.context?.tokens, 30);
	assert.equal(reopened.summary(id)?.efficiency?.compaction.count, 2);
	await reopened.close();
});

test("durable checkpoints emit only aggregate AI and session-time deltas", async (t) => {
	const spans: ReadableSpan[] = [];
	const exporter: SpanExporter = {
		export(batch, callback) {
			spans.push(...batch);
			callback({ code: ExportResultCode.SUCCESS });
		},
		shutdown: async () => {},
	};
	const telemetry = configureNodeTelemetry({
		enabled: true,
		serviceName: "pilot.daemon",
		serviceVersion: "1.0.0",
		environment: "test",
		hostKind: "local",
		exporter,
	});
	t.after(async () => {
		await telemetry.shutdown();
		configureNodeTelemetry({
			enabled: false,
			serviceName: "pilot.daemon",
			serviceVersion: "1.0.0",
			environment: "test",
			hostKind: "local",
		});
	});
	const home = await mkdtemp(join(tmpdir(), "pilot-ai-usage-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const id = "66666666-6666-4666-8666-666666666666";
	await mkdir(join(home, "sessions", id), { recursive: true });
	let now = 0;
	const ledger = new AIUsageLedger(home, () => now);
	ledger.observeState(id, { working: true, paused: false });
	now = 500;
	ledger.observeUsage(id, report());
	await ledger.close();
	await telemetry.forceFlush();
	assert.deepEqual(spans.map((span) => span.attributes["pilot.ai.scope"]).sort(), ["child", "direct", "session"]);
	assert.equal(
		spans.find((span) => span.attributes["pilot.ai.scope"] === "session")?.attributes["pilot.ai.active_ms"],
		500,
	);
	assert.doesNotMatch(
		JSON.stringify(spans.map((span) => span.attributes)),
		new RegExp(`${id}|secret-provider|secret-model`),
	);
});

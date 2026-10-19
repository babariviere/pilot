import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { TrackingJson } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { createSlackPoller } from "./slack-source.ts";
import { SourceRateLimited, SourceSignInRequired, SourceToolError } from "./source-mcp.ts";
import { SourceRefreshDiagnostics, refreshAssessment } from "./source-refresh-diagnostics.ts";
import { SourceRegistry } from "./sources.ts";
import { TrackedItemStore } from "./tracked-items.ts";

const time = Date.UTC(2026, 9, 19, 12);
test("refresh inference separates observed success, queues, overdue, deadlines and clock uncertainty", () => {
	const base = {
		configured: true,
		adapter: true,
		automatic: true,
		stopped: false,
		busySlots: 0,
		nextDueAt: time + 300_000,
	};
	assert.equal(refreshAssessment(base, time).state, "scheduled_unknown", "a checkpoint is not live proof");
	assert.equal(refreshAssessment({ ...base, configured: false }, time).state, "not_configured");
	assert.equal(refreshAssessment({ ...base, adapter: false }, time).state, "unavailable");
	assert.equal(refreshAssessment({ ...base, automatic: false }, time).state, "not_scheduled");
	assert.equal(refreshAssessment({ ...base, stopped: true }, time).state, "stopped");
	assert.equal(refreshAssessment({ ...base, nextDueAt: time - 10_000, busySlots: 2 }, time).state, "queued");
	assert.equal(refreshAssessment({ ...base, nextDueAt: time - 10_000 }, time).state, "overdue");
	const deadline = refreshAssessment({ ...base, running: { startedAt: time - 91_000, cancelling: false } }, time);
	assert.equal(deadline.state, "deadline_elapsed");
	assert.match(deadline.uncertainty!, /not_proof/);
	assert.equal(refreshAssessment({ ...base, checkpointAt: time + 1 }, time).state, "unknown_clock");
	for (const backoff of ["sign_in", "provider_rate_limit", "local_budget"])
		assert.equal(refreshAssessment({ ...base, backoff }, time).reason, backoff);
});

test("refresh observations remain bounded, cloned, content-free and independently disabled", () => {
	const observations = new SourceRefreshDiagnostics();
	observations.begin("source", "key");
	observations.observe("source", "key", { stage: "discovery", phase: "started" });
	observations.observe("source", "key", { stage: "discovery", phase: "completed", outcome: "success", count: 0 });
	observations.observe("source", "key", { stage: "classification", phase: "started" });
	observations.observe("source", "key", {
		stage: "classification",
		phase: "partial",
		reason: "local_classification_budget",
	});
	observations.observe("source", "key", { stage: "classification", phase: "completed", outcome: "success" });
	observations.observe("source", "key", { stage: "commit", phase: "completed", outcome: "success", count: 0 });
	observations.end("source", "key", "success");
	const result = observations.read("source", "key")!;
	assert.equal(result.outcome, "partial");
	assert.equal(result.returnedItems, 0);
	assert.ok(result.lastCommittedAt);
	result.stages.length = 0;
	assert.equal(observations.read("source", "key")?.stages.length, 3);
	for (let i = 0; i < 300; i++) observations.begin(`source-${i}`, "key");
	assert.ok(observations.coverage().droppedSources > 0);
	assert.equal(observations.read("source", "key"), undefined);
	observations.setEnabled(false);
	observations.begin("ignored", "key");
	assert.equal(observations.read("ignored", "key"), undefined);
	observations.setEnabled(true);
	assert.equal(observations.read("ignored", "key"), undefined);
});

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "refresh-health-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, tracking: { slackChannels: ["C1", "C2"], linearTeam: "ENG" } });
	const items = new TrackedItemStore(join(home, "items.sqlite"));
	await items.load([project.id]);
	let calls = 0,
		mode = "ok";
	const mcp = {
		async call(_kind: string, tool: string, args: Record<string, unknown>): Promise<TrackingJson> {
			calls++;
			if (mode === "sign_in") throw new SourceSignInRequired("password=secret-canary");
			if (mode === "rate") throw new SourceRateLimited(60_000);
			if (tool === "history") {
				if (args.channel_id === "C2" && mode === "channel_error") throw new SourceToolError("secret-canary");
				return {
					messages: `Channel: #bugs (${args.channel_id})\n\n`,
					pagination_info: "There are no more messages available.\n",
				};
			}
			return { issues: [] };
		},
	};
	const registry = new SourceRegistry(projects, items, mcp);
	t.after(async () => {
		await registry.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	return {
		projects,
		project,
		home,
		items,
		mcp,
		registry,
		calls: () => calls,
		mode: (value: string) => {
			mode = value;
		},
	};
}

test("empty successful refresh is live evidence, restart checkpoint is not; reads make no external calls", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: time });
	const f = await fixture(t),
		id = `${f.project.id}:linear`;
	f.registry.register("linear", async (context) => {
		await context.call("issues", {});
		return { items: [] };
	});
	f.registry.startPolling("linear");
	await f.registry.poll(id);
	const before = f.calls();
	const row = f.registry.refreshHealth({ projectId: f.project.id, kind: "linear" }).sources[0]!;
	assert.equal(row.assessment.state, "healthy");
	assert.equal(row.live?.returnedItems, 0);
	assert.equal(row.live?.outcome, "success");
	assert.equal(f.calls(), before);
	const reopened = new SourceRegistry(f.projects, f.items, f.mcp);
	t.after(() => reopened.stop());
	reopened.register("linear", async () => ({ items: [] }));
	reopened.startPolling("linear");
	const cold = reopened.refreshHealth({ projectId: f.project.id, kind: "linear" }).sources[0]!;
	assert.equal(cold.live, undefined);
	assert.equal(cold.assessment.state, "scheduled_unknown");
	assert.equal(cold.checkpointCommittedAt, time);
	assert.equal(f.calls(), before);
	f.registry.refreshDiagnostics.setEnabled(false);
	assert.equal(f.registry.refreshHealth().availability, "disabled");
	assert.deepEqual(f.registry.refreshHealth().sources, []);
});

test("per-channel partial refresh never becomes all-channel freshness", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: time });
	const f = await fixture(t);
	f.registry.register(
		"slack",
		createSlackPoller(f.items, { classifySlack: async () => assert.fail("empty pages never classify") }, Date.now),
	);
	f.registry.startPolling("slack");
	await f.registry.poll(`${f.project.id}:slack`);
	let row = f.registry.refreshHealth({ projectId: f.project.id, kind: "slack" }).sources[0]!;
	assert.equal(row.channelCoverage?.channels[0]?.coverage, "one_page_observed");
	assert.equal(row.channelCoverage?.channels[1]?.coverage, "unknown");
	t.mock.timers.tick(300_000);
	f.mode("channel_error");
	await f.registry.poll(`${f.project.id}:slack`);
	const calls = f.calls();
	row = f.registry.refreshHealth({ projectId: f.project.id, kind: "slack" }).sources[0]!;
	assert.equal(row.live?.outcome, "partial");
	assert.equal(row.channelCoverage?.channels[1]?.coverage, "failed_page");
	assert.equal(row.checkpointCommittedAt, time + 300_000, "latest commit can contain partial failure");
	assert.equal(row.channelCoverage?.channels[0]?.lastPulledAt, time, "another channel is not made fresh");
	assert.equal(row.channelCoverage?.nominalRoundRobinMs, 600_000);
	assert.equal(f.calls(), calls);
	assert.doesNotMatch(JSON.stringify(row), /secret-canary|cursor|#bugs/);
});

test("sign-in and rate backoff are distinct from local classifier limits", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: time });
	const f = await fixture(t);
	let classifyBudget = false;
	f.registry.register("linear", async (context) => {
		await context.call("issues", {});
		if (classifyBudget) {
			context.observe?.({ stage: "classification", phase: "started" });
			context.observe?.({ stage: "classification", phase: "partial", reason: "local_classification_budget" });
			context.observe?.({ stage: "classification", phase: "completed", outcome: "success" });
		}
		return { items: [] };
	});
	f.registry.startPolling("linear");
	for (const mode of ["sign_in", "rate"]) {
		f.mode(mode);
		await f.registry.poll(`${f.project.id}:linear`);
		const row = f.registry.refreshHealth({ projectId: f.project.id, kind: "linear" }).sources[0]!;
		assert.equal(row.assessment.reason, mode === "sign_in" ? "sign_in" : "provider_rate_limit");
		assert.doesNotMatch(JSON.stringify(row), /secret-canary/);
		t.mock.timers.tick(300_000);
	}
	f.mode("ok");
	classifyBudget = true;
	await f.registry.poll(`${f.project.id}:linear`);
	const row = f.registry.refreshHealth({ projectId: f.project.id, kind: "linear" }).sources[0]!;
	assert.equal(row.assessment.state, "partial");
	assert.equal(row.live?.stages.find((s) => s.stage === "discovery")?.outcome, "success");
	assert.equal(row.live?.stages.find((s) => s.stage === "classification")?.reason, "local_classification_budget");
	assert.equal(row.backoff, undefined, "observing a Linear size limit never changes its scheduler");
});

test("shared-slot queue, deadline uncertainty and deleted configuration are read-only observations", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: time });
	const f = await fixture(t);
	await mkdir(join(f.home, "other"));
	const other = await f.projects.create({
		path: join(f.home, "other"),
		tracking: { slackChannels: [], linearTeam: "OTHER" },
	});
	f.registry.register("linear", () => new Promise(() => {}));
	f.registry.register("slack", () => new Promise(() => {}));
	f.registry.startPolling("linear");
	f.registry.startPolling("slack");
	const a = f.registry.poll(`${f.project.id}:linear`),
		b = f.registry.poll(`${f.project.id}:slack`);
	const row = f.registry.refreshHealth({ projectId: other.id, kind: "linear" }).sources[0]!;
	assert.equal(row.assessment.state, "queued");
	assert.equal(row.scheduler.busySlots, 2);
	t.mock.timers.tick(91_000);
	assert.equal(
		f.registry.refreshHealth({ projectId: f.project.id, kind: "linear" }).sources[0]?.assessment.state,
		"deadline_elapsed",
	);
	await f.projects.update(f.project.id, { tracking: { slackChannels: [], linearTeam: "" } });
	await Promise.all([a, b]);
	const cleared = f.registry.refreshHealth({ projectId: f.project.id, kind: "linear" }).sources[0]!;
	assert.equal(cleared.assessment.state, "not_configured");
	assert.equal(cleared.live, undefined);
	assert.equal(f.calls(), 0);
});

test("waiting-reply and reaction-read limits stay separate from successful message discovery", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: time });
	const f = await fixture(t);
	f.registry.register("slack", async () => ({ items: [] }));
	f.registry.slackWaiting = async (context) => {
		context.observe?.({ stage: "waiting_replies", phase: "partial", reason: "read_failed" });
		context.observe?.({ stage: "waiting_replies", phase: "completed", outcome: "success", count: 1 });
		return false;
	};
	t.mock.method(f.items, "reserveSlackReactions", async () => ({ reads: [], budget: true }));
	f.registry.startPolling("slack");
	await f.registry.poll(`${f.project.id}:slack`);
	const calls = f.calls();
	const row = f.registry.refreshHealth({ projectId: f.project.id, kind: "slack" }).sources[0]!;
	assert.equal(row.live?.outcome, "partial");
	assert.equal(row.live?.stages.find((s) => s.stage === "discovery")?.outcome, "success");
	assert.equal(row.live?.stages.find((s) => s.stage === "waiting_replies")?.outcome, "partial");
	assert.equal(row.live?.stages.find((s) => s.stage === "reaction_reads")?.reason, "local_read_budget");
	assert.equal(row.backoff, undefined, "reaction limits do not pause message discovery");
	assert.equal(row.scheduler.nextDueAt, time + 300_000);
	assert.equal(f.calls(), calls);
});

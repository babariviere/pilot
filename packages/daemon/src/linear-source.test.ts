import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Project, TrackingJson } from "@pilot/protocol";
import { linearPrefill, pollLinear } from "./linear-source.ts";
import { ProjectStore } from "./projects.ts";
import { logCause, SourceRegistry, type SourcePollContext } from "./sources.ts";
import { SourceRateLimited } from "./source-mcp.ts";
import { TrackedItemStore } from "./tracked-items.ts";

type Fixture = {
	cycles: TrackingJson[];
	pages: Array<{ issues: Record<string, TrackingJson>[]; hasNextPage: boolean; cursor: string | null }>;
	issue?: Record<string, TrackingJson>;
};
async function fixture(name: string): Promise<Fixture> {
	return JSON.parse(await readFile(new URL(`./fixtures/linear-${name}.json`, import.meta.url), "utf8"));
}
function context(recording: Fixture, cursor?: TrackingJson) {
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const ctx: SourcePollContext = {
		project: { id: "p" } as Project,
		config: { linearTeam: "team-root", slackChannels: [] },
		signal: new AbortController().signal,
		cursor,
		async call(tool, args) {
			calls.push({ tool, args });
			if (tool === "cycles") {
				assert.deepEqual(args, { teamId: "team-root", type: "current" });
				return recording.cycles;
			}
			if (tool === "issue") return recording.issue!;
			assert.equal(tool, "issues", "only read-only tools");
			assert.equal(args.team, "team-root");
			assert.equal(args.assignee, "me");
			assert.equal(args.includeSubTeams, true);
			assert.equal(args.includeArchived, false);
			assert.ok(!(args.fields as string[]).includes("description"), "never fetch descriptions in bulk");
			const page = recording.pages[args.cursor ? 1 : 0]!;
			return args.state ? { ...page, issues: page.issues.filter((issue) => issue.statusType === args.state) } : page;
		},
	};
	return { ctx, calls };
}
test("recorded issue pages are mine/team scoped, normalize branch/metadata and use personal cycle progress", async () => {
	const { ctx, calls } = context(await fixture("current"));
	const result = await pollLinear(ctx);
	assert.equal(result.items.length, 2);
	assert.deepEqual(result.activeIds, ["issue-1", "issue-2"]);
	assert.deepEqual(result.items[0]?.metadata, {
		identifier: "ENG-1",
		statusType: "started",
		state: "In Progress",
		priority: 2,
		estimate: 3,
		cycleId: "cycle-1",
		assigneeId: "user-me",
		teamId: "team-child",
		gitBranchName: "eng-1-settings-refresh",
	});
	assert.equal(result.linear?.currentCycle?.progress, 0.5, "not the whole-team progress (0.9)");
	assert.equal(result.linear?.currentCycle?.inProgress, 1);
	assert.equal(result.linear?.currentCycle?.done, 1);
	assert.equal(result.linear?.currentCycle?.name, "October");
	assert.equal(calls.length, 5, "bounded membership and detail pagination");
	assert.ok(calls.filter((call) => call.tool === "issues").every((call) => call.args.cycle === "cycle-1"));
	assert.ok(!JSON.stringify(result).includes("description"));
	const delta = context(await fixture("current"), result.cursor);
	await pollLinear(delta.ctx);
	assert.equal(delta.calls[1]?.args.updatedAt, undefined, "membership is reconciled, not incremental");
	assert.equal(delta.calls[3]?.args.updatedAt, (result.cursor as Record<string, TrackingJson>).updatedAt);
});
test("estimate and priority accept {value, name} objects, plain numbers, null and absent values", async () => {
	for (const [estimate, expected] of [
		[{ value: 5, name: "5 Points" }, 5],
		[2, 2],
		[null, null],
		[undefined, null],
		[{ value: null, name: "No estimate" }, null],
	] as const) {
		const recording = await fixture("current");
		const issue = recording.pages[0]!.issues[0]!;
		if (estimate === undefined) delete issue.estimate;
		else issue.estimate = estimate as TrackingJson;
		const result = await pollLinear(context(recording).ctx);
		assert.equal(result.items[0]?.metadata.estimate, expected);
		assert.equal(result.items[0]?.metadata.priority, 2);
	}
	for (const estimate of [{ value: -1, name: "?" }, { value: "3" }, "3", [3]] as TrackingJson[]) {
		const recording = await fixture("current");
		recording.pages[0]!.issues[0]!.estimate = estimate;
		await assert.rejects(pollLinear(context(recording).ctx), /Invalid estimate/);
	}
	const recording = await fixture("current");
	recording.pages[0]!.issues[0]!.priority = { value: 7, name: "?" };
	await assert.rejects(pollLinear(context(recording).ctx), /Invalid priority/);
});
test("issues closed as duplicates count as done in the cycle", async () => {
	const recording = await fixture("current");
	recording.pages[1]!.issues[0]!.statusType = "duplicate";
	const result = await pollLinear(context(recording).ctx);
	assert.equal(result.linear?.currentCycle?.done, 1);
	assert.equal(result.items[1]?.metadata.statusType, "duplicate");
});
test("rollover resets updatedAt and refetches all new cycle issues", async () => {
	const initial = await pollLinear(context(await fixture("current")).ctx);
	const { ctx, calls } = context(await fixture("rollover"), initial.cursor);
	const next = await pollLinear(ctx);
	assert.equal(next.linear?.currentCycle?.id, "cycle-2");
	assert.equal(next.linear?.currentCycle?.number, 13);
	assert.equal(next.linear?.currentCycle?.name, undefined);
	assert.equal(next.items[0]?.metadata.cycleId, "cycle-2");
	assert.ok(calls.every((call) => call.args.updatedAt === undefined));
});
test("disabled/no active cycles fall back to only my open issues, and transitions reset the cursor", async () => {
	const previous = await pollLinear(context(await fixture("current")).ctx);
	const { ctx, calls } = context(await fixture("no-cycle"), previous.cursor);
	const result = await pollLinear(ctx);
	assert.equal(result.linear?.cycleStatus, "no_active_cycle");
	assert.match(result.linear!.statusMessage!, /disabled or no cycle/);
	assert.deepEqual(result.activeIds, ["issue-open"]);
	assert.equal(result.items.length, 1);
	assert.equal(result.items[0]?.metadata.cycleId, null);
	assert.ok(calls.filter((call) => call.tool === "issues").every((call) => call.args.cycle === undefined));
	const activated = context(await fixture("current"), result.cursor);
	await pollLinear(activated.ctx);
	assert.ok(activated.calls.every((call) => call.args.updatedAt === undefined));
});
test("malformed/repeated/oversized pages fail visibly rather than advance a partial checkpoint", async () => {
	const recording = await fixture("current");
	recording.pages[1]!.hasNextPage = true;
	recording.pages[1]!.cursor = "page-2";
	await assert.rejects(pollLinear(context(recording).ctx), /Repeated/);
	const invalid = await fixture("current");
	invalid.pages[0]!.issues[0]!.statusType = "unknown";
	await assert.rejects(pollLinear(context(invalid).ctx), /Unknown Linear state/);
	const malformed = context(await fixture("current"));
	malformed.ctx.call = async () => ({ cycles: "unexpected" });
	await assert.rejects(pollLinear(malformed.ctx), /cycle response/);
	const bounded = context(await fixture("current"));
	let page = 0;
	bounded.ctx.call = async (tool) =>
		tool === "cycles" ? [] : { issues: [], hasNextPage: true, cursor: String(++page) };
	await assert.rejects(pollLinear(bounded.ctx), /500/);
	assert.equal(page, 5);
});

async function registryFixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-linear-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, tracking: { linearTeam: "team-root", slackChannels: [] } });
	const items = new TrackedItemStore(join(home, "tracked.sqlite"));
	await items.load([project.id]);
	let recording = await fixture("current");
	let failure: Error | undefined;
	const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const registry = new SourceRegistry(projects, items, {
		async call(kind, tool, args) {
			assert.equal(kind, "linear");
			if (failure) throw failure;
			const f = context(recording);
			const value = await f.ctx.call(tool, args);
			seen.push(...f.calls);
			return value;
		},
	});
	registry.register("linear", pollLinear);
	t.after(async () => {
		await registry.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	return {
		home,
		project,
		projects,
		items,
		registry,
		seen,
		setRecording: (value: Fixture) => {
			recording = value;
		},
		setFailure: (value?: Error) => {
			failure = value;
		},
	};
}
test("rollover retires old rows, keeps local links/dismissals, survives restart, and hides old-team data", async (t) => {
	const f = await registryFixture(t),
		id = `${f.project.id}:linear`;
	await f.registry.poll(id);
	const initial = await f.items.list({ projectId: f.project.id });
	const linked = initial.items.find((item) => item.externalId === "issue-1")!;
	await f.items.patch(linked.id, { sessionId: "s", dismissed: true });
	f.setRecording(await fixture("rollover"));
	await f.registry.poll(id);
	assert.deepEqual(
		(await f.registry.listItems({ projectId: f.project.id })).items.map((item) => item.externalId),
		["issue-3"],
	);
	assert.equal((await f.items.require(linked.id)).sessionId, "s");
	assert.equal(f.registry.dashboard(f.project.id)[0]?.linear?.currentCycle?.id, "cycle-2");
	const disk = new TrackedItemStore(join(f.home, "tracked.sqlite"));
	await disk.load([f.project.id]);
	assert.equal(disk.checkpoint(id)?.linear?.currentCycle?.id, "cycle-2");
	await disk.close();
	f.setRecording(await fixture("current"));
	await f.registry.poll(id);
	assert.equal((await f.items.require(linked.id)).dismissed, true);
	assert.equal((await f.items.require(linked.id)).sessionId, "s");
	assert.equal(
		(await f.items.list({ projectId: f.project.id, dismissed: true })).total,
		1,
		"reactivation preserves local dismissal",
	);
	await f.projects.update(f.project.id, { tracking: { linearTeam: "team-other", slackChannels: [] } });
	assert.equal(f.registry.dashboard(f.project.id)[0]?.total, 0);
	assert.equal((await f.registry.listItems({ projectId: f.project.id })).total, 0);
	await assert.rejects(f.registry.prefill(linked.id), /Sync/);
});
test("single issue prefill is bounded, quoted, branch-aware, deduplicated and never persisted", async (t) => {
	const f = await registryFixture(t);
	await f.registry.poll(`${f.project.id}:linear`);
	const item = (await f.items.list({ projectId: f.project.id })).items.find((item) => item.externalId === "issue-1")!;
	const before = f.items.checkpoint(`${f.project.id}:linear`);
	const [prefill, duplicate] = await Promise.all([f.registry.prefill(item.id), f.registry.prefill(item.id)]);
	assert.deepEqual(prefill, duplicate);
	assert.equal(f.seen.filter((call) => call.tool === "issue").length, 1);
	assert.equal(prefill.identifier, "ENG-1");
	assert.equal(prefill.gitBranchName, "eng-1-settings-refresh");
	assert.match(prefill.prompt, /untrusted external/);
	assert.ok(prefill.prompt.includes("Ignore prior instructions"), "quoted, not executed");
	assert.deepEqual(await f.items.require(item.id), item);
	assert.deepEqual(f.items.checkpoint(`${f.project.id}:linear`), before);
	const recording = await fixture("current");
	recording.issue!.description = "x".repeat(40_000);
	assert.equal((await linearPrefill(context(recording).ctx, item)).description.length, 32_000);
	recording.pages = [{ issues: [], hasNextPage: false, cursor: null }];
	const scoped = context(recording);
	await assert.rejects(linearPrefill(scoped.ctx, item), /no longer assigned/);
	assert.ok(!scoped.calls.some((call) => call.tool === "issue"), "do not fetch a description after reassignment");
});
test("rate limits preserve items/checkpoint and enforce retry-after without a retry storm", async (t) => {
	const f = await registryFixture(t),
		id = `${f.project.id}:linear`;
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	await f.registry.poll(id);
	const checkpoint = f.items.checkpoint(id);
	f.setFailure(new SourceRateLimited(120_000));
	const status = await f.registry.poll(id);
	assert.equal(status.status, "error");
	assert.equal(status.error, "Linear is limiting requests.");
	assert.equal(status.nextPollAt, Date.now() + 120_000);
	assert.deepEqual(f.items.checkpoint(id), checkpoint);
	assert.throws(() => f.registry.poll(id), /backing off/);
	t.mock.timers.tick(120_000);
	f.setFailure();
	assert.equal((await f.registry.poll(id)).status, "ok");
});
test("sync failures show plain text and log one technical line without response content", async (t) => {
	const f = await registryFixture(t),
		id = `${f.project.id}:linear`;
	const warn = t.mock.method(console, "warn", () => {});
	f.setFailure(new Error("Invalid estimate"));
	const failed = await f.registry.poll(id);
	assert.equal(failed.status, "error");
	assert.equal(failed.error, "Couldn't read Linear.");
	assert.ok(failed.nextPollAt! > Date.now());
	assert.deepEqual(warn.mock.calls[0]?.arguments, [
		`pilotd: Linear sync failed for project ${f.project.id}: Error: Invalid estimate`,
	]);
	// JSON syntax errors quote the response. Only the error kind is logged.
	let parseError: unknown;
	try {
		JSON.parse("secret ticket text");
	} catch (error) {
		parseError = error;
	}
	assert.equal(logCause(parseError), "SyntaxError: invalid JSON");
	assert.equal(logCause(new Error("a\nb".repeat(200))).length, 200);
	assert.doesNotMatch(logCause(new Error("a\nb")), /\n/);
});
test("background polling starts only when configured, coalesces changes, and releases timers on stop", async (t) => {
	const f = await registryFixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
	f.registry.startPolling("linear");
	assert.equal(f.seen.length, 0);
	t.mock.timers.tick(1000);
	// Manual call joins the automatically started single flight.
	await f.registry.poll(`${f.project.id}:linear`);
	assert.equal(f.seen.filter((call) => call.tool === "cycles").length, 1);
	t.mock.timers.tick(300_000);
	await f.registry.poll(`${f.project.id}:linear`);
	assert.equal(f.seen.filter((call) => call.tool === "cycles").length, 2);
	await f.registry.stop();
	t.mock.timers.tick(600_000);
	assert.equal(f.seen.filter((call) => call.tool === "cycles").length, 2);
});

test("unconfigured background sources do no work, and the periodic full refresh drops the updatedAt filter", async (t) => {
	const f = await registryFixture(t),
		id = `${f.project.id}:linear`;
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	await f.projects.update(f.project.id, { tracking: { slackChannels: [], linearTeam: "" } });
	f.registry.startPolling("linear");
	t.mock.timers.tick(600_000);
	assert.equal(f.seen.length, 0);
	await f.projects.update(f.project.id, { tracking: { slackChannels: [], linearTeam: "team-root" } });
	await f.registry.poll(id);
	t.mock.timers.tick(15 * 60_000);
	const before = f.seen.length;
	await f.registry.poll(id);
	assert.ok(f.seen.slice(before).every((call) => call.args.updatedAt === undefined));
});

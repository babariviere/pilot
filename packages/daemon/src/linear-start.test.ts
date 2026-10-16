import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Project, TrackedItem, TrackingJson } from "@pilot/protocol";
import { linearStart, pollLinear } from "./linear-source.ts";
import { startedWorkflowStates, workflowStates } from "./linear-workflow.ts";
import { ProjectStore, validateTrackingConfig } from "./projects.ts";
import { type SourcePollContext, SourceRegistry } from "./sources.ts";
import { TrackedItemStore, validatePatch } from "./tracked-items.ts";

function fake() {
	const issue = {
		id: "ENG-7",
		uuid: "issue-7",
		title: "Repair sample export",
		url: "https://example.com/issue/ENG-7",
		assigneeId: "user-me",
		teamId: "team-child",
		statusType: "unstarted",
		status: "Todo",
		updatedAt: "2026-10-01T00:00:00Z",
		cycleId: null,
		gitBranchName: null,
	};
	let member = true;
	let states: TrackingJson = [
		{ id: "review", type: "started", name: "Review", position: 2 },
		{ id: "todo", type: "unstarted", name: "Todo", position: 0 },
		{ id: "active", type: "started", name: "Building", position: 1 },
	];
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	let beforeWrite: (() => Promise<void>) | undefined;
	let beforeDetail: (() => Promise<void>) | undefined;
	let failure: Error | undefined;
	const ctx: SourcePollContext = {
		project: { id: "p" } as Project,
		config: {
			linearTeam: "team-root",
			slackChannels: [],
			linearStateMappings: { "team-child": { inProgress: { id: "active", name: "Building" } } },
		},
		signal: new AbortController().signal,
		async call(tool, args) {
			calls.push({ tool, args });
			if (tool === "me") {
				assert.deepEqual(args, { query: "me" });
				return { id: "user-me" };
			}
			if (tool === "cycles") return [];
			if (tool === "issues") {
				assert.equal(args.assignee, "me");
				assert.equal(args.team, "team-root");
				assert.equal(args.includeSubTeams, true);
				assert.equal(args.includeArchived, false);
				return {
					issues: member && (!args.state || args.state === issue.statusType) ? [{ ...issue }] : [],
					hasNextPage: false,
				};
			}
			if (tool === "states") {
				assert.deepEqual(args, { team: "team-child" });
				return states;
			}
			if (tool === "issue") {
				await beforeDetail?.();
				return { ...issue };
			}
			assert.equal(tool, "startIssue", "no other writes");
			assert.deepEqual(args, { id: "issue-7", state: "active" });
			await beforeWrite?.();
			if (failure) throw failure;
			issue.statusType = "started";
			issue.status = "Building";
			issue.updatedAt = "2026-10-02T00:00:00Z";
			return { id: "issue-7" };
		},
	};
	const item = { id: "local", externalId: "issue-7", kind: "linear", metadata: {} } as TrackedItem;
	return {
		ctx,
		issue,
		calls,
		item,
		setMember: (v: boolean) => {
			member = v;
		},
		setStates: (v: TrackingJson) => {
			states = v;
		},
		setFailure: (v: Error) => {
			failure = v;
		},
		beforeWrite: (v: () => Promise<void>) => {
			beforeWrite = v;
		},
		beforeDetail: (v: () => Promise<void>) => {
			beforeDetail = v;
		},
	};
}

test("only my unstarted/backlog/triage ticket moves to its actual team's configured started state", async () => {
	for (const type of ["unstarted", "backlog", "triage"]) {
		const f = fake();
		f.issue.statusType = type;
		assert.equal(await linearStart(f.ctx, f.item), "moved");
		assert.equal(f.calls.at(-1)?.tool, "startIssue");
		assert.equal(f.calls.at(-2)?.tool, "issue", "fresh detail immediately precedes write");
	}
	const ordered = fake();
	ordered.setStates([
		{ id: "review", type: "started", name: "Review" },
		{ id: "active", type: "started", name: "Building" },
	]);
	assert.equal(await linearStart(ordered.ctx, ordered.item), "moved", "configuration wins over server order");
});

test("automatic finds In progress, never Merged or Review regardless of position or response order", async () => {
	for (const name of ["In progress", "In Progress", " in-progress "]) {
		const f = fake();
		delete f.ctx.config.linearStateMappings;
		f.setStates([
			{ id: "merged", type: "started", name: "Merged", position: -100 },
			{ id: "review", type: "started", name: "Review", position: 0 },
			{ id: "active", type: "started", name, position: 100 },
		]);
		assert.equal(await linearStart(f.ctx, f.item), "moved");
	}
});

test("missing, ambiguous, foreign-team or recategorized targets fail without falling back", async () => {
	for (const states of [
		[{ id: "merged", type: "started", name: "Merged" }],
		[{ id: "active", type: "completed", name: "Building" }],
	]) {
		const f = fake();
		f.setStates(states);
		await assert.rejects(linearStart(f.ctx, f.item), /Choose a start state/);
		assert.ok(!f.calls.some((call) => call.tool === "startIssue"));
	}
	for (const states of [
		[{ id: "merged", type: "started", name: "Merged" }],
		[
			{ id: "active", type: "started", name: "In progress" },
			{ id: "another", type: "started", name: "In Progress" },
		],
	]) {
		const f = fake();
		f.ctx.config.linearStateMappings = { "team-root": { inProgress: { id: "merged", name: "Merged" } } };
		f.setStates(states);
		await assert.rejects(linearStart(f.ctx, f.item), /Choose a start state/);
		assert.ok(!f.calls.some((call) => call.tool === "startIssue"));
	}
});

test("workflow lookup accepts both MCP shapes and returns only valid started choices", () => {
	const states = [
		{ id: "review", type: "started", name: "Review" },
		{ id: "done", type: "completed", name: "Done" },
		{ id: "active", type: "started", name: "In progress" },
	];
	const expected = [
		{ id: "active", name: "In progress" },
		{ id: "review", name: "Review" },
	];
	assert.deepEqual(startedWorkflowStates(states), expected);
	assert.deepEqual(startedWorkflowStates({ statuses: states }), expected);
	assert.deepEqual(
		workflowStates(states),
		[...states].sort((a, b) => a.name.localeCompare(b.name)),
	);
	for (const response of [
		null,
		{},
		[null],
		[{ type: "started", id: "a" }],
		Array(501).fill(states[0]),
		[states[0], states[0]],
	])
		assert.throws(() => startedWorkflowStates(response));
});

test("start state config is strictly bounded, normalized and cleared with the attached team", () => {
	const base = { slackChannels: [], linearTeam: "root" };
	const states = { child: { inProgress: { id: " active ", name: " Building " } } };
	assert.deepEqual(validateTrackingConfig({ ...base, linearStateMappings: states }).linearStateMappings, {
		child: { inProgress: { id: "active", name: "Building" } },
	});
	assert.equal(
		validateTrackingConfig({ ...base, linearTeam: "", linearStateMappings: states }).linearStateMappings,
		undefined,
	);
	for (const invalid of [
		null,
		[],
		"active",
		{ child: null },
		{ child: { inProgress: { id: "", name: "Building" } } },
		{ child: { inProgress: { id: "a", name: "b", type: "started" } } },
		{ child: { unknownStage: { id: "a", name: "b" } } },
		{ child: { inReview: null } },
		{ child: { canceled: null } },
		{ child: { duplicated: { id: " ", name: "Duplicate" } } },
		{ child: { canceled: { id: "canceled", name: 1 } } },
		{ child: { duplicated: { id: "duplicate", name: "Duplicate", team: "other" } } },
		{ child: [] },
		{ " ": { todo: { id: "a", name: "b" } } },
		Object.fromEntries(Array.from({ length: 251 }, (_, i) => [`team-${i}`, { inProgress: { id: "a", name: "b" } }])),
	])
		assert.throws(() => validateTrackingConfig({ ...base, linearStateMappings: invalid }), /linearStateMappings/);
});

test("canceled and duplicated config normalizes references without changing existing team mappings", () => {
	const existing = { inProgress: { id: "active", name: "Building" }, merged: { id: "merged", name: "Merged" } };
	const config = validateTrackingConfig({
		slackChannels: [],
		linearTeam: "root",
		linearStateMappings: {
			root: existing,
			child: {
				canceled: { id: " canceled ", name: " Won't do " },
				duplicated: { id: " duplicate ", name: " Duplicate " },
			},
		},
	});
	assert.deepEqual(config.linearStateMappings, {
		root: existing,
		child: { canceled: { id: "canceled", name: "Won't do" }, duplicated: { id: "duplicate", name: "Duplicate" } },
	});
	assert.equal(validateTrackingConfig({ ...config, linearTeam: "" }).linearStateMappings, undefined);
});

test("reassigned, out-of-scope, already started and terminal tickets never write", async () => {
	for (const type of ["started", "completed", "canceled", "duplicate"]) {
		const f = fake();
		f.beforeDetail(async () => {
			f.issue.statusType = type;
		});
		assert.equal(await linearStart(f.ctx, f.item), "skipped");
		assert.ok(!f.calls.some((c) => c.tool === "startIssue"));
	}
	for (const field of ["assigneeId", "teamId"] as const) {
		const f = fake();
		f.beforeDetail(async () => {
			f.issue[field] = "elsewhere";
		});
		assert.equal(await linearStart(f.ctx, f.item), "skipped");
		assert.ok(!f.calls.some((c) => c.tool === "startIssue"));
	}
	const outside = fake();
	outside.setMember(false);
	assert.equal(await linearStart(outside.ctx, outside.item), "skipped");
	assert.deepEqual(
		outside.calls.map((c) => c.tool),
		["me", "issues", "issues", "issues", "issues"],
	);
});

test("missing/malformed workflow states and unknown issue states fail closed", async () => {
	for (const states of [[], [{ id: "todo", type: "unstarted" }], {}, [{ type: "started" }], [null]]) {
		const f = fake();
		f.setStates(states);
		await assert.rejects(linearStart(f.ctx, f.item));
		assert.ok(!f.calls.some((c) => c.tool === "startIssue"));
	}
	const f = fake();
	f.beforeDetail(async () => {
		f.issue.statusType = "future-type";
	});
	await assert.rejects(linearStart(f.ctx, f.item), /Unknown Linear state/);
});

async function registry(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-linear-start-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({
		path: home,
		tracking: {
			linearTeam: "team-root",
			slackChannels: [],
			linearStateMappings: { "team-child": { inProgress: { id: "active", name: "Building" } } },
		},
	});
	const path = join(home, "tracked.sqlite");
	const items = new TrackedItemStore(path);
	await items.load([project.id]);
	const f = fake();
	const tracking = new SourceRegistry(projects, items, {
		call(kind, tool, args, signal) {
			assert.equal(kind, "linear");
			signal.throwIfAborted();
			return f.ctx.call(tool, args);
		},
	});
	tracking.register("linear", pollLinear);
	await tracking.poll(`${project.id}:linear`);
	const item = (await items.list({ projectId: project.id })).items[0]!;
	f.calls.length = 0;
	t.after(async () => {
		await tracking.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	return { ...f, item, tracking, items, project, projects, path };
}

test("settings workflow choices come from the requested actual team, including terminal states", async (t) => {
	const f = await registry(t);
	f.setStates([
		{ id: "canceled", name: "Won't do", type: "canceled" },
		{ id: "duplicate", name: "Duplicate", type: "duplicate" },
	]);
	assert.deepEqual(await f.tracking.linearStates("team-child"), {
		status: "ok",
		items: [
			{ id: "duplicate", name: "Duplicate", type: "duplicate" },
			{ id: "canceled", name: "Won't do", type: "canceled" },
		],
	});
	assert.deepEqual(f.calls, [{ tool: "states", args: { team: "team-child" } }]);
});

test("all seven mappings persist without writes; starting work applies only In progress", async (t) => {
	const f = await registry(t);
	const mapping = {
		todo: { id: "todo", name: "Todo" },
		inProgress: { id: "active", name: "Building" },
		inReview: { id: "review", name: "Review" },
		merged: { id: "merged", name: "Merged" },
		deployed: { id: "deployed", name: "Deployed" },
		canceled: { id: "canceled", name: "Won't do" },
		duplicated: { id: "duplicate", name: "Duplicate" },
	};
	await f.projects.update(f.project.id, {
		tracking: { ...f.project.tracking!, linearStateMappings: { "team-child": mapping } },
	});
	assert.equal(f.calls.length, 0, "saving mappings is local only");
	const reopened = new ProjectStore(f.project.path);
	await reopened.load();
	assert.deepEqual(reopened.require(f.project.id).tracking?.linearStateMappings, { "team-child": mapping });
	await assert.rejects(
		f.projects.update(f.project.id, {
			tracking: { ...f.project.tracking!, linearStateMappings: { "team-child": { canceled: null } } } as never,
		}),
		/linearStateMappings/,
	);
	assert.deepEqual(f.projects.require(f.project.id).tracking?.linearStateMappings, { "team-child": mapping });
	await f.tracking.poll(`${f.project.id}:linear`);
	assert.ok(!f.calls.some((call) => call.tool === "startIssue"), "polling never applies saved lifecycle mappings");
	await f.tracking.startLinear(f.item);
	assert.deepEqual(
		f.calls.filter((call) => call.tool === "startIssue"),
		[{ tool: "startIssue", args: { id: "issue-7", state: "active" } }],
	);
	const { canceled: _canceled, duplicated: _duplicated, ...legacy } = mapping;
	await f.projects.update(f.project.id, {
		tracking: { ...f.project.tracking!, linearStateMappings: { "team-child": legacy } },
	});
	await reopened.load();
	assert.deepEqual(reopened.require(f.project.id).tracking?.linearStateMappings, { "team-child": legacy });
});

test("confirmed chat/mission binding does not await MCP; duplicate starts coalesce and sync reflects state", async (t) => {
	for (const link of [{ sessionId: "chat-1" }, { missionId: "mission-1" }]) {
		const f = await registry(t);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		f.beforeWrite(() => gate);
		t.after(release);
		const linked = await f.tracking.patch(f.item.id, { ...link, start: true });
		assert.equal(linked.sessionId ?? linked.missionId, Object.values(link)[0]);
		const pending = f.tracking.startLinear(linked);
		assert.equal(f.tracking.startLinear(linked), pending);
		assert.equal((await f.items.require(linked.id)).status, "Todo", "no optimistic state mutation");
		release();
		await pending;
		assert.equal(
			((await f.items.require(linked.id)).metadata.linearStart as Record<string, TrackingJson>).outcome,
			"moved",
		);
		await f.tracking.patch(linked.id, { ...link, start: true });
		assert.equal(f.calls.filter((c) => c.tool === "startIssue").length, 1, "replayed link does not write again");
		await f.tracking.poll(`${f.project.id}:linear`);
		assert.equal((await f.items.require(linked.id)).status, "Building");
		assert.equal(f.tracking.dashboard(f.project.id)[0]?.items[0]?.metadata?.statusType, "started");
	}
});

test("remote failure is quiet, durable, visible on dashboard and preserved through sync", async (t) => {
	const f = await registry(t);
	f.setFailure(new Error("secret external error body"));
	const linked = await f.tracking.patch(f.item.id, { sessionId: "chat", start: true });
	await f.tracking.startLinear(linked);
	const failed = await f.items.require(linked.id);
	assert.equal(failed.sessionId, "chat");
	assert.deepEqual(failed.metadata.linearStart, {
		outcome: "error",
		attemptedAt: (failed.metadata.linearStart as Record<string, TrackingJson>).attemptedAt,
		error: "Couldn't update ticket state. Check Linear and the start state in Project settings.",
	});
	assert.ok(!JSON.stringify(failed).includes("secret"));
	assert.deepEqual(
		f.tracking.dashboard(f.project.id)[0]?.items[0]?.metadata?.linearStart,
		failed.metadata.linearStart,
	);
	await f.tracking.poll(`${f.project.id}:linear`);
	assert.deepEqual((await f.items.require(linked.id)).metadata.linearStart, failed.metadata.linearStart);
	const reopened = new TrackedItemStore(f.path);
	try {
		await reopened.load([f.project.id]);
		assert.deepEqual((await reopened.require(linked.id)).metadata.linearStart, failed.metadata.linearStart);
	} finally {
		await reopened.close();
	}
});

test("ordinary links, Slack starts and invalid starts never call Linear", async (t) => {
	const f = await registry(t);
	await f.tracking.patch(f.item.id, { missionId: "existing" });
	await f.items.commit(f.project.id, "slack", [
		{
			externalId: "C1/1.000001",
			title: "Sample question",
			url: "https://example.com",
			status: "open",
			metadata: {},
			updatedAt: 1,
		},
	]);
	const slack = (await f.items.list({ projectId: f.project.id, kind: "slack" })).items[0]!;
	await f.tracking.patch(slack.id, { sessionId: "s", start: true });
	assert.equal(f.calls.length, 0);
	for (const patch of [
		{ start: true },
		{ start: "yes" },
		{ start: true, sessionId: "s", missionId: "m" },
		{ start: true, sessionId: null },
		{ start: true, sessionId: "s", dismissed: true },
	])
		assert.throws(() => validatePatch(patch));
});

test("configuration change cancels obsolete start before any write", async (t) => {
	const f = await registry(t);
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const reading = new Promise<void>((r) => {
		entered = r;
	});
	f.beforeDetail(async () => {
		entered();
		await gate;
	});
	t.after(release);
	const pending = f.tracking.startLinear(f.item);
	await reading;
	await f.projects.update(f.project.id, { tracking: { linearTeam: "other", slackChannels: [] } });
	release();
	await pending;
	assert.ok(!f.calls.some((c) => c.tool === "startIssue"));
	assert.equal(
		((await f.items.require(f.item.id)).metadata.linearStart as Record<string, TrackingJson>).outcome,
		"error",
	);
});

test("editing only the start target fences an in-flight write without invalidating the poll scope", async (t) => {
	const f = await registry(t);
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const reading = new Promise<void>((resolve) => {
		entered = resolve;
	});
	f.beforeDetail(async () => {
		entered();
		await gate;
	});
	t.after(release);
	const checkpoint = f.items.checkpoint(`${f.project.id}:linear`);
	const pending = f.tracking.startLinear(f.item);
	await reading;
	await f.projects.update(f.project.id, {
		tracking: {
			...f.project.tracking!,
			linearStateMappings: { "team-child": { inProgress: { id: "review", name: "Review" } } },
		},
	});
	release();
	await pending;
	assert.ok(!f.calls.some((call) => call.tool === "startIssue"));
	assert.deepEqual(f.items.checkpoint(`${f.project.id}:linear`), checkpoint);
	const reopened = new ProjectStore(f.project.path);
	await reopened.load();
	assert.deepEqual(reopened.require(f.project.id).tracking?.linearStateMappings, {
		"team-child": { inProgress: { id: "review", name: "Review" } },
	});
});

test("start admission is bounded and shutdown cancels work without retrying", async (t) => {
	const f = await registry(t);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.beforeDetail(() => gate);
	t.after(release);
	await f.items.commit(
		f.project.id,
		"linear",
		["issue-8", "issue-9"].map((externalId) => ({
			externalId,
			title: "Sample ticket",
			url: "https://example.com",
			status: "Todo",
			metadata: {},
			updatedAt: 1,
		})),
	);
	const extras = (await f.items.list({ projectId: f.project.id })).items.filter((item) => item.id !== f.item.id);
	const first = f.tracking.startLinear(f.item);
	const second = f.tracking.startLinear(extras[0]!);
	await f.tracking.startLinear(extras[1]!);
	assert.equal(
		((await f.items.require(extras[1]!.id)).metadata.linearStart as Record<string, TrackingJson>).outcome,
		"error",
	);
	await f.tracking.stop();
	release();
	await Promise.all([first, second]);
	assert.ok(!f.calls.some((call) => call.tool === "startIssue"));
});

test("source polling cannot use the confirmed-start write capability", async (t) => {
	const f = await registry(t);
	f.tracking.register("slack", async (context) => {
		await assert.rejects(context.call("startIssue", { id: "issue-7", state: "active" }), /cannot write/);
		return { items: [] };
	});
	await f.projects.update(f.project.id, { tracking: { linearTeam: "team-root", slackChannels: ["C1"] } });
	await f.tracking.poll(`${f.project.id}:slack`);
	assert.equal(f.calls.length, 0);
});

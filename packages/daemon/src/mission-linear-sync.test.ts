import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { LinearStateMapping, MissionTaskStatus } from "@pilot/protocol";
import { MissionLinearSyncService } from "./mission-linear-sync.ts";
import { MissionStore } from "./missions.ts";
import { ProjectStore } from "./projects.ts";
import type { SourceMcpClient } from "./source-mcp.ts";
import { SourceConfigurationError, SourceRateLimited, SourceSignInRequired, SourceToolError } from "./source-mcp.ts";
import { SourceRegistry } from "./sources.ts";
import { TrackedItemStore } from "./tracked-items.ts";

const states = [
	{ id: "todo", name: "Todo", type: "unstarted" },
	{ id: "active", name: "Building", type: "started" },
	{ id: "review", name: "Review", type: "started" },
	{ id: "merged", name: "Merged", type: "completed" },
	{ id: "deployed", name: "Deployed", type: "completed" },
	{ id: "canceled", name: "Canceled", type: "canceled" },
	{ id: "duplicate", name: "Duplicate", type: "duplicate" },
];
const mappings = Object.fromEntries(
	["inProgress", "inReview", "merged", "deployed", "canceled", "duplicated"].map((key, i) => [
		key,
		{ id: states[i + 1]!.id, name: states[i + 1]!.name },
	]),
) as LinearStateMapping;
const url = (n: number) => `https://linear.app/acme/issue/ENG-${n}`;
function remote(n = 1, state = "todo", teamId = "child") {
	return {
		id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
		identifier: `ENG-${n}`,
		url: url(n),
		teamId,
		status: states.find((s) => s.id === state)!.name,
		statusId: state,
		statusType: states.find((s) => s.id === state)!.type,
	};
}

async function fixture(t: TestContext, disk = false) {
	const dir = await mkdtemp(join(tmpdir(), "linear-sync-"));
	const projects = new ProjectStore(dir, async () => "");
	await projects.load();
	const project = await projects.create({
		path: dir,
		tracking: { linearTeam: "root", slackChannels: [], linearStateMappings: { child: mappings } },
	});
	const file = disk ? join(dir, "missions.sqlite") : ":memory:";
	let store = new MissionStore(file);
	const mission = store.create({
		projectId: project.id,
		title: "Delivery",
		tasks: [{ title: "A" }, { title: "B" }, { title: "Reference" }],
	});
	const manager = store.addResource(mission.id, { url: url(1), linearRole: "managed" });
	const a = store.addResource(mission.id, { url: url(1), taskId: "1", linearRole: "contribution" });
	const b = store.addResource(mission.id, { url: url(1), taskId: "2", linearRole: "contribution" });
	store.addResource(mission.id, { url: url(1), taskId: "3" });
	const issues = [remote()];
	const writes: Array<Record<string, unknown>> = [];
	const reads: Array<Record<string, unknown>> = [];
	let hook: ((tool: string, args: Record<string, unknown>) => void | Promise<void>) | undefined;
	let failure: "before" | "after" | undefined;
	const mcp: SourceMcpClient = {
		async call(kind, tool, args, signal) {
			assert.equal(kind, "linear");
			signal.throwIfAborted();
			await hook?.(tool, args);
			if (tool === "states") return states;
			const issue = issues.find((i) => i.id === args.id || i.identifier === args.id);
			assert.ok(issue, `unexpected issue ${args.id}`);
			if (tool === "issue") {
				reads.push(args);
				return { ...issue };
			}
			assert.equal(tool, "startIssue");
			assert.equal(args.id, issue.id, "write only immutable UUID");
			assert.deepEqual(Object.keys(args).sort(), ["id", "state"]);
			writes.push(args);
			if (failure === "before") throw new Error("secret transport error");
			const state = states.find((s) => s.id === args.state)!;
			issue.statusId = state.id;
			issue.status = state.name;
			issue.statusType = state.type;
			if (failure === "after") throw new DOMException("private accepted-write timeout", "TimeoutError");
			return { id: issue.id };
		},
	};
	let service = new MissionLinearSyncService(store, projects, mcp);
	t.after(async () => {
		await service.stop();
		await store.durable();
		store.close();
		await rm(dir, { recursive: true, force: true });
	});
	return {
		get store() {
			return store;
		},
		get service() {
			return service;
		},
		projects,
		mcp,
		project,
		mission,
		manager,
		a,
		b,
		issues,
		writes,
		reads,
		setHook(value: typeof hook) {
			hook = value;
		},
		setFailure(value: typeof failure) {
			failure = value;
		},
		status() {
			return store.linearSyncRecord(manager.id)!.status;
		},
		set(n: string, status: MissionTaskStatus) {
			store.updateTask(mission.id, n, { status });
		},
		state(value: string, n = 0) {
			Object.assign(issues[n]!, {
				statusId: value,
				status: states.find((s) => s.id === value)!.name,
				statusType: states.find((s) => s.id === value)!.type,
			});
		},
		poll() {
			return service.poll(new AbortController().signal);
		},
		async restart() {
			await service.stop();
			await store.durable();
			store.close();
			store = new MissionStore(file);
			service = new MissionLinearSyncService(store, projects, mcp);
		},
	};
}

test("aggregate actual task transitions through progress, review and Merged, never references", async (t) => {
	const f = await fixture(t);
	await f.poll();
	assert.equal(f.writes.length, 0);
	f.set("3", "done");
	await f.poll();
	assert.equal(f.writes.length, 0);
	f.set("1", "in_progress");
	await f.poll();
	assert.equal(f.writes.at(-1)?.state, "active");
	f.set("1", "done");
	await f.poll();
	assert.equal(f.writes.length, 1, "mixed done/todo isn't completion");
	f.set("2", "in_review");
	await f.poll();
	assert.equal(f.writes.at(-1)?.state, "review");
	f.set("2", "done");
	await f.poll();
	assert.equal(f.writes.at(-1)?.state, "merged");
	assert.equal(f.status().state, "synced");
	assert.equal(f.status().teamId, "child", "root selection isn't the actual issue team");
	assert.ok(f.reads.slice(1).every((r) => r.id === f.issues[0]!.id));
});

for (const state of ["deployed", "canceled", "duplicate"]) {
	test(`preserve ${state}; inbound cancellation drops only unfinished contributors`, async (t) => {
		const f = await fixture(t);
		f.set("1", "done");
		f.state(state);
		await f.poll();
		assert.equal(f.writes.length, 0);
		assert.equal(f.status().state, "terminal");
		assert.equal(f.store.resolveTask(f.mission.id, "1").status, "done");
		assert.equal(f.store.resolveTask(f.mission.id, "2").status, state === "deployed" ? "todo" : "dropped");
		assert.equal(f.store.resolveTask(f.mission.id, "3").status, "todo");
	});
}

test("a shared task is preserved for another active ticket; fresh peer cancellation permits drop", async (t) => {
	const f = await fixture(t);
	const peer = f.store.addResource(f.mission.id, { url: url(2), linearRole: "managed" });
	f.store.addResource(f.mission.id, { url: url(2), taskId: "2", linearRole: "contribution" });
	f.issues.push(remote(2));
	f.state("canceled");
	await f.poll();
	assert.equal(f.store.resolveTask(f.mission.id, "1").status, "dropped");
	assert.equal(f.store.resolveTask(f.mission.id, "2").status, "todo");
	f.state("duplicate", 1);
	await f.poll();
	assert.equal(f.store.resolveTask(f.mission.id, "2").status, "dropped");
	assert.equal(f.store.linearSyncRecord(peer.id)!.status.state, "terminal");
});

test("missing mappings fail actionably and durably; retry budget is bounded and explicit resume retries", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const f = await fixture(t, true);
	await f.projects.update(f.project.id, { tracking: { linearTeam: "root", slackChannels: [] } });
	f.set("1", "done");
	f.set("2", "done");
	for (let i = 0; i < 6; i++) {
		now += 600_000;
		await f.poll();
	}
	assert.equal(f.status().state, "error");
	assert.match(f.status().error!, /merged.*actual team.*Project settings/);
	assert.equal(f.store.linearSyncRecord(f.manager.id)!.attempts, 5);
	const reads = f.reads.length;
	await f.restart();
	await f.poll();
	assert.equal(
		f.reads.length,
		reads + 1,
		"periodic observation still detects inbound cancellation after write retries stop",
	);
	await f.projects.update(f.project.id, {
		tracking: { linearTeam: "root", slackChannels: [], linearStateMappings: { child: mappings } },
	});
	f.store.controlLinearSync(f.mission.id, f.manager.id, "resume");
	await f.poll();
	assert.equal(f.writes.at(-1)?.state, "merged");
});

test("manual changes pause across task edits and restart; resume accepts reviewed baseline", async (t) => {
	const f = await fixture(t, true);
	f.set("1", "in_progress");
	await f.poll();
	f.state("review");
	await f.poll();
	assert.equal(f.status().state, "paused");
	f.set("1", "done");
	f.set("2", "done");
	await f.restart();
	await f.poll();
	assert.equal(f.writes.length, 1);
	assert.equal(f.status().state, "paused");
	f.store.controlLinearSync(f.mission.id, f.manager.id, "resume");
	await f.poll();
	assert.equal(f.writes.at(-1)?.state, "merged");
	f.set("1", "todo");
	await f.poll();
	assert.equal(f.status().state, "paused");
	assert.match(f.status().reason!, /reopened/);
	assert.equal((await f.service.closingEligibility(f.mission.id, f.manager.id)).allowed, false);
});

test("empty sets and structural detach never manufacture completion, including ABA edits", async (t) => {
	const f = await fixture(t);
	f.set("1", "done");
	await f.poll();
	f.store.removeResource(f.mission.id, f.b.id);
	await f.poll();
	assert.equal(f.status().state, "paused");
	assert.equal(f.writes.length, 1);
	f.store.removeResource(f.mission.id, f.a.id);
	await f.poll();
	assert.equal(f.writes.length, 1);
	const g = await fixture(t);
	g.set("1", "done");
	g.set("2", "done");
	let once = false;
	g.setHook((tool) => {
		if (tool !== "states" || once) return;
		once = true;
		g.store.updateResource(g.mission.id, g.b.id, { linearRole: "reference" });
		g.store.updateResource(g.mission.id, g.b.id, { linearRole: "contribution" });
	});
	await g.poll();
	assert.equal(g.writes.length, 0);
	assert.equal(g.status().state, "paused");
});

test("restart reconciles an ambiguous successful remote write without replay", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const f = await fixture(t, true);
	f.set("1", "done");
	f.set("2", "done");
	f.setFailure("after");
	await f.poll();
	assert.equal(f.status().state, "error");
	assert.doesNotMatch(f.status().error!, /ambiguous|secret/);
	assert.deepEqual(f.status().failure, { stage: "write", category: "transport" });
	assert.equal(f.store.linearSyncRecord(f.manager.id)!.intent?.stateId, "merged");
	await f.restart();
	now += 600_000;
	f.setFailure(undefined);
	await f.poll();
	assert.equal(f.writes.length, 1);
	assert.equal(f.status().state, "synced");
	assert.equal(f.status().failure, undefined);
	assert.equal(f.status().retryAt, undefined);
	assert.equal(f.store.linearSyncRecord(f.manager.id)!.attempts, 0);
	await f.poll();
	assert.equal(f.writes.length, 1);
});

test("stale final reads, immutable identity changes and moved teams never write", async (t) => {
	const f = await fixture(t);
	await f.poll();
	f.issues[0]!.teamId = "moved";
	f.set("1", "done");
	f.set("2", "done");
	await f.poll();
	assert.equal(f.status().state, "paused");
	assert.equal(f.writes.length, 0);
	f.issues[0]!.teamId = "child";
	f.store.controlLinearSync(f.mission.id, f.manager.id, "resume");
	let reads = 0;
	f.setHook((tool) => {
		if (tool === "issue" && ++reads === 2) f.set("2", "todo");
	});
	await f.poll();
	assert.equal(f.writes.length, 0);
	const g = await fixture(t);
	await g.poll();
	g.set("1", "in_progress");
	g.issues[0]!.id = remote(2).id;
	await g.poll();
	assert.equal(g.writes.length, 0);
	assert.equal(g.status().state, "error");
});

test("user pause cannot be lost on a failed observation and unsafe closing guards fail closed", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const f = await fixture(t);
	f.store.controlLinearSync(f.mission.id, f.manager.id, "pause");
	f.setHook(() => {
		throw new Error("offline");
	});
	await f.poll();
	assert.equal(f.status().state, "paused");
	now += 600_000;
	f.setHook(undefined);
	f.set("1", "done");
	f.set("2", "done");
	await f.poll();
	assert.equal(f.status().state, "paused");
	assert.equal(f.writes.length, 0);
	assert.equal((await f.service.closingEligibility(f.mission.id, f.manager.id)).allowed, false);
	assert.equal((await f.service.closingEligibility("other", f.manager.id)).allowed, false);
});

test("dropped, blocked and delegated contributors prevent review or completion", async (t) => {
	for (const status of ["dropped", "blocked", "delegated", "todo"] as const) {
		const f = await fixture(t);
		f.set("1", status);
		f.set("2", "in_review");
		await f.poll();
		assert.equal(f.writes.at(-1)?.state, "active");
		f.set("2", "done");
		await f.poll();
		assert.notEqual(f.writes.at(-1)?.state, "merged");
	}
});

test("initial all-Done attachment and reference-only empty scopes cannot complete", async (t) => {
	const f = await fixture(t);
	f.store.removeResource(f.mission.id, f.a.id);
	f.store.removeResource(f.mission.id, f.b.id);
	f.set("1", "done");
	f.set("2", "done");
	f.store.addResource(f.mission.id, { url: url(1), taskId: "1", linearRole: "contribution" });
	f.store.addResource(f.mission.id, { url: url(1), taskId: "2", linearRole: "contribution" });
	await f.poll();
	assert.equal(f.writes.length, 0);
});

test("inbound cancellation works without outbound mappings and retries after a detach race", async (t) => {
	const f = await fixture(t, true);
	await f.projects.update(f.project.id, { tracking: { linearTeam: "root", slackChannels: [] } });
	f.state("canceled");
	let reads = 0;
	f.setHook((tool) => {
		if (tool === "issue" && ++reads === 2) f.store.updateResource(f.mission.id, f.b.id, { linearRole: "reference" });
	});
	await f.poll();
	assert.equal(f.store.resolveTask(f.mission.id, "1").status, "todo", "stale cancellation cannot mutate any task");
	f.setHook(undefined);
	await f.restart();
	await f.poll();
	assert.equal(f.store.resolveTask(f.mission.id, "1").status, "dropped");
	assert.equal(f.store.resolveTask(f.mission.id, "2").status, "todo", "detached tasks stay open");
});

test("mapping changes and detach during durable intent save fence outbound writes", async (t) => {
	const f = await fixture(t);
	f.set("1", "done");
	f.set("2", "done");
	let detached = false;
	t.mock.method(f.store, "durable", async () => {
		if (detached) return;
		detached = true;
		f.store.removeResource(f.mission.id, f.b.id);
	});
	await f.poll();
	assert.equal(f.writes.length, 0);
	assert.equal(f.status().state, "paused");
	const g = await fixture(t);
	g.set("1", "in_progress");
	let once = false;
	g.setHook(async (tool) => {
		if (tool !== "states" || once) return;
		once = true;
		await g.projects.update(g.project.id, { tracking: { linearTeam: "root", slackChannels: [] } });
	});
	await g.poll();
	assert.equal(g.writes.length, 0);
});

test("rate limits persist backoff across restart; failed write retries after its delay", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const f = await fixture(t, true);
	f.set("1", "in_progress");
	f.setHook(() => {
		throw new SourceRateLimited(900_000);
	});
	await f.poll();
	assert.equal(f.status().retryAt, now + 900_000);
	assert.deepEqual(f.status().failure, { stage: "issue", category: "rate_limited" });
	f.setHook(undefined);
	await f.restart();
	await f.poll();
	assert.equal(f.writes.length, 0);
	now += 900_001;
	f.setFailure("before");
	await f.poll();
	assert.equal(f.writes.length, 1);
	f.setFailure(undefined);
	now += 600_000;
	await f.poll();
	assert.equal(f.writes.length, 2);
	assert.equal(f.status().state, "synced");
});

test("closing eligibility freshly verifies mappings and scope without remote writes", async (t) => {
	const f = await fixture(t);
	f.set("1", "done");
	assert.equal((await f.service.closingEligibility(f.mission.id, f.manager.id)).allowed, true);
	assert.equal(f.writes.length, 0);
	f.store.removeResource(f.mission.id, f.b.id);
	assert.equal((await f.service.closingEligibility(f.mission.id, f.manager.id)).allowed, false);
	assert.equal(f.writes.length, 0);
	f.store.controlLinearSync(f.mission.id, f.manager.id, "resume");
	assert.equal((await f.service.closingEligibility(f.mission.id, f.manager.id)).allowed, true);
	f.state("deployed");
	assert.equal((await f.service.closingEligibility(f.mission.id, f.manager.id)).allowed, false);
});

test("unrelated streaming activity does not wake the sync scheduler", async (t) => {
	const f = await fixture(t);
	let wakes = 0;
	const stop = f.store.onLinearSyncChange(() => wakes++);
	t.after(stop);
	for (let i = 0; i < 100; i++) f.store.log(f.mission.id, { text: `activity ${i}` });
	assert.equal(wakes, 0);
	f.set("1", "in_progress");
	assert.equal(wakes, 1);
	await f.poll();
	assert.equal(wakes, 1, "remote observations don't cause another poll");
});

test("polls rotate through at most 25 managed tickets, never an unbounded network fanout", async (t) => {
	const f = await fixture(t);
	for (let n = 2; n <= 30; n++) {
		f.issues.push(remote(n));
		f.store.addResource(f.mission.id, { url: url(n), linearRole: "managed" });
	}
	await f.poll();
	assert.equal(f.reads.length, 25);
	await f.poll();
	assert.equal(f.reads.length, 30);
	assert.equal(f.writes.length, 0);
});

test("renamed identifiers keep their pinned UUID, workspace mismatches never bind", async (t) => {
	const f = await fixture(t);
	await f.poll();
	f.issues[0]!.identifier = "NEW-900";
	f.issues[0]!.url = "https://linear.app/renamed/issue/NEW-900";
	f.set("1", "in_progress");
	await f.poll();
	assert.equal(f.writes.at(-1)?.id, f.issues[0]!.id);
	const g = await fixture(t);
	g.issues[0]!.url = "https://linear.app/other/issue/ENG-1";
	g.set("1", "in_progress");
	await g.poll();
	assert.equal(g.writes.length, 0);
	assert.match(g.status().error!, /workspace/);
});

test("manual pauses do not hide inbound cancellation or change its task policy", async (t) => {
	const f = await fixture(t);
	f.store.controlLinearSync(f.mission.id, f.manager.id, "pause");
	f.state("canceled");
	await f.poll();
	assert.equal(f.status().state, "terminal");
	assert.equal(f.status().reason, "canceled");
	assert.equal(f.store.resolveTask(f.mission.id, "1").status, "dropped");
	assert.equal(f.store.resolveTask(f.mission.id, "3").status, "todo");
});

test("another URL cannot acquire a second writer for the same immutable UUID", async (t) => {
	const f = await fixture(t);
	await f.poll();
	const duplicate = f.store.addResource(f.mission.id, { url: url(2), linearRole: "managed" });
	f.issues.push({ ...remote(2), id: f.issues[0]!.id });
	await f.poll();
	const status = f.store.linearSyncRecord(duplicate.id)!.status;
	assert.equal(status.state, "error");
	assert.match(status.error!, /already has a verified managing link/);
	assert.equal(status.issueId, undefined);
	assert.equal(f.writes.length, 0);
});

test("Needs you counts each paused or failed managed ticket and clears on recovery", async (t) => {
	const f = await fixture(t, true);
	assert.equal(f.store.require(f.mission.id).needsYouCount, 0);
	f.store.controlLinearSync(f.mission.id, f.manager.id, "pause");
	assert.equal(f.store.require(f.mission.id).needsYouCount, 1);
	assert.match(f.store.require(f.mission.id).needsYouReason!, /Linear ENG-1:.*paused/);
	f.store.controlLinearSync(f.mission.id, f.manager.id, "resume");
	assert.equal(f.store.require(f.mission.id).needsYouCount, 0);
	f.setHook(() => {
		throw new Error("offline");
	});
	await f.poll();
	assert.equal(f.store.list()[0]!.needsYouCount, 1);
	assert.match(f.store.require(f.mission.id).needsYouReason!, /Linear ENG-1:.*connection/);
	await f.restart();
	assert.equal(f.store.detail(f.mission.id).mission.needsYouCount, 1);
	f.setHook(undefined);
	f.store.controlLinearSync(f.mission.id, f.manager.id, "resume");
	await f.poll();
	assert.equal(f.store.require(f.mission.id).needsYouCount, 0);
	assert.equal(f.store.require(f.mission.id).needsYouReason, undefined);
});

test("already In Progress is a verified no-op, but later review and completion still synchronize", async (t) => {
	const f = await fixture(t);
	f.state("active");
	f.set("1", "in_progress");
	await Promise.all([f.poll(), f.poll(), f.poll()]);
	await f.poll();
	assert.equal(f.writes.length, 0);
	assert.equal(f.status().state, "synced");
	assert.equal(f.status().observedStateId, "active");
	assert.equal(f.store.linearSyncRecord(f.manager.id)!.intent, undefined);
	f.set("1", "done");
	f.set("2", "in_review");
	await f.poll();
	f.set("2", "done");
	await f.poll();
	assert.deepEqual(
		f.writes.map((w) => w.state),
		["review", "merged"],
	);
});

test("Todo transitions once even with concurrent and repeated requests", async (t) => {
	const f = await fixture(t);
	f.set("1", "in_progress");
	await Promise.all([f.poll(), f.poll(), f.poll()]);
	await f.poll();
	assert.deepEqual(
		f.writes.map((w) => w.state),
		["active"],
	);
	assert.equal(f.status().state, "synced");
});

test("a matching final pre-write observation reconciles without pausing or writing", async (t) => {
	const f = await fixture(t);
	f.set("1", "in_progress");
	let reads = 0;
	f.setHook((tool) => {
		if (tool === "issue" && ++reads === 2) f.state("active");
	});
	await f.poll();
	assert.equal(f.status().state, "synced");
	assert.equal(f.status().observedStateId, "active");
	assert.equal(f.writes.length, 0);
});

test("read-only eligibility cannot clear a failed pending write; mission reconciliation clears its own backoff", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const f = await fixture(t);
	f.set("1", "in_progress");
	f.setFailure("before");
	await f.poll();
	const failed = f.status();
	assert.equal(failed.state, "error");
	now += 600_000;
	f.setFailure(undefined);
	assert.equal((await f.service.closingEligibility(f.mission.id, f.manager.id)).allowed, false);
	assert.equal(f.status().error, failed.error);
	assert.equal(f.status().retryAt, failed.retryAt);
	assert.equal(f.store.require(f.mission.id).needsYouCount, 1);
	await f.poll();
	assert.equal(f.status().state, "synced");
	assert.equal(f.status().error, undefined);
	assert.equal(f.status().failure, undefined);
	assert.equal(f.status().retryAt, undefined);
	assert.equal(f.store.linearSyncRecord(f.manager.id)!.attempts, 0);
	assert.equal(f.store.require(f.mission.id).needsYouCount, 0);
});

test("mission failures retain sanitized stages/categories across restart", async (t) => {
	for (const [tool, error, category, advice] of [
		["issue", new SourceToolError("private detail", "access_denied"), "access_denied", /permissions/],
		["issue", new SourceToolError("private detail", "not_found"), "not_found", /not found/],
		["issue", new SourceConfigurationError("private detail"), "configuration", /settings/],
		["issue", new SourceSignInRequired("private detail"), "sign_in", /Sign in/],
		["issue", new Error("private detail"), "transport", /connection/],
		["states", new SourceToolError("private detail"), "remote_error", /workflow/],
		["startIssue", new SourceToolError("private detail"), "write_failed", /status update/],
	] as const) {
		await t.test(`${tool}: ${category}`, async (t) => {
			const f = await fixture(t, true);
			f.set("1", "in_progress");
			f.setHook((current) => {
				if (current === tool) throw error;
			});
			await f.poll();
			assert.equal(f.status().state, "error");
			assert.deepEqual(f.status().failure, { stage: tool === "startIssue" ? "write" : tool, category });
			assert.match(f.status().error!, advice);
			assert.doesNotMatch(JSON.stringify(f.status()), /private/);
			const failed = f.status();
			await f.restart();
			assert.deepEqual(f.status(), failed);
		});
	}
});

test("missing issue responses and missing mappings are not reported as connection failures", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.mcp, "call", async () => null);
	await f.poll();
	assert.deepEqual(f.status().failure, { stage: "issue", category: "not_found" });
	const g = await fixture(t);
	await g.projects.update(g.project.id, { tracking: { linearTeam: "root", slackChannels: [] } });
	g.set("1", "in_progress");
	await g.poll();
	assert.deepEqual(g.status().failure, { stage: "configuration", category: "configuration" });
	assert.equal(g.writes.length, 0);
});

test("successful background discovery and commit cannot clear a mission sync failure", async (t) => {
	const f = await fixture(t);
	f.set("1", "in_progress");
	f.setFailure("before");
	await f.poll();
	const failed = f.store.linearSyncRecord(f.manager.id);
	const home = await mkdtemp(join(tmpdir(), "linear-discovery-"));
	const items = new TrackedItemStore(join(home, "tracked.sqlite"));
	await items.load([f.project.id]);
	const registry = new SourceRegistry(f.projects, items, f.mcp);
	t.after(async () => {
		await registry.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	registry.register("linear", async () => ({ items: [], activeIds: [] }));
	assert.equal((await registry.poll(`${f.project.id}:linear`)).status, "ok");
	assert.deepEqual(f.store.linearSyncRecord(f.manager.id), failed);
	assert.equal(f.store.require(f.mission.id).needsYouCount, 1);
});

test("an already-matching ticket still verifies workflow guards and respects explicit pauses", async (t) => {
	const f = await fixture(t);
	f.state("active");
	f.set("1", "in_progress");
	await f.projects.update(f.project.id, {
		tracking: {
			linearTeam: "root",
			slackChannels: [],
			linearStateMappings: {
				child: { ...mappings, deployed: { id: "todo", name: "Todo" } },
			},
		},
	});
	await f.poll();
	assert.equal(f.status().state, "error", "a status no-op cannot skip other required validation");
	assert.equal(f.status().failure?.category, "configuration");
	assert.equal(f.writes.length, 0);
	const g = await fixture(t);
	g.state("active");
	g.set("1", "in_progress");
	g.store.controlLinearSync(g.mission.id, g.manager.id, "pause");
	await g.poll();
	assert.equal(g.status().state, "paused");
	assert.equal(g.writes.length, 0);
});

test("terminal observation retains its warning until required cancellation reconciliation succeeds", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const f = await fixture(t);
	f.set("1", "in_progress");
	f.setFailure("before");
	await f.poll();
	const failed = f.status();
	now += 600_000;
	f.state("canceled");
	let reads = 0;
	let observedError: string | undefined;
	let observedNeedsYou = 0;
	f.setHook((tool) => {
		if (tool === "issue" && ++reads === 2) {
			observedError = f.status().error;
			observedNeedsYou = f.store.require(f.mission.id).needsYouCount;
			throw new SourceToolError("private detail");
		}
	});
	await f.poll();
	assert.equal(observedError, failed.error);
	assert.equal(observedNeedsYou, 1);
	assert.deepEqual(f.status().failure, { stage: "cancellation", category: "remote_error" });
	assert.equal(f.store.require(f.mission.id).needsYouCount, 1);
	f.setHook(undefined);
	now += 600_000;
	await f.poll();
	assert.equal(f.status().state, "terminal");
	assert.equal(f.status().error, undefined);
	assert.equal(f.status().failure, undefined);
	assert.equal(f.status().retryAt, undefined);
	assert.equal(f.store.linearSyncRecord(f.manager.id)!.attempts, 0);
	assert.equal(f.store.require(f.mission.id).needsYouCount, 0);
	assert.equal(f.store.resolveTask(f.mission.id, "1").status, "dropped");
});

test("a status no-op does not skip synchronization of other managed tickets", async (t) => {
	const f = await fixture(t);
	f.issues.push(remote(2));
	const peer = f.store.addResource(f.mission.id, { url: url(2), linearRole: "managed" });
	f.store.addResource(f.mission.id, { url: url(2), taskId: "1", linearRole: "contribution" });
	f.state("active");
	f.set("1", "in_progress");
	await f.poll();
	assert.equal(f.status().state, "synced");
	assert.equal(f.store.linearSyncRecord(peer.id)!.status.state, "synced");
	assert.deepEqual(f.writes, [{ id: f.issues[1]!.id, state: "active" }]);
});

test("exhausted write retries retain the actual failure and still reconcile without replay", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const f = await fixture(t);
	f.set("1", "in_progress");
	let rejected = 0;
	f.setHook((tool) => {
		if (tool === "startIssue") {
			rejected++;
			throw new SourceToolError("private detail", "access_denied");
		}
	});
	for (let n = 0; n < 6; n++) {
		await f.poll();
		now += 600_000;
	}
	assert.equal(rejected, 5);
	assert.deepEqual(f.status().failure, { stage: "write", category: "access_denied" });
	f.state("active");
	await f.poll();
	assert.equal(f.status().state, "synced");
	assert.equal(f.status().failure, undefined);
	assert.equal(f.status().retryAt, undefined);
	assert.equal(f.store.linearSyncRecord(f.manager.id)!.attempts, 0);
	assert.equal(rejected, 5);
});

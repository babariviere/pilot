import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionPullRequest } from "@pilot/protocol";
import { MissionStore, parseResourceUrl } from "./missions.ts";

test("hot membership reads reflect role and lifecycle changes without full summaries", (t) => {
	const missions = new MissionStore(":memory:");
	t.after(() => missions.close());
	const { id } = missions.create({ projectId: "p", title: "M" });
	assert.equal(missions.membership("chat"), undefined);
	missions.join("chat", id);
	const get = t.mock.method(missions, "get");
	assert.deepEqual(missions.membership("chat"), { missionId: id, active: true, coordinator: false });
	assert.equal(get.mock.callCount(), 0);
	missions.update(id, { coordinatorSessionId: "chat" });
	assert.deepEqual(missions.membership("chat"), { missionId: id, active: true, coordinator: true });
	missions.update(id, { status: "done" });
	assert.deepEqual(missions.membership("chat"), { missionId: id, active: false, coordinator: true });
	missions.update(id, { status: "active" });
	assert.deepEqual(missions.membership("chat"), { missionId: id, active: true, coordinator: true });
	missions.leave("chat");
	assert.equal(missions.membership("chat"), undefined);
	const other = missions.create({ projectId: "p", title: "Other" });
	missions.join("chat", other.id);
	assert.deepEqual(missions.membership("chat"), { missionId: other.id, active: true, coordinator: false });
});

test("legacy decisions migrate to reference; audiences and task pins persist and validate", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-decision-migration-"));
	const file = join(dir, "missions.sqlite");
	let missions = new MissionStore(file);
	try {
		const { id } = missions.create({ projectId: "p", title: "Shared", tasks: [{ title: "Implement" }] });
		const decision = missions.addDecision(id, "Legacy");
		assert.equal(decision.audience, "reference");
		missions.close();
		const legacy = new DatabaseSync(file);
		legacy.exec("ALTER TABLE decisions DROP COLUMN audience; ALTER TABLE tasks DROP COLUMN decision_ids;");
		legacy.close();
		missions = new MissionStore(file);
		assert.equal(missions.detail(id).decisions[0]!.audience, "reference");
		assert.equal(missions.updateDecision(id, decision.id, undefined, {}, "coordinator").text, "Legacy");
		missions.updateTask(id, "1", { decisionIds: [decision.id, decision.id] });
		assert.deepEqual(missions.resolveTask(id, "1").decisionIds, [decision.id]);
		assert.throws(() => missions.addDecision(id, "Bad", {}, "invalid"), /audience must be/);
		assert.throws(
			() => missions.updateDecision(id, decision.id, "Agent", { sessionId: "chat" }, "all"),
			/Only the user/,
		);
		assert.throws(() => missions.updateTask(id, "1", { decisionIds: ["unknown"] }), /Unknown decision/);
		missions.close();
		missions = new MissionStore(file);
		assert.equal(missions.detail(id).decisions[0]!.audience, "coordinator");
		assert.deepEqual(missions.resolveTask(id, "1").decisionIds, [decision.id]);
		missions.removeDecision(id, decision.id);
		assert.deepEqual(missions.resolveTask(id, "1").decisionIds, []);
	} finally {
		missions.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("automatic PR attribution persists observations and deletions across database reopen", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-pr-attribution-"));
	const file = join(dir, "missions.sqlite");
	let missions = new MissionStore(file);
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
		missions.join("chat", id);
		missions.claimTask(id, "1", "chat");
		const first = "https://github.com/octo/repo/pull/1";
		const second = "https://github.com/octo/repo/pull/2";
		const ambiguous = "https://github.com/octo/repo/pull/3";
		missions.linkAutomaticPullRequests("chat", [first]);
		const automatic = missions.detail(id).resources[0]!;
		assert.equal(automatic.taskId, missions.resolveTask(id, "1").id);
		missions.removeResource(id, automatic.id);
		// Explicit links removed before automatic observation must also stay deleted.
		const explicit = missions.addResource(id, { url: second, taskId: "1" });
		missions.removeResource(id, explicit.id);
		missions.claimTask(id, "2", "chat");
		missions.linkAutomaticPullRequests("chat", [ambiguous]);
		missions.releaseTask(id, "1");
		missions.close();
		missions = new MissionStore(file);
		const tasks = t.mock.method(missions, "tasks", () =>
			assert.fail("automatic attribution must not read task bodies"),
		);
		missions.linkAutomaticPullRequests("chat", [first.replace("octo/repo", "OCTO/REPO"), second, ambiguous]);
		tasks.mock.restore();
		assert.equal(missions.detail(id).resources.length, 0, "replay never assigns old PRs to the remaining task");
		// Explicit attribution remains possible after a deliberately skipped automatic observation.
		missions.addResource(id, { url: ambiguous, taskId: "2" }, { sessionId: "chat" });
		missions.linkAutomaticPullRequests("chat", [ambiguous]);
		assert.equal(missions.detail(id).resources.length, 1);
	} finally {
		missions.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("task links are scoped, validated and preserved when a task is deleted", () => {
	const missions = new MissionStore(":memory:");
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
		const url = "https://github.com/octo/repo/pull/1";
		const task = missions.resolveTask(id, "#1");
		const linked = missions.addResource(id, { url, taskId: "#1" });
		assert.equal(linked.taskId, task.id);
		assert.equal(missions.addResource(id, { url: `${url}/files?x=1#fragment`, taskId: task.id }).id, linked.id);
		assert.equal(missions.addResource(id, { url, taskId: task.id }).id, linked.id);
		assert.notEqual(missions.addResource(id, { url, taskId: "2" }).id, linked.id);
		assert.notEqual(missions.addResource(id, { url }).id, linked.id);
		assert.throws(() => missions.addResource(id, { url, taskId: "unknown" }), /Unknown task/);
		missions.removeTask(id, task.id);
		assert.equal(missions.detail(id).resources.find((item) => item.id === linked.id)?.taskId, undefined);
		missions.removeResource(id, linked.id);
		assert.equal(missions.detail(id).resources.length, 2);
	} finally {
		missions.close();
	}
});

test("resource migration preserves existing task PR ownership and reference roles across restart", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-resource-migration-"));
	const file = join(dir, "missions.sqlite");
	let missions = new MissionStore(file);
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }] });
		const url = pr(1, "open").url;
		const owned = missions.addResource(id, { url, taskId: "1" });
		const global = missions.addResource(id, { url });
		const reference = missions.addResource(id, { url: "https://example.com/spec", taskId: "1" });
		missions.close();
		const db = new DatabaseSync(file);
		db.exec("ALTER TABLE resources DROP COLUMN relationship");
		db.close();
		missions = new MissionStore(file);
		assert.equal(missions.detail(id).resources.find((r) => r.id === owned.id)?.relationship, "ownership");
		for (const link of [global, reference])
			assert.equal(missions.detail(id).resources.find((r) => r.id === link.id)?.relationship, "reference");
		const related = missions.addResource(id, { url, taskId: "1", relationship: "reference" });
		missions.close();
		missions = new MissionStore(file);
		assert.equal(missions.detail(id).resources.find((r) => r.id === related.id)?.relationship, "reference");
		missions.updatePullRequest(pr(1, "open"));
		assert.equal(missions.resolveTask(id, "1").status, "in_review");
	} finally {
		missions.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reference PRs neither drive nor block task completion and survive ownership handoffs", () => {
	const missions = new MissionStore(":memory:");
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
		missions.join("old", id);
		missions.join("new", id);
		const a = missions.claimTask(id, "1", "old");
		const b = missions.claimTask(id, "2", "new");
		const url = pr(1, "open").url;
		const reference = missions.addResource(id, { url, taskId: a.id, relationship: "reference" });
		missions.updatePullRequest(pr(1, "open"));
		assert.equal(missions.task(id, a.id).status, "in_progress");
		const operation = {
			id: "bind",
			sessionId: "old",
			missionId: id,
			taskId: a.id,
			url,
			bound: true,
			previousSessionIds: [],
			actor: {},
		};
		assert.deepEqual(missions.applyPullRequestBinding(operation), { changed: true, taskLinkRemoved: false });
		assert.equal(missions.task(id, a.id).status, "in_review");
		assert.deepEqual(
			missions.applyPullRequestBinding({
				...operation,
				id: "move",
				sessionId: "new",
				taskId: b.id,
				previousSessionIds: ["old"],
			}),
			{ changed: true, taskLinkRemoved: true },
		);
		assert.equal(missions.task(id, a.id).status, "in_progress");
		assert.ok(missions.detail(id).resources.some((r) => r.id === reference.id));
		assert.deepEqual(
			missions.applyPullRequestBinding({ ...operation, id: "detach", sessionId: "new", bound: false }),
			{ changed: true, taskLinkRemoved: true },
		);
		missions.updatePullRequest(pr(1, "merged"));
		assert.equal(missions.task(id, a.id).status, "in_progress");
		missions.addResource(id, { url: pr(2, "open").url, taskId: a.id });
		missions.addResource(id, { url: pr(3, "open").url, taskId: a.id, relationship: "reference" });
		missions.updatePullRequest(pr(2, "merged"));
		assert.equal(missions.task(id, a.id).status, "done", "unknown reference PR does not block completion");
		assert.throws(() => missions.addResource(id, { url, relationship: "ownership" }), /require a task/);
		assert.throws(
			() => missions.addResource(id, { url: "https://example.com", taskId: a.id, relationship: "ownership" }),
			/GitHub PR/,
		);
		assert.throws(
			() => missions.addResource(id, { url, taskId: a.id, relationship: "invalid" as never }),
			/Invalid link relationship/,
		);
		missions.attachTaskReferences(id, b.id, [], [{ url: pr(4, "open").url }]);
		missions.updatePullRequest(pr(4, "merged"));
		assert.equal(missions.task(id, b.id).status, "in_progress", "Start chat PR references never own the task");
	} finally {
		missions.close();
	}
});

test("bulk milestones publish one committed update, deduplicate aliases and skip no-op writes", () => {
	const missions = new MissionStore(":memory:");
	try {
		const { id } = missions.create({
			projectId: "p",
			title: "M",
			tasks: Array.from({ length: 1000 }, (_, i) => ({ title: `Task ${i}` })),
		});
		missions.join("agent", id);
		missions.claimTask(id, "1", "agent");
		missions.claimTask(id, "2", "agent");
		const refs = missions.tasks(id).map((task) => task.id);
		const eventId = missions.events(id)[0]!.id;
		let changes = 0;
		let members = 0;
		missions.onChange(() => {
			changes++;
			assert.ok(
				missions.tasks(id).every((task) => task.milestone === "Next"),
				"observers see the complete batch",
			);
		});
		missions.onMembershipChange(() => members++);
		const grouped = missions.groupTasks(id, [...refs, "#1"], "Next", { sessionId: "agent" });
		assert.equal(grouped.length, 1000);
		assert.equal(changes, 1);
		assert.equal(members, 1, "one refresh per affected owner");
		assert.equal(missions.events(id)[0]!.id, eventId + 1);
		assert.deepEqual(missions.groupTasks(id, refs, "Next"), grouped);
		assert.equal(changes, 1);
		assert.equal(missions.events(id)[0]!.id, eventId + 1);
		assert.throws(() => missions.groupTasks(id, [refs[0]!, "missing"], "Bad"), /Unknown task/);
		assert.deepEqual(missions.tasks(id), grouped);
		assert.equal(changes, 1);
	} finally {
		missions.close();
	}
});

test("task ordering, regrouping and deletion survive restart", () => {
	const home = mkdtempSync(join(tmpdir(), "pilot-task-management-"));
	const path = join(home, "missions.sqlite");
	let missions = new MissionStore(path);
	try {
		const { id } = missions.create({
			projectId: "p",
			title: "M",
			tasks: [{ title: "A" }, { title: "B" }, { title: "C" }],
		});
		missions.updateTask(id, "2", { order: 0.5, dependsOn: ["1"] });
		missions.groupTasks(id, ["1", "2"], "Next");
		missions.removeTask(id, "3");
		const tasks = missions.tasks(id);
		missions.close();
		missions = new MissionStore(path);
		assert.deepEqual(missions.tasks(id), tasks);
		assert.deepEqual(
			tasks.map((task) => task.number),
			[2, 1],
		);
		assert.ok(tasks.every((task) => task.milestone === "Next"));
	} finally {
		missions.close();
		rmSync(home, { recursive: true, force: true });
	}
});

function store() {
	return new MissionStore(":memory:");
}

test("artifact references preserve mission and multiple task scopes across restart and scoped unlink", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-artifact-scope-"));
	const file = join(dir, "missions.sqlite");
	let missions = new MissionStore(file);
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
		missions.join("author", id);
		const link = { sessionId: "author", artifactId: "a", title: "Design", kind: "html" as const };
		missions.linkArtifact(id, link);
		missions.linkArtifact(id, { ...link, taskId: "1", revision: 1 });
		missions.linkArtifact(id, { ...link, taskId: "2", revision: 2 });
		missions.linkArtifact(id, { ...link, taskId: "1", revision: 3 });
		assert.equal(missions.detail(id).artifacts.length, 3);
		const firstTask = missions.resolveTask(id, "1").id;
		assert.equal(missions.detail(id).artifacts.find((item) => item.taskId === firstTask)?.revision, 3);
		assert.throws(() => missions.linkArtifact(id, { ...link, taskId: "missing" }), /Unknown task/);
		missions.close();
		missions = new MissionStore(file);
		assert.equal(missions.detail(id).artifacts.length, 3);
		missions.unlinkArtifact(id, "a", {}, "1");
		assert.equal(missions.detail(id).artifacts.length, 2);
		missions.unlinkArtifact(id, "a");
		assert.equal(missions.detail(id).artifacts.length, 1);
		missions.removeTask(id, missions.resolveTask(id, "2").id);
		assert.equal(
			missions.detail(id).artifacts.length,
			1,
			"deleting a task preserves its references at mission level",
		);
		assert.equal(missions.detail(id).artifacts[0]?.taskId, undefined);
		assert.equal(missions.detail(id).artifacts[0]?.revision, 2);
		missions.linkArtifact(id, { ...link, taskId: "1", revision: 4 });
		missions.removeTask(id, firstTask);
		assert.equal(
			missions.detail(id).artifacts.length,
			1,
			"promotion deduplicates without overwriting an existing pin",
		);
		assert.equal(missions.detail(id).artifacts[0]?.revision, 2);
	} finally {
		missions.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy artifact links migrate without losing metadata or pinning", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-artifact-migration-"));
	const file = join(dir, "missions.sqlite");
	let missions = new MissionStore(file);
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }] });
		missions.join("author", id);
		const before = missions.linkArtifact(id, {
			sessionId: "author",
			artifactId: "a",
			title: "Design",
			kind: "html",
			revision: 2,
		});
		missions.close();
		const db = new DatabaseSync(file);
		db.exec(`ALTER TABLE artifact_links RENAME TO artifact_links_new;
			CREATE TABLE artifact_links (
				mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
				artifact_id TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL,
				kind TEXT NOT NULL, revision INTEGER, linked_by_session_id TEXT, linked_at INTEGER NOT NULL,
				PRIMARY KEY (mission_id, artifact_id));
			INSERT INTO artifact_links SELECT mission_id, artifact_id, session_id, title, kind, revision, linked_by_session_id, linked_at FROM artifact_links_new;
			DROP TABLE artifact_links_new;`);
		db.close();
		missions = new MissionStore(file);
		assert.deepEqual(missions.detail(id).artifacts, [before]);
		missions.linkArtifact(id, { ...before, taskId: "1" });
		assert.equal(missions.detail(id).artifacts.length, 2);
	} finally {
		missions.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reference batches commit atomically and broadcast once with a large task list", () => {
	const missions = store();
	try {
		const { id } = missions.create({
			projectId: "p",
			title: "M",
			tasks: Array.from({ length: 1000 }, (_, i) => ({ title: `Task ${i}` })),
		});
		const task = missions.resolveTask(id, "1");
		missions.join("author", id);
		let updates = 0;
		missions.onChange(() => updates++);
		const links = Array.from({ length: 40 }, (_, i) => ({ url: `https://example.com/${i}` }));
		missions.attachTaskReferences(id, task.id, [], links);
		assert.equal(updates, 1);
		assert.equal(missions.detail(id).resources.length, 40);
		const before = missions.detail(id);
		assert.throws(
			() =>
				missions.attachTaskReferences(
					id,
					task.id,
					[{ artifactId: "a", sessionId: "author", title: "Design", kind: "html" }],
					[{ url: "bad" }],
				),
			/absolute http/,
		);
		assert.deepEqual(missions.detail(id), before);
		assert.equal(updates, 1, "failed batches never broadcast partial state");
		missions.addResource(id, { url: "https://example.com/after" });
		assert.equal(updates, 2, "transaction state is reset after errors");
	} finally {
		missions.close();
	}
});

test("summary attention counts track task and comment changes without loading detail", () => {
	const missions = store();
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
		const other = missions.create({ projectId: "other", title: "Other" });
		missions.addTask(other.id, { title: "Other blocked", status: "blocked" });
		missions.addComment(other.id, { text: "Other comment" }, { sessionId: "other-agent" });
		missions.join("agent", id);
		const counts = () => {
			const summary = missions.require(id);
			assert.deepEqual(missions.list("p"), [summary]);
			assert.equal(missions.list().find((item) => item.id === id)?.needsYouCount, summary.needsYouCount);
			return summary.needsYouCount;
		};
		// A summary must not fetch full task/comment bodies, brief, resources or activity.
		missions.detail = () => {
			throw new Error("unexpected detail read");
		};
		assert.equal(counts(), 0);
		assert.deepEqual([missions.require(id).tasksDone, missions.require(id).tasksTotal], [0, 2]);
		assert.equal(missions.require(id).needsYouReason, undefined);
		const task = missions.resolveTask(id, "1");
		missions.updateTask(id, task.id, { status: "blocked" });
		assert.equal(counts(), 1);
		assert.equal(missions.require(id).needsYouReason, "Blocked: A");
		assert.deepEqual([missions.require(id).tasksDone, missions.require(id).tasksTotal], [0, 2]);
		missions.addComment(id, { text: "User's own comment" });
		missions.addComment(id, { text: "Addressed", targetSessionId: "agent" }, { sessionId: "agent" });
		assert.equal(counts(), 1);
		const comment = missions.addComment(id, { text: "Unaddressed" }, { sessionId: "agent" });
		assert.equal(counts(), 2);
		missions.update(id, { coordinatorSessionId: "agent" });
		assert.equal(counts(), 1);
		missions.update(id, { coordinatorSessionId: null });
		assert.equal(counts(), 2);
		missions.resolveComment(id, comment.id);
		assert.equal(counts(), 1);
		const deleted = missions.addComment(id, { text: "Delete me" }, { sessionId: "agent" });
		assert.equal(counts(), 2);
		missions.removeComment(id, deleted.id);
		assert.equal(counts(), 1);
		for (const status of ["todo", "in_progress", "in_review", "done", "dropped"] as const) {
			missions.updateTask(id, task.id, { status });
			assert.equal(counts(), 0);
			const summary = missions.require(id);
			assert.deepEqual(
				[summary.tasksDone, summary.tasksTotal],
				[status === "done" ? 1 : 0, status === "dropped" ? 1 : 2],
				`progress with task ${status}`,
			);
		}
		missions.updateTask(id, task.id, { status: "blocked" });
		missions.removeTask(id, task.id);
		assert.equal(counts(), 0);
		assert.equal(missions.require(other.id).needsYouCount, 2);
	} finally {
		missions.close();
	}
});

test("summary attention counts survive restart and ignore resolved-comment detail limits", () => {
	const home = mkdtempSync(join(tmpdir(), "pilot-attention-"));
	const path = join(home, "missions.sqlite");
	let missions = new MissionStore(path);
	try {
		const { id } = missions.create({ projectId: "p", title: "M" });
		missions.addTask(id, { title: "Blocked", status: "blocked" });
		for (let i = 0; i < 25; i++) {
			const comment = missions.addComment(id, { text: "Resolved" }, { sessionId: "agent" });
			missions.resolveComment(id, comment.id);
		}
		missions.addComment(id, { text: "Open" }, { sessionId: "agent" });
		missions.close();
		missions = new MissionStore(path);
		assert.equal(missions.list()[0]?.needsYouCount, 2);
		assert.equal(missions.detail(id).mission.needsYouCount, 2);
		assert.equal(missions.list()[0]?.needsYouReason, "Blocked: Blocked");
	} finally {
		missions.close();
		rmSync(home, { recursive: true, force: true });
	}
});

const pr = (number: number, state: SessionPullRequest["state"]): SessionPullRequest => ({
	number,
	state,
	url: `https://github.com/octo/repo/pull/${number}`,
	title: "PR",
	checkedAt: Date.now(),
});

test("explicit PR binding validates mission tasks and rejects ambiguous implicit targets without writes", () => {
	const missions = store();
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
		const other = missions.create({ projectId: "p", title: "Other", tasks: [{ title: "Other" }] });
		const url = pr(1, "open").url;
		assert.equal(missions.validatePullRequestBinding("outside", url), undefined);
		assert.throws(() => missions.validatePullRequestBinding("outside", url, "1"), /mission chat/);
		assert.throws(() => missions.validatePullRequestBinding("outside", "https://example.com"), /GitHub/);
		missions.join("chat", id);
		assert.deepEqual(missions.validatePullRequestBinding("chat", url), { missionId: id });
		const a = missions.claimTask(id, "1", "chat");
		assert.deepEqual(missions.validatePullRequestBinding("chat", `${url}/files`), { missionId: id, taskId: a.id });
		missions.claimTask(id, "2", "chat");
		const before = missions.detail(id);
		assert.throws(() => missions.validatePullRequestBinding("chat", url), /[Aa]mbiguous/);
		assert.deepEqual(missions.validatePullRequestBinding("chat", url, "#2"), {
			missionId: id,
			taskId: missions.resolveTask(id, "2").id,
		});
		assert.throws(
			() => missions.validatePullRequestBinding("chat", url, missions.resolveTask(other.id, "1").id),
			/Unknown task/,
		);
		assert.deepEqual(missions.detail(id), before);
		missions.updateTask(id, a.id, { status: "done" });
		assert.throws(() => missions.validatePullRequestBinding("chat", url, a.id), /already done/);
		missions.updateTask(id, missions.resolveTask(id, "2").id, { status: "dropped" });
		assert.deepEqual(missions.validatePullRequestBinding("chat", url), { missionId: id });
	} finally {
		missions.close();
	}
});

test("explicit PR handoff moves links across missions, carries cached state and publishes only committed sides", () => {
	const missions = store();
	try {
		const source = missions.create({ projectId: "p", title: "Source", tasks: [{ title: "A" }] });
		const target = missions.create({ projectId: "p", title: "Target", tasks: [{ title: "B" }] });
		missions.join("old", source.id);
		missions.join("new", target.id);
		const a = missions.claimTask(source.id, "1", "old");
		const b = missions.claimTask(target.id, "1", "new");
		const url = pr(1, "open").url;
		missions.addResource(source.id, { url, taskId: a.id });
		missions.updatePullRequest(pr(1, "open"));
		const updates: string[] = [];
		missions.onChange((id) => {
			updates.push(id);
			assert.equal(missions.detail(source.id).resources.length, 0);
			assert.equal(missions.detail(target.id).resources[0]?.taskId, b.id);
			assert.equal(missions.task(source.id, a.id).status, "in_progress");
			assert.equal(missions.task(target.id, b.id).status, "in_review");
		});
		const operation = {
			id: "move",
			sessionId: "new",
			missionId: target.id,
			taskId: b.id,
			url: `${url}/files`,
			bound: true,
			previousSessionIds: ["old", "old"],
			actor: { sessionId: "coordinator" },
		};
		missions.applyPullRequestBinding(operation);
		assert.deepEqual(new Set(updates), new Set([source.id, target.id]));
		assert.equal(updates.length, 2);
		assert.equal(missions.detail(target.id).resources[0]?.pullRequest?.state, "open");
		for (const [id, task, action] of [
			[source.id, a, "unbound"],
			[target.id, b, "bound"],
		] as const) {
			const chat = action === "bound" ? "to chat new" : "from chat old";
			const event = missions.events(id).find((event) => event.text === `Pull request ${action} ${chat}: ${url}`);
			assert.equal(event?.sessionId, "coordinator");
			assert.equal(event?.taskId, task.id);
		}
		const before = [missions.detail(source.id), missions.detail(target.id)];
		missions.applyPullRequestBinding(operation);
		assert.deepEqual([missions.detail(source.id), missions.detail(target.id)], before);
		assert.equal(updates.length, 2);
	} finally {
		missions.close();
	}
});

test("same-mission binding replaces unfinished links but preserves done tasks and mission-level references", () => {
	const missions = store();
	try {
		const { id } = missions.create({
			projectId: "p",
			title: "M",
			tasks: [{ title: "Claimed" }, { title: "Unclaimed" }, { title: "Done" }, { title: "Target" }],
		});
		missions.join("old", id);
		missions.join("new", id);
		const a = missions.claimTask(id, "1", "old");
		const b = missions.resolveTask(id, "2");
		const done = missions.updateTask(id, missions.resolveTask(id, "3").id, { status: "done" });
		const target = missions.resolveTask(id, "4");
		const url = pr(1, "open").url;
		for (const task of [a, b, done]) missions.addResource(id, { url, taskId: task.id });
		const missionLink = missions.addResource(id, { url });
		missions.updatePullRequest(pr(1, "open"));
		const doneLink = missions.detail(id).resources.find((link) => link.taskId === done.id);
		const unrelated = missions.create({ projectId: "p", title: "Unrelated", tasks: [{ title: "U" }] });
		missions.addResource(unrelated.id, { url, taskId: "1" });
		const unrelatedBefore = missions.detail(unrelated.id);
		missions.applyPullRequestBinding({
			id: "same-mission",
			sessionId: "new",
			url,
			bound: true,
			taskId: target.id,
			previousSessionIds: ["old"],
			actor: {},
		});
		assert.equal(missions.task(id, a.id).status, "in_progress");
		assert.equal(missions.task(id, b.id).status, "todo");
		assert.equal(missions.task(id, target.id).status, "in_review");
		assert.deepEqual(missions.task(id, done.id), done);
		assert.deepEqual(
			missions.detail(id).resources.find((link) => link.id === doneLink?.id),
			doneLink,
		);
		assert.ok(missions.detail(id).resources.some((link) => link.id === missionLink.id));
		assert.deepEqual(missions.detail(unrelated.id), unrelatedBefore);
		missions.updatePullRequest(pr(1, "merged"));
		assert.equal(missions.task(id, target.id).status, "done", "handoffs do not disable future PR sync");
		assert.deepEqual(missions.task(id, done.id), done);
		const completed = missions.task(id, target.id);
		const links = missions.detail(id).resources;
		missions.applyPullRequestBinding({
			id: "unbind-done",
			sessionId: "new",
			url,
			bound: false,
			previousSessionIds: [],
			actor: {},
		});
		assert.deepEqual(missions.task(id, target.id), completed);
		assert.deepEqual(missions.detail(id).resources, links, "unbinding never removes completed task links");
	} finally {
		missions.close();
	}
});

test("explicit unbinding recomputes remaining PRs and bypasses ambiguity and manual PR sync opt-outs", () => {
	for (const [states, expected] of [
		[["open", "merged"], "in_review"],
		[["merged", "closed"], "done"],
		[["merged", undefined], "in_review"],
		[["closed"], "in_progress"],
		[[], "in_progress"],
	] as const) {
		const missions = store();
		try {
			const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
			missions.join("chat", id);
			const task = missions.claimTask(id, "1", "chat");
			missions.claimTask(id, "2", "chat");
			const url = pr(1, "open").url;
			missions.addResource(id, { url, taskId: task.id });
			missions.updatePullRequest(pr(1, "open"));
			// Disable polling transitions; explicit operations must still reconcile.
			missions.updateTask(id, task.id, { status: "in_progress" });
			for (const [i, state] of states.entries()) {
				missions.addResource(id, { url: pr(i + 2, "open").url, taskId: task.id });
				if (state) missions.updatePullRequest(pr(i + 2, state));
			}
			missions.updateTask(id, task.id, { status: "in_review" });
			missions.applyPullRequestBinding({
				id: "unbind",
				sessionId: "chat",
				url,
				bound: false,
				previousSessionIds: [],
				actor: {},
			});
			assert.equal(missions.task(id, task.id).status, expected, JSON.stringify(states));
			assert.equal(missions.detail(id).resources.length, states.length);
			const before = missions.task(id, task.id);
			missions.updatePullRequest(pr(2, "merged"));
			assert.deepEqual(missions.task(id, task.id), before, "existing opt-outs remain in effect after a handoff");
		} finally {
			missions.close();
		}
	}
});

test("unbinding an unclaimed explicit task with only closed PRs left returns it to todo", () => {
	const missions = store();
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }] });
		missions.join("chat", id);
		const task = missions.resolveTask(id, "1");
		for (const number of [1, 2]) missions.addResource(id, { url: pr(number, "open").url, taskId: task.id });
		missions.updatePullRequest(pr(1, "open"));
		missions.updatePullRequest(pr(2, "closed"));
		const operation = {
			id: "bind-unclaimed",
			sessionId: "chat",
			missionId: id,
			taskId: task.id,
			url: pr(1, "open").url,
			bound: true,
			previousSessionIds: [],
			actor: {},
		};
		missions.applyPullRequestBinding(operation);
		missions.applyPullRequestBinding({ ...operation, id: "unbind-unclaimed", bound: false });
		assert.equal(missions.task(id, task.id).status, "todo");
		assert.equal(missions.detail(id).resources.length, 1);
	} finally {
		missions.close();
	}
});

test("binding rollback includes both sides' links, activity and durable replay marker", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-pr-binding-"));
	const file = join(dir, "missions.sqlite");
	let missions = new MissionStore(file);
	try {
		const source = missions.create({ projectId: "p", title: "Source", tasks: [{ title: "A" }] });
		const target = missions.create({ projectId: "p", title: "Target", tasks: [{ title: "B" }] });
		missions.join("old", source.id);
		missions.join("new", target.id);
		const task = missions.claimTask(source.id, "1", "old");
		const targetTask = missions.claimTask(target.id, "1", "new");
		const url = pr(1, "open").url;
		missions.addResource(source.id, { url, taskId: task.id });
		missions.updatePullRequest(pr(1, "open"));
		const operation = {
			id: "durable",
			sessionId: "new",
			missionId: target.id,
			taskId: targetTask.id,
			url,
			bound: true,
			previousSessionIds: ["old"],
			actor: {},
		};
		const before = [missions.detail(source.id), missions.detail(target.id)];
		const db = new DatabaseSync(file);
		try {
			db.exec(`CREATE TRIGGER fail_binding BEFORE INSERT ON events
				WHEN NEW.text LIKE 'Pull request bound to%' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
			let notifications = 0;
			const unsubscribe = missions.onChange(() => notifications++);
			assert.throws(() => missions.applyPullRequestBinding(operation), /injected failure/);
			assert.deepEqual([missions.detail(source.id), missions.detail(target.id)], before);
			assert.equal(notifications, 0);
			assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pull_request_binding_operations").get()?.n, 0);
			db.exec("DROP TRIGGER fail_binding");
			missions.applyPullRequestBinding(operation);
			assert.equal(notifications, 2);
			unsubscribe();
		} finally {
			db.close();
		}
		const applied = [missions.detail(source.id), missions.detail(target.id)];
		missions.close();
		missions = new MissionStore(file);
		missions.applyPullRequestBinding(operation);
		assert.deepEqual([missions.detail(source.id), missions.detail(target.id)], applied);
		// Replay is a no-op even when implicit resolution would now be ambiguous.
		missions.claimTask(target.id, missions.addTask(target.id, { title: "Extra" }).id, "new");
		assert.doesNotThrow(() => missions.applyPullRequestBinding(operation));
	} finally {
		missions.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("different operation IDs do not duplicate binding activity, including taskless chats and same-mission losers", () => {
	const missions = store();
	try {
		const { id } = missions.create({ projectId: "p", title: "M" });
		for (const chat of ["target", "previous-a", "previous-b"]) missions.join(chat, id);
		const operation = {
			id: "first",
			sessionId: "target",
			missionId: id,
			url: pr(1, "open").url,
			bound: true,
			previousSessionIds: ["previous-a", "previous-b", "previous-a"],
			actor: { sessionId: "actor" },
		};
		missions.applyPullRequestBinding(operation);
		const bindingEvents = missions.events(id).filter((event) => event.text.startsWith("Pull request "));
		assert.equal(bindingEvents.length, 3);
		for (const chat of ["target", "previous-a", "previous-b"])
			assert.ok(bindingEvents.some((event) => event.text.includes(`chat ${chat}:`) && event.sessionId === "actor"));
		assert.equal(missions.detail(id).resources.length, 0);
		const before = missions.detail(id);
		missions.applyPullRequestBinding({ ...operation, id: "repeat" });
		assert.deepEqual(missions.detail(id), before);
		missions.applyPullRequestBinding({ ...operation, id: "unbind", bound: false, previousSessionIds: [] });
		const unbound = missions.detail(id);
		assert.equal(unbound.events.length, before.events.length + 1);
		missions.applyPullRequestBinding({ ...operation, id: "unbind-again", bound: false, previousSessionIds: [] });
		assert.deepEqual(missions.detail(id), unbound);
		missions.applyPullRequestBinding({ ...operation, id: "rebind", previousSessionIds: [] });
		assert.equal(missions.events(id).length, unbound.events.length + 1);
	} finally {
		missions.close();
	}
});

test("unbinding an old chat after a same-mission handoff leaves the new owner's task link intact", () => {
	const missions = store();
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
		missions.join("old", id);
		missions.join("new", id);
		const a = missions.claimTask(id, "1", "old");
		const b = missions.claimTask(id, "2", "new");
		const url = pr(1, "open").url;
		missions.addResource(id, { url, taskId: a.id }, { sessionId: "old" });
		missions.updatePullRequest(pr(1, "open"));
		const operation = {
			id: "handoff",
			sessionId: "new",
			missionId: id,
			taskId: b.id,
			url,
			bound: true,
			previousSessionIds: ["old"],
			actor: {},
		};
		missions.applyPullRequestBinding(operation);
		const before = missions.detail(id);
		missions.applyPullRequestBinding({
			...operation,
			id: "old-unbind",
			sessionId: "old",
			bound: false,
			previousSessionIds: [],
		});
		assert.deepEqual(missions.detail(id), before);
		// Explicit binding can target another chat's claimed task. The new binding still owns its link.
		missions.applyPullRequestBinding({ ...operation, id: "old-claimed-task", taskId: a.id });
		const oldClaim = missions.detail(id);
		missions.applyPullRequestBinding({
			...operation,
			id: "old-unbind-claimed",
			sessionId: "old",
			bound: false,
			previousSessionIds: [],
		});
		assert.deepEqual(missions.detail(id), oldClaim);
		// The explicit owner can unlink the task even though it is claimed by someone else.
		missions.applyPullRequestBinding({ ...operation, id: "new-unbind", bound: false, previousSessionIds: [] });
		assert.equal(missions.detail(id).resources.length, 0);
		assert.equal(missions.task(id, a.id).status, "in_progress");
		const unbound = missions.detail(id);
		missions.applyPullRequestBinding({ ...operation, id: "new-unbind-repeat", bound: false, previousSessionIds: [] });
		assert.deepEqual(missions.detail(id), unbound);
	} finally {
		missions.close();
	}
});

test("journal application uses pinned task selection and tolerates tasks completed since validation", () => {
	const missions = store();
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
		missions.join("chat", id);
		const url = pr(1, "open").url;
		const validated = missions.validatePullRequestBinding("chat", url);
		const a = missions.claimTask(id, "1", "chat");
		missions.claimTask(id, "2", "chat");
		const operation = {
			id: "no-task",
			sessionId: "chat",
			url,
			bound: true,
			previousSessionIds: [],
			actor: {},
			...validated,
		};
		assert.doesNotThrow(() => missions.applyPullRequestBinding(operation));
		assert.equal(missions.detail(id).resources.length, 0, "new claims do not change a taskless validated binding");
		const selected = missions.validatePullRequestBinding("chat", url, a.id);
		missions.addResource(id, { url, taskId: a.id });
		const done = missions.updateTask(id, a.id, { status: "done" });
		const link = missions.detail(id).resources[0];
		assert.doesNotThrow(() => missions.applyPullRequestBinding({ ...operation, id: "now-done", ...selected }));
		assert.deepEqual(missions.task(id, a.id), done);
		assert.deepEqual(missions.detail(id).resources[0], link);
		const before = missions.detail(id);
		missions.applyPullRequestBinding({ ...operation, id: "same-done-new-id", ...selected });
		assert.deepEqual(missions.detail(id), before);
		// An unchanged metadata binding does not create a first activity event unless task links changed.
		const events = missions.events(id).length;
		missions.applyPullRequestBinding({
			...operation,
			id: "already-attached",
			url: pr(2, "open").url,
			changed: false,
		});
		assert.equal(missions.events(id).length, events);
	} finally {
		missions.close();
	}
});

test("task links cache stack changes and clear membership without duplicating activity", () => {
	const missions = store();
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }] });
		missions.addResource(id, { taskId: "1", url: pr(1, "open").url });
		const stack = { number: 9, position: 1, size: 2, baseBranch: "main" };
		missions.updatePullRequest({ ...pr(1, "open"), stack });
		assert.deepEqual(missions.detail(id).resources[0]?.pullRequest?.stack, stack);
		const count = missions.detail(id).events.length;
		const updated = { ...stack, position: 2, size: 3 };
		missions.updatePullRequest({ ...pr(1, "open"), stack: updated });
		assert.deepEqual(missions.detail(id).resources[0]?.pullRequest?.stack, updated);
		missions.updatePullRequest(pr(1, "open"));
		assert.equal(missions.detail(id).resources[0]?.pullRequest?.stack, undefined);
		assert.equal(missions.detail(id).events.length, count);
	} finally {
		missions.close();
	}
});

test("linked PRs enter review and finish only with a merge and no open or unknown links", () => {
	const missions = store();
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }] });
		const task = missions.resolveTask(id, "1");
		for (const number of [1, 2, 3]) missions.addResource(id, { taskId: task.id, url: pr(number, "open").url });
		missions.addResource(id, { taskId: task.id, url: "https://linear.app/a/issue/ENG-1" });
		missions.updatePullRequest(pr(1, "open"));
		assert.equal(missions.task(id, task.id).status, "in_review");
		const events = missions.detail(id).events.length;
		missions.updatePullRequest(pr(1, "open"));
		assert.equal(missions.detail(id).events.length, events, "repeated polling is idempotent");
		missions.updatePullRequest(pr(1, "merged"));
		assert.equal(missions.task(id, task.id).status, "in_review", "unknown links prevent done");
		missions.updatePullRequest(pr(2, "closed"));
		missions.updatePullRequest(pr(3, "draft"));
		assert.equal(missions.task(id, task.id).status, "in_review", "drafts count as open");
		missions.updatePullRequest(pr(3, "merged"));
		assert.equal(missions.task(id, task.id).status, "done");
		assert.ok(missions.task(id, task.id).completedAt);
		assert.ok(
			missions
				.detail(id)
				.events.some((event) => event.taskId === task.id && /after linked pull request merge/.test(event.text)),
		);
		missions.updatePullRequest(pr(3, "open"));
		assert.equal(missions.task(id, task.id).status, "done", "a new or reopened PR never reopens a closed task");
	} finally {
		missions.close();
	}
});

test("closed-unmerged and mission-level links do not finish tasks; removing the last open link does", () => {
	const missions = store();
	try {
		const { id } = missions.create({
			projectId: "p",
			title: "M",
			tasks: [{ title: "A" }, { title: "B" }],
		});
		missions.updateTask(id, missions.resolveTask(id, "2").id, { status: "dropped" });
		const task = missions.resolveTask(id, "1");
		missions.addResource(id, { url: pr(1, "merged").url });
		missions.updatePullRequest(pr(1, "merged"));
		assert.equal(missions.task(id, task.id).status, "todo");
		missions.addResource(id, { url: pr(2, "closed").url, taskId: task.id });
		missions.updatePullRequest(pr(2, "closed"));
		assert.equal(missions.task(id, task.id).status, "todo");
		const open = missions.addResource(id, { url: pr(3, "open").url, taskId: task.id });
		missions.updatePullRequest(pr(3, "open"));
		missions.addResource(id, { url: pr(1, "merged").url, taskId: task.id });
		assert.equal(missions.task(id, task.id).status, "in_review");
		missions.removeResource(id, open.id);
		assert.equal(missions.task(id, task.id).status, "done");
		missions.addResource(id, { url: pr(3, "open").url, taskId: "2" });
		missions.updatePullRequest(pr(3, "open"));
		assert.equal(missions.resolveTask(id, "2").status, "dropped");
	} finally {
		missions.close();
	}
});

test("manual backward moves survive restarts and ignore fresh open PRs and merges", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-task-pr-"));
	const file = join(dir, "missions.sqlite");
	let missions = new MissionStore(file);
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
		for (const number of [1, 2]) {
			missions.addResource(id, { taskId: String(number), url: pr(number, "open").url });
			missions.updatePullRequest(pr(number, "open"));
		}
		missions.updateTask(id, missions.resolveTask(id, "1").id, { status: "in_progress" });
		missions.updatePullRequest(pr(2, "merged"));
		missions.updateTask(id, missions.resolveTask(id, "2").id, { status: "in_review" });
		missions.close();
		missions = new MissionStore(file);
		missions.updatePullRequest(pr(1, "open"));
		missions.updatePullRequest(pr(1, "merged"));
		missions.updatePullRequest(pr(2, "merged"));
		missions.addResource(id, { taskId: "1", url: pr(3, "open").url });
		missions.updatePullRequest(pr(3, "open"));
		assert.equal(missions.resolveTask(id, "1").status, "in_progress");
		assert.equal(missions.resolveTask(id, "2").status, "in_review");
		assert.equal(
			missions.detail(id).resources.find((resource) => resource.url === pr(1, "merged").url)?.pullRequest?.state,
			"merged",
		);
	} finally {
		missions.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("older databases gain link and PR tracking columns without losing resources", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-task-migration-"));
	const file = join(dir, "missions.sqlite");
	let missions = new MissionStore(file);
	try {
		const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }] });
		missions.addResource(id, { url: pr(1, "open").url });
		missions.close();
		const legacy = new DatabaseSync(file);
		legacy.exec(
			"DROP INDEX IF EXISTS resources_by_linear_task; ALTER TABLE resources DROP COLUMN task_id; ALTER TABLE resources DROP COLUMN pull_request; ALTER TABLE tasks DROP COLUMN pr_sync_disabled; ALTER TABLE tasks DROP COLUMN delegated_to; ALTER TABLE tasks DROP COLUMN delegated_from_status; ALTER TABLE tasks DROP COLUMN delegated_resource_id; DROP TABLE linear_task_assignees;",
		);
		legacy.close();
		missions = new MissionStore(file);
		assert.equal(missions.detail(id).resources.length, 1);
		assert.equal(missions.detail(id).resources[0]!.taskId, undefined);
		missions.addResource(id, { taskId: "1", url: pr(1, "open").url });
		missions.updatePullRequest(pr(1, "merged"));
		assert.equal(missions.resolveTask(id, "1").status, "done");
		missions.updateTask(id, "1", { status: "todo" });
		const linear = missions.addResource(id, { taskId: "1", url: "https://linear.app/team/issue/ENG-1" });
		missions.observeLinearAssignee("p", linear.id, { id: "other", name: "Alex" }, "me");
		assert.equal(missions.resolveTask(id, "1").delegatedTo, "Alex");
	} finally {
		missions.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("creates missions with an initial brief, tasks and activity", () => {
	const missions = store();
	const changes: string[] = [];
	missions.onChange((id) => changes.push(id));
	const mission = missions.create({
		projectId: "p1",
		title: " API v2 ",
		goal: "Redesign",
		brief: "# Brief",
		tasks: [{ title: "Inventory" }, { title: "Auth", body: "Login" }],
	});
	assert.equal(mission.title, "API v2");
	assert.equal(mission.status, "active");
	assert.equal(mission.briefRevision, 1);
	const detail = missions.detail(mission.id);
	assert.equal(detail.brief?.markdown, "# Brief");
	assert.deepEqual(
		detail.tasks.map((task) => [task.number, task.title, task.status]),
		[
			[1, "Inventory", "todo"],
			[2, "Auth", "todo"],
		],
	);
	assert.deepEqual(detail.events.map((event) => event.kind).reverse(), ["created", "brief", "task", "task"]);
	assert.deepEqual(changes, [mission.id]);
	assert.deepEqual(
		missions.list("p1").map((m) => m.id),
		[mission.id],
	);
	assert.deepEqual(missions.list("other"), []);
});

test("brief writes are versioned and reject stale revisions", () => {
	const missions = store();
	const { id } = missions.create({ projectId: "p", title: "M", goal: "" });
	assert.equal(missions.brief(id), undefined);
	const first = missions.writeBrief(id, "one", 0);
	assert.equal(first.revision, 1);
	const second = missions.writeBrief(id, "two", 1, { sessionId: "s1" });
	assert.equal(second.revision, 2);
	assert.equal(second.authorSessionId, "s1");
	assert.throws(() => missions.writeBrief(id, "stale", 1), /revision conflict/);
	assert.equal(missions.writeBrief(id, "two", 2).revision, 2, "identical content does not create a revision");
	assert.equal(missions.brief(id, 1)?.markdown, "one");
	assert.deepEqual(
		missions.briefRevisions(id).map((r) => r.revision),
		[2, 1],
	);
});

test("membership, atomic claims and release on leave", () => {
	const missions = store();
	const sessions: string[] = [];
	missions.onMembershipChange((id) => sessions.push(id));
	const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
	const [a] = missions.tasks(id);
	assert.throws(() => missions.claimTask(id, a!.id, "s1"), /not in this mission/);
	missions.join("s1", id);
	missions.join("s2", id);
	assert.equal(missions.missionOf("s1"), id);
	const claimed = missions.claimTask(id, "#1", "s1");
	assert.equal(claimed.sessionId, "s1");
	assert.equal(claimed.status, "in_progress");
	assert.equal(missions.claimTask(id, 1, "s1").sessionId, "s1", "claiming again is idempotent");
	assert.throws(() => missions.claimTask(id, a!.id, "s2"), /already claimed/);
	missions.update(id, { coordinatorSessionId: "s1" });
	missions.leave("s1");
	assert.equal(missions.missionOf("s1"), undefined);
	const released = missions.task(id, a!.id);
	assert.equal(released.sessionId, undefined);
	assert.equal(released.status, "todo");
	assert.equal(missions.require(id).coordinatorSessionId, undefined);
	assert.ok(sessions.includes("s1") && sessions.includes("s2"));
});

test("batch claims keep other owners, report missing tasks, deduplicate aliases and notify once", (t) => {
	const missions = store();
	t.after(() => missions.close());
	const { id } = missions.create({
		projectId: "p",
		title: "M",
		tasks: [{ title: "A" }, { title: "B" }, { title: "C" }],
	});
	const foreign = missions.create({ projectId: "p", title: "Other", tasks: [{ title: "Foreign" }] });
	missions.join("s1", id);
	missions.join("s2", id);
	missions.claimTask(id, "2", "s2");
	missions.claimTask(id, "3", "s1");
	missions.updateTask(id, "3", { status: "blocked" });
	const before = missions.tasks(id);
	const events = missions.events(id).length;
	let changes = 0;
	missions.onChange(() => {
		changes++;
		assert.equal(missions.resolveTask(id, "1").sessionId, "s1");
	});
	const result = missions.claimTasks(
		id,
		["1", before[0]!.id, "2", "3", "#3", "99", missions.tasks(foreign.id)[0]!.id],
		"s1",
	);
	assert.deepEqual(
		result.claimed.map((task) => [task.number, task.status]),
		[
			[1, "in_progress"],
			[3, "blocked"],
		],
	);
	assert.deepEqual(
		result.skipped.map((item) => item.ref),
		["2", "99", missions.tasks(foreign.id)[0]!.id],
	);
	assert.match(result.skipped[0]!.reason, /already claimed by another chat/);
	assert.equal(result.skipped[0]!.task?.sessionId, "s2");
	assert.match(result.skipped[1]!.reason, /Unknown task/);
	assert.deepEqual(missions.resolveTask(id, "2"), before[1]);
	assert.equal(missions.events(id).length, events + 1, "only the new claim adds activity");
	assert.equal(changes, 1, "no intermediate batch contexts");
	const repeated = missions.claimTasks(id, ["1", "3"], "s1");
	assert.deepEqual(repeated.claimed, result.claimed);
	assert.equal(missions.events(id).length, events + 1);
	const skipped = missions.claimTasks(id, ["2"], "s1");
	assert.equal(skipped.claimed.length, 0);
	assert.equal(changes, 2, "all-skipped batches do not publish a context change");
	assert.throws(() => missions.claimTasks(id, ["1"], "outsider"), /not in this mission/);
});

test("unexpected failures roll back a batch instead of reporting a partial claim", (t) => {
	const missions = store();
	t.after(() => missions.close());
	const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
	missions.join("s1", id);
	const before = missions.tasks(id);
	const events = missions.events(id);
	let changes = 0;
	missions.onChange(() => changes++);
	const resolve = missions.resolveTask.bind(missions);
	t.mock.method(missions, "resolveTask", (id: string, ref: unknown) => {
		if (ref === "2") throw new Error("Storage failed");
		return resolve(id, ref);
	});
	assert.throws(() => missions.claimTasks(id, ["1", "2"], "s1"), /Storage failed/);
	assert.deepEqual(missions.tasks(id), before);
	assert.deepEqual(missions.events(id), events);
	assert.equal(changes, 0);
});

test("joining another mission moves the chat", () => {
	const missions = store();
	const first = missions.create({ projectId: "p", title: "One", tasks: [{ title: "A" }] });
	const second = missions.create({ projectId: "p", title: "Two" });
	missions.join("s1", first.id);
	missions.claimTask(first.id, 1, "s1");
	missions.join("s1", second.id);
	assert.equal(missions.missionOf("s1"), second.id);
	assert.equal(missions.tasks(first.id)[0]!.sessionId, undefined);
	assert.deepEqual(missions.members(first.id), []);
});

test("task updates validate fields, dependencies and assignment", () => {
	const missions = store();
	const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
	const [a, b] = missions.tasks(id);
	const updated = missions.updateTask(id, b!.id, { status: "done", dependsOn: [a!.id], milestone: "M1" });
	assert.equal(updated.status, "done");
	assert.ok(updated.completedAt);
	assert.deepEqual(updated.dependsOn, [a!.id]);
	assert.throws(() => missions.updateTask(id, a!.id, { dependsOn: [a!.id] }), /itself/);
	assert.throws(() => missions.updateTask(id, a!.id, { status: "nope" as never }), /status must be/);
	assert.throws(() => missions.updateTask(id, a!.id, { sessionId: "s9" }), /not in this mission/);
	missions.join("s1", id);
	assert.throws(
		() => missions.updateTask(id, a!.id, { sessionId: "s1" }, { sessionId: "s1" }),
		/only the user assigns/,
	);
	assert.equal(missions.updateTask(id, a!.id, { sessionId: "s1" }).sessionId, "s1");
	assert.equal(missions.updateTask(id, a!.id, { sessionId: null }).sessionId, undefined);
	missions.removeTask(id, a!.id);
	assert.equal(missions.task(id, b!.id).dependsOn, undefined, "removed tasks leave no dangling dependencies");
});

test("only the user changes decisions; comments resolve", () => {
	const missions = store();
	const { id } = missions.create({ projectId: "p", title: "M" });
	missions.join("s1", id);
	const decision = missions.addDecision(id, "IDs are opaque", { sessionId: "s1" });
	assert.equal(decision.authorSessionId, "s1");
	assert.throws(() => missions.updateDecision(id, decision.id, "x", { sessionId: "s1" }), /Only the user/);
	assert.throws(() => missions.removeDecision(id, decision.id, { sessionId: "s1" }), /Only the user/);
	assert.equal(missions.updateDecision(id, decision.id, "IDs are strings").text, "IDs are strings");
	const comment = missions.addComment(id, { text: "Cursor?", anchor: "pagination", targetSessionId: "s1" });
	assert.equal(comment.revision, 0);
	assert.throws(() => missions.addComment(id, { text: "x", targetSessionId: "nope" }), /not in this mission/);
	const resolved = missions.resolveComment(id, comment.id, { sessionId: "s1" });
	assert.equal(resolved.resolvedBySessionId, "s1");
	assert.ok(missions.detail(id).comments.some((c) => c.id === comment.id && c.resolvedAt));
});

test("resources are parsed and deduplicated; artifacts link only from members", () => {
	const missions = store();
	const { id } = missions.create({ projectId: "p", title: "M" });
	const issue = missions.addResource(id, { url: "https://linear.app/acme/issue/eng-12/fix-it" });
	assert.equal(issue.kind, "linear.issue");
	assert.equal(issue.externalId, "ENG-12");
	assert.equal(missions.addResource(id, { url: "https://linear.app/acme/issue/eng-12/fix-it" }).id, issue.id);
	assert.throws(() => missions.addResource(id, { url: "file:///etc/passwd" }), /http/);
	assert.throws(
		() => missions.linkArtifact(id, { sessionId: "s1", artifactId: "a", title: "A", kind: "html" }),
		/not in this mission/,
	);
	missions.join("s1", id);
	missions.linkArtifact(id, { sessionId: "s1", artifactId: "a", title: "A", kind: "html", revision: 2 });
	missions.linkArtifact(id, { sessionId: "s1", artifactId: "a", title: "A2", kind: "html" });
	assert.deepEqual(
		missions.detail(id).artifacts.map((a) => [a.title, a.revision]),
		[["A2", undefined]],
	);
	missions.unlinkArtifact(id, "a");
	assert.equal(missions.detail(id).artifacts.length, 0);
});

test("parses tracker URLs", () => {
	assert.deepEqual(parseResourceUrl("https://linear.app/acme/project/api-v2-abc"), {
		url: "https://linear.app/acme/project/api-v2-abc",
		kind: "linear.project",
		externalId: "api-v2-abc",
	});
	assert.equal(parseResourceUrl("https://github.com/o/r/pull/42").externalId, "o/r#42");
	assert.equal(parseResourceUrl("https://github.com/o/r/issues/7").kind, "github.issue");
	assert.equal(
		parseResourceUrl("https://acme.slack.com/archives/C123/p1700000000123456").externalId,
		"C123/1700000000.123456",
	);
	assert.equal(parseResourceUrl("https://example.com/x").kind, "url");
});

test("user notes survive reopening an existing database and use a bounded indexed query", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-user-notes-"));
	const file = join(dir, "missions.sqlite");
	let missions = new MissionStore(file);
	try {
		const { id } = missions.create({ projectId: "p", title: "M" });
		const update = missions.log(id, { text: "User update" });
		const note = missions.log(id, { text: "User handoff", kind: "handoff", health: "at_risk" });
		missions.log(id, { text: "Agent handoff", kind: "handoff" }, { sessionId: "agent" });
		missions.update(id, { goal: "Automatic title or goal update" });
		missions.close();
		const legacy = new DatabaseSync(file);
		try {
			legacy.exec("DROP INDEX user_notes_by_mission");
			legacy.exec("ALTER TABLE events DROP COLUMN is_user_note");
			// A large automatic-event backlog must not be scanned to find an older user note.
			legacy
				.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
				INSERT INTO events (mission_id, kind, text, at) SELECT ?, 'task', 'Automatic event', i FROM n`)
				.run(id);
		} finally {
			legacy.close();
		}
		missions = new MissionStore(file);
		assert.deepEqual(missions.userNotes(id, 15), [note, update]);
		assert.equal(missions.events(id).length, 50);
		assert.throws(() => missions.userNotes("missing", 15), /Unknown mission/);
		const identical = missions.log(id, { text: "Mission title or goal changed" });
		missions.update(id, { goal: "Another automatic update" });
		assert.deepEqual(missions.userNotes(id, 15), [identical, note, update]);
		missions.close();
		missions = new MissionStore(file);
		assert.deepEqual(missions.userNotes(id, 15), [identical, note, update]);
		const db = new DatabaseSync(file);
		try {
			const plan = db
				.prepare(`EXPLAIN QUERY PLAN SELECT * FROM events
				WHERE mission_id = ? AND is_user_note = 1
				ORDER BY id DESC LIMIT ?`)
				.all(id, 15);
			assert.match(JSON.stringify(plan), /USING INDEX user_notes_by_mission/);
			assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE|SCAN events/);
		} finally {
			db.close();
		}
	} finally {
		missions.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("targeted activity stays indexed and bounded in a large persisted history", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-activity-query-"));
	const file = join(dir, "missions.sqlite");
	let missions = new MissionStore(file);
	try {
		const { id } = missions.create({ projectId: "p", title: "Shared", tasks: [{ title: "Target" }] });
		const task = missions.tasks(id)[0]!;
		const other = missions.create({ projectId: "p", title: "Other" });
		missions.close();
		const db = new DatabaseSync(file);
		try {
			// Synthetic automatic activity, not real account data or provider calls.
			db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 10000)
				INSERT INTO events (mission_id, kind, text, task_id, at)
				SELECT ?, CASE WHEN n % 100 = 0 THEN 'task' ELSE 'update' END, 'Synthetic event ' || n,
				CASE WHEN n % 100 = 0 THEN ? ELSE NULL END, n FROM seq`).run(id, task.id);
			db.prepare(
				"INSERT INTO events (mission_id, kind, text, task_id, at) VALUES (?, 'task', 'Foreign', ?, 9999)",
			).run(other.id, task.id);
			// Simulate upgrading an existing database without the new index.
			db.exec("DROP INDEX events_by_mission_task");
		} finally {
			db.close();
		}
		missions = new MissionStore(file);
		const all = missions.events(id, undefined, 20000);
		const expected = all
			.filter(
				(event) =>
					event.taskId === task.id &&
					event.kind === "task" &&
					event.at > 5000 &&
					event.id > 6000 &&
					event.id < 9000,
			)
			.slice(0, 15);
		const query = {
			taskId: task.id,
			kind: "task" as const,
			sinceAt: 5000,
			sinceEventId: 6000,
			before: 9000,
			limit: 15,
		};
		assert.deepEqual(missions.activity(id, query), expected);
		assert.equal(missions.activity(id, { taskId: task.id, kind: "update", limit: 15 }).length, 0);
		assert.throws(() => missions.activity("missing", { limit: 15 }), /Unknown mission/);
		const check = new DatabaseSync(file);
		try {
			const plan = check
				.prepare(
					"EXPLAIN QUERY PLAN SELECT * FROM events WHERE mission_id = ? AND task_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
				)
				.all(id, task.id, 9000, 15);
			assert.match(JSON.stringify(plan), /USING INDEX events_by_mission_task/);
			assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE|SCAN events/);
		} finally {
			check.close();
		}
		const measure = (read: () => unknown) => {
			const start = performance.now();
			for (let i = 0; i < 20; i++) read();
			return (performance.now() - start).toFixed(2);
		};
		const scannedMs = measure(() =>
			missions
				.events(id, undefined, 20000)
				.filter((event) => event.taskId === task.id)
				.slice(0, 15),
		);
		const targetedMs = measure(() => missions.activity(id, { taskId: task.id, limit: 15 }));
		t.diagnostic(
			`10,000 events, 20 reads: list/filter ${scannedMs} ms; indexed task activity ${targetedMs} ms (timing is informational)`,
		);
	} finally {
		missions.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("status updates, events paging and deletion detach members", () => {
	const missions = store();
	const { id } = missions.create({ projectId: "p", title: "M" });
	missions.join("s1", id);
	const update = missions.log(id, { text: "Halfway", health: "at_risk" }, { sessionId: "s1" });
	assert.equal(update.kind, "update");
	assert.throws(() => missions.log(id, { text: "x", kind: "created" as never }), /kind/);
	const page = missions.events(id, update.id, 1);
	assert.equal(page.length, 1);
	assert.ok(page[0]!.id < update.id);
	const done = missions.update(id, { status: "done" });
	assert.ok(done.completedAt);
	assert.equal(missions.update(id, { status: "active" }).completedAt, undefined);
	assert.throws(() => missions.update(id, { coordinatorSessionId: "s9" }), /coordinator must be/);
	missions.remove(id);
	assert.equal(missions.missionOf("s1"), undefined);
	assert.throws(() => missions.require(id), /Unknown mission/);
});
test("release resets active claims, preserves review/closed states and notifies once", (t) => {
	const missions = store();
	t.after(() => missions.close());
	const { id } = missions.create({
		projectId: "p",
		title: "M",
		tasks: Array.from({ length: 6 }, (_, i) => ({ title: `T${i}` })),
	});
	for (const chat of ["owner", "other", "lead"]) missions.join(chat, id);
	missions.update(id, { coordinatorSessionId: "lead" });
	const states = ["in_progress", "blocked", "in_review", "done", "dropped", "todo"] as const;
	for (const [i, status] of states.entries()) {
		missions.claimTask(id, i + 1, "owner");
		missions.updateTask(id, String(i + 1), { status });
	}
	assert.throws(() => missions.releaseTask(id, "1", { sessionId: "other" }), /only the coordinator/);
	assert.throws(() => missions.releaseTasks(id, ["1"], { sessionId: "outsider" }), /not in this mission/);
	assert.equal(missions.releaseTasks(id, ["1", "99"], { sessionId: "other" }).skipped.length, 2);
	const events = missions.events(id).length;
	let changes = 0;
	const refreshed: string[] = [];
	missions.onChange(() => {
		changes++;
		assert.ok(missions.tasks(id).every((task) => !task.sessionId));
	});
	missions.onMembershipChange((sessionId) => refreshed.push(sessionId));
	const result = missions.releaseTasks(id, ["1", "#1", "2", "3", "4", "5", "6", "99"], { sessionId: "lead" });
	assert.deepEqual(
		result.released.map((task) => task.status),
		["todo", "todo", "in_review", "done", "dropped", "todo"],
	);
	assert.equal(result.skipped.length, 1);
	assert.equal(changes, 1);
	assert.deepEqual(refreshed, ["owner"]);
	assert.equal(missions.events(id).length, events + 6);
	assert.ok(
		missions
			.events(id)
			.slice(0, 6)
			.every((event) => event.sessionId === "lead" && event.text.includes("owner")),
	);
	missions.releaseTask(id, "1", { sessionId: "owner" });
	assert.equal(missions.events(id).length, events + 6);
});

test("members release their own claims and app assignment clearing resets blocked work", (t) => {
	const missions = store();
	t.after(() => missions.close());
	const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
	missions.join("owner", id);
	missions.claimTask(id, "1", "owner");
	missions.claimTask(id, "2", "owner");
	missions.updateTask(id, "2", { status: "blocked" });
	assert.equal(missions.releaseTask(id, "1", { sessionId: "owner" }).status, "todo");
	const released = missions.updateTask(id, "2", { sessionId: null });
	assert.equal(released.status, "todo");
	assert.equal(released.sessionId, undefined);
});
test("release rolls back storage failures and keeps task references", (t) => {
	const missions = store();
	t.after(() => missions.close());
	const { id } = missions.create({ projectId: "p", title: "M", tasks: [{ title: "A" }, { title: "B" }] });
	missions.join("owner", id);
	const task = missions.claimTask(id, "1", "owner");
	missions.claimTask(id, "2", "owner");
	missions.addResource(id, { url: "https://example.com/work", taskId: task.id });
	const before = missions.detail(id);
	let changes = 0;
	missions.onChange(() => changes++);
	const resolve = missions.resolveTask.bind(missions);
	const mock = t.mock.method(missions, "resolveTask", (id: string, ref: unknown) => {
		if (ref === "2") throw new Error("Storage failed");
		return resolve(id, ref);
	});
	assert.throws(() => missions.releaseTasks(id, ["1", "2"], { sessionId: "owner" }), /Storage failed/);
	assert.deepEqual(missions.detail(id), before);
	assert.equal(changes, 0);
	mock.mock.restore();
	missions.releaseTasks(id, ["1", "2"], { sessionId: "owner" });
	assert.deepEqual(missions.detail(id).resources, before.resources);
});

test("decision numbers backfill in creation order, persist their high-water mark and resolve aliases", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-decision-numbers-"));
	const file = join(dir, "missions.sqlite");
	let store = new MissionStore(file);
	try {
		const { id } = store.create({ projectId: "p", title: "Numbers" });
		const a = store.addDecision(id, "First");
		const b = store.addDecision(id, "Second");
		store.close();
		const legacy = new DatabaseSync(file);
		legacy.exec(
			"DROP INDEX decision_numbers; ALTER TABLE decisions DROP COLUMN number; ALTER TABLE missions DROP COLUMN decision_sequence",
		);
		legacy.prepare("UPDATE decisions SET created_at = ? WHERE id = ?").run(1, b.id);
		legacy.prepare("UPDATE decisions SET created_at = ? WHERE id = ?").run(2, a.id);
		legacy.close();
		store = new MissionStore(file);
		assert.deepEqual(
			store.detail(id).decisions.map((d) => [d.text, d.number]),
			[
				["Second", 1],
				["First", 2],
			],
		);
		assert.equal(store.updateDecision(id, "D2", "Updated").id, a.id);
		store.removeDecision(id, "D2");
		store.removeDecision(id, "D1");
		store.close();
		store = new MissionStore(file);
		assert.equal(store.addDecision(id, "Third").number, 3);
		const other = store.create({ projectId: "p", title: "Other" });
		assert.equal(store.addDecision(other.id, "Independent").number, 1);
		assert.throws(() => store.updateDecision(other.id, "D3", "Foreign"), /Unknown decision/);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("decision proposals are coordinator-only, replace pending suggestions, discard stale ones and count attention", () => {
	const store = new MissionStore(":memory:");
	try {
		const { id } = store.create({ projectId: "p", title: "Shared" });
		store.join("lead", id);
		store.join("worker", id);
		store.update(id, { coordinatorSessionId: "lead" });
		const d = store.addDecision(id, "Original", {}, "all");
		assert.throws(
			() => store.proposeDecision(id, "D1", "Edit", undefined, "Reason", { sessionId: "worker" }),
			/Only the mission coordinator/,
		);
		assert.throws(
			() => store.proposeDecision(id, "D1", "Edit", undefined, "Reason", {}),
			/Only the mission coordinator/,
		);
		assert.throws(() => store.proposeDecision(id, "D1", "Edit", true, "Reason", { sessionId: "lead" }), /not both/);
		const first = store.proposeDecision(id, "D1", "New", undefined, "Superseded", { sessionId: "lead" });
		assert.equal(store.require(id).needsYouCount, 1);
		assert.equal(store.require(id).needsYouReason, "Decision proposal: Superseded");
		assert.equal(store.detail(id).decisions[0]!.text, "Original");
		const second = store.proposeDecision(id, d.id, undefined, true, "Obsolete", { sessionId: "lead" });
		assert.equal(store.require(id).needsYouReason, "Decision proposal: Obsolete");
		assert.deepEqual(
			store.proposals(id).map((p) => p.id),
			[second.id],
		);
		assert.throws(() => store.resolveProposal(id, first.id, true), /Unknown pending/);
		store.updateDecision(id, "D1", undefined, {}, "reference");
		assert.deepEqual(store.proposals(id), []);
		assert.equal(store.require(id).needsYouCount, 0);
		assert.equal(store.require(id).needsYouReason, undefined);
		const third = store.proposeDecision(id, "D1", "Reword", undefined, "Reason", { sessionId: "lead" });
		store.removeDecision(id, d.id);
		assert.equal(store.proposals(id).length, 0);
		assert.throws(() => store.resolveProposal(id, third.id, true), /Unknown pending/);
	} finally {
		store.close();
	}
});

test("proposal resolution uses the user path atomically, preserves audiences and pins, and queues outcomes", () => {
	const store = new MissionStore(":memory:");
	try {
		const { id } = store.create({ projectId: "p", title: "Shared", tasks: [{ title: "Implement" }] });
		store.join("lead", id);
		store.update(id, { coordinatorSessionId: "lead" });
		const decision = store.addDecision(id, "Original", {}, "all");
		store.updateTask(id, "1", { decisionIds: ["D1"] });
		const propose = (remove = false) =>
			store.proposeDecision(id, "D1", remove ? undefined : "Suggested", remove ? true : undefined, "Reason", {
				sessionId: "lead",
			});
		let p = propose();
		assert.throws(() => store.resolveProposal(id, p.id, true, undefined, { sessionId: "lead" }), /Only the user/);
		assert.equal(store.resolveProposal(id, p.id, false).status, "rejected");
		assert.equal(store.detail(id).decisions[0]!.text, "Original");
		p = propose();
		assert.throws(() => store.resolveProposal(id, p.id, true, ""), /text/);
		assert.equal(store.proposals(id).find((x) => x.id === p.id)!.status, "pending");
		assert.equal(store.detail(id).decisions[0]!.text, "Original");
		let broadcasts = 0;
		const unsubscribe = store.onChange(() => {
			broadcasts++;
			assert.equal(store.proposals(id).find((x) => x.id === p.id)!.status, "accepted");
		});
		const accepted = store.resolveProposal(id, p.id, true, "User wording");
		assert.equal(accepted.status, "accepted");
		assert.equal(accepted.text, "User wording");
		assert.equal(broadcasts, 1);
		unsubscribe();
		assert.equal(store.detail(id).decisions[0]!.text, "User wording");
		assert.equal(store.detail(id).decisions[0]!.audience, "all");
		assert.equal(store.detail(id).decisions[0]!.number, 1);
		assert.equal(store.require(id).needsYouCount, 0);
		assert.ok(store.detail(id).events.some((e) => /Decision D1 changed.*proposed by chat lead/.test(e.text)));
		p = propose(true);
		assert.equal(store.resolveProposal(id, p.id, true).status, "accepted");
		assert.equal(store.detail(id).decisions.length, 0);
		assert.deepEqual(store.resolveTask(id, "1").decisionIds, []);
		assert.ok(store.proposals(id).some((x) => x.id === p.id && x.status === "accepted"));
		assert.ok(store.detail(id).events.some((e) => /proposal .* rejected/.test(e.text)));
		assert.ok(store.detail(id).events.some((e) => /Decision D1 removed.*proposed by chat lead/.test(e.text)));
		assert.equal(store.addDecision(id, "Next").number, decision.number + 1);
		const notice = store.prepareNotice(id, "lead", Date.now() + 31_000);
		assert.ok(notice?.content.includes("rejected"));
		assert.ok(notice?.content.includes("accepted"));
	} finally {
		store.close();
	}
});

test("pending and resolved proposals survive restart, including an accepted removal", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-decision-proposals-"));
	const file = join(dir, "missions.sqlite");
	let store = new MissionStore(file);
	try {
		const { id } = store.create({ projectId: "p", title: "Shared" });
		store.join("lead", id);
		store.update(id, { coordinatorSessionId: "lead" });
		store.addDecision(id, "Original");
		const proposal = store.proposeDecision(id, "D1", undefined, true, "Obsolete", { sessionId: "lead" });
		store.close();
		store = new MissionStore(file);
		assert.equal(store.require(id).needsYouCount, 1);
		assert.equal(store.proposals(id)[0]!.id, proposal.id);
		const resolved = store.resolveProposal(id, proposal.id, true);
		assert.ok(resolved.resolvedAt);
		store.close();
		store = new MissionStore(file);
		assert.equal(store.require(id).needsYouCount, 0);
		assert.deepEqual(store.detail(id).decisions, []);
		assert.deepEqual(store.proposals(id), [resolved]);
		assert.equal(store.addDecision(id, "Next").number, 2);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("summary reason selects an eligible question and changes when resolved or a task blocks", () => {
	const missions = store();
	try {
		const { id } = missions.create({ projectId: "p", title: "M" });
		missions.join("agent", id);
		missions.addComment(id, { text: "User note" });
		missions.addComment(id, { text: "Addressed", targetSessionId: "agent" }, { sessionId: "agent" });
		assert.equal(missions.require(id).needsYouReason, undefined);
		const question = missions.addComment(id, { text: "Ship it?\nDetails" }, { sessionId: "agent" });
		assert.equal(missions.require(id).needsYouReason, "Ship it?");
		missions.update(id, { coordinatorSessionId: "agent" });
		assert.equal(missions.require(id).needsYouReason, undefined);
		missions.update(id, { coordinatorSessionId: null });
		const blocked = missions.addTask(id, { title: "x".repeat(200), status: "blocked" });
		assert.equal(missions.require(id).needsYouReason?.length, 200);
		missions.removeTask(id, blocked.id);
		assert.equal(missions.require(id).needsYouReason, "Ship it?");
		missions.resolveComment(id, question.id);
		assert.equal(missions.require(id).needsYouReason, undefined);
	} finally {
		missions.close();
	}
});

test("existing stores gain ordered attention indexes so reason selection does not sort", () => {
	const home = mkdtempSync(join(tmpdir(), "pilot-reason-indexes-"));
	const path = join(home, "missions.sqlite");
	let missions = new MissionStore(path);
	try {
		missions.close();
		const legacy = new DatabaseSync(path);
		legacy.exec(
			"DROP INDEX blocked_tasks_attention_order; DROP INDEX needs_you_comments_attention_order; DROP INDEX proposals_attention_order;",
		);
		legacy.close();
		missions = new MissionStore(path);
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const tasks = db
				.prepare(
					"EXPLAIN QUERY PLAN SELECT substr(title, 1, 201) FROM tasks WHERE mission_id = ? AND status = 'blocked' ORDER BY sort, number LIMIT 1",
				)
				.all("m");
			const comments = db
				.prepare(
					"EXPLAIN QUERY PLAN SELECT substr(text, 1, 201) FROM comments WHERE mission_id = ? AND resolved_at IS NULL AND target_session_id IS NULL AND author_session_id IS NOT NULL ORDER BY created_at, id LIMIT 1",
				)
				.all("m");
			assert.ok(tasks.some((row) => String(row.detail).includes("blocked_tasks_attention_order")));
			assert.ok(comments.some((row) => String(row.detail).includes("needs_you_comments_attention_order")));
			const proposals = db
				.prepare(
					"EXPLAIN QUERY PLAN SELECT substr(reason, 1, 201) FROM decision_proposals WHERE mission_id = ? AND status = 'pending' ORDER BY created_at, id LIMIT 1",
				)
				.all("m");
			assert.ok(proposals.some((row) => String(row.detail).includes("proposals_attention_order")));
			assert.ok([...tasks, ...comments, ...proposals].every((row) => !String(row.detail).includes("TEMP B-TREE")));
		} finally {
			db.close();
		}
	} finally {
		missions.close();
		rmSync(home, { recursive: true, force: true });
	}
});

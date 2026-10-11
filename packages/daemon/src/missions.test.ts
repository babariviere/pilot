import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionPullRequest } from "@pilot/protocol";
import { MissionStore, parseResourceUrl } from "./missions.ts";

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

function store() {
	return new MissionStore(":memory:");
}

const pr = (number: number, state: SessionPullRequest["state"]): SessionPullRequest => ({
	number,
	state,
	url: `https://github.com/octo/repo/pull/${number}`,
	title: "PR",
	checkedAt: Date.now(),
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
			"ALTER TABLE resources DROP COLUMN task_id; ALTER TABLE resources DROP COLUMN pull_request; ALTER TABLE tasks DROP COLUMN pr_sync_disabled;",
		);
		legacy.close();
		missions = new MissionStore(file);
		assert.equal(missions.detail(id).resources.length, 1);
		assert.equal(missions.detail(id).resources[0]!.taskId, undefined);
		missions.addResource(id, { taskId: "1", url: pr(1, "open").url });
		missions.updatePullRequest(pr(1, "merged"));
		assert.equal(missions.resolveTask(id, "1").status, "done");
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

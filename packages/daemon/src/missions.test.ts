import assert from "node:assert/strict";
import { test } from "node:test";
import { MissionStore, parseResourceUrl } from "./missions.ts";

function store() {
	return new MissionStore(":memory:");
}

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

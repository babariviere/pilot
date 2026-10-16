import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Project, TrackingJson } from "@pilot/protocol";
import { createMissionLinearPoller, MissionLinearSource } from "./linear-source.ts";
import { MissionStore } from "./missions.ts";
import type { SourcePollContext } from "./sources.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pilot-delegation-"));
	const file = join(dir, "missions.sqlite");
	const store = new MissionStore(file);
	const { id } = store.create({ projectId: "p", title: "Work" });
	const add = (status: "todo" | "in_progress" | "blocked" | "in_review" = "todo") => {
		const task = store.addTask(id, { title: "Task", status });
		store.addResource(id, {
			url: `https://linear.app/team/issue/ENG-${task.number}/task`,
			linearRole: "managed",
		});
		const link = store.addResource(id, {
			url: `https://linear.app/team/issue/ENG-${task.number}/task`,
			taskId: task.id,
			linearRole: "contribution",
		});
		return { task, link };
	};
	return {
		store,
		id,
		add,
		file,
		close() {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
const other = { id: "other", name: "Alex" };
const me = { id: "me", name: "You" };

test("all open statuses delegate and restore, unassignment is ignored, notices occur once per change", async () => {
	const f = fixture();
	try {
		f.store.join("worker", f.id);
		for (const status of ["todo", "in_progress", "blocked", "in_review"] as const) {
			const { task, link } = f.add(status);
			if (status === "in_progress") f.store.claimTask(f.id, task.id, "worker");
			const observe = (assignee: typeof other | null) => f.store.observeLinearAssignee("p", link.id, assignee, "me");
			observe(other);
			assert.equal(f.store.task(f.id, task.id).status, "delegated");
			assert.equal(f.store.task(f.id, task.id).delegatedTo, "Alex");
			observe(other);
			observe(null);
			assert.equal(f.store.task(f.id, task.id).status, "delegated");
			observe(me);
			assert.equal(f.store.task(f.id, task.id).status, status);
			assert.equal(f.store.task(f.id, task.id).delegatedTo, undefined);
			observe(me);
			const events = f.store.activity(f.id, { taskId: task.id, limit: 100 });
			assert.equal(events.filter((event) => event.text.startsWith("Delegated to Alex in Linear")).length, 1);
			assert.equal(events.filter((event) => event.text.startsWith("Returned to you in Linear")).length, 1);
			if (status === "in_progress") assert.equal(f.store.task(f.id, task.id).sessionId, "worker");
		}
		// The store saves to its file in the background.
		await f.store.durable();
		const db = new DatabaseSync(f.file);
		try {
			assert.equal(
				db
					.prepare(
						"SELECT COUNT(*) n FROM pending_notices p JOIN events e ON e.id = p.event_id WHERE e.text LIKE 'Delegated to %' OR e.text LIKE 'Returned to you %'",
					)
					.get()!.n,
				8,
			);
		} finally {
			db.close();
		}
	} finally {
		f.close();
	}
});

test("global linked polling needs no configured Inbox team and stops its timer and in-flight read", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	try {
		const { task } = f.add();
		let readStarted!: () => void;
		const reading = new Promise<void>((resolve) => {
			readStarted = resolve;
		});
		let calls = 0;
		const source = new MissionLinearSource(f.store, {
			async call(kind, tool, _args, signal): Promise<TrackingJson> {
				calls++;
				assert.equal(kind, "linear");
				if (tool === "me") return { id: "me" };
				assert.equal(tool, "issue");
				readStarted();
				return new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
				);
			},
		});
		source.start();
		source.start();
		t.mock.timers.tick(0);
		await reading;
		await source.stop();
		assert.equal(f.store.task(f.id, task.id).status, "todo");
		t.mock.timers.tick(600_000);
		assert.equal(calls, 2);
	} finally {
		f.close();
	}
});

test("manual status overrides survive repeated polls and returning to me, until a new assignee", () => {
	const f = fixture();
	try {
		const { task, link } = f.add("in_review");
		const observe = (assignee: typeof other | null) => f.store.observeLinearAssignee("p", link.id, assignee, "me");
		observe(other);
		f.store.updateTask(f.id, task.id, { status: "blocked" });
		observe(other);
		assert.equal(f.store.task(f.id, task.id).status, "blocked");
		observe(me);
		assert.equal(f.store.task(f.id, task.id).status, "blocked", "not restored after manual override");
		observe(other);
		assert.equal(f.store.task(f.id, task.id).status, "delegated");
		observe({ id: "new", name: "Sam" });
		assert.equal(f.store.task(f.id, task.id).delegatedTo, "Sam");
		observe(me);
		assert.equal(f.store.task(f.id, task.id).status, "blocked", "original status survives other-to-other assignment");
		observe(other);
		f.store.updateTask(f.id, task.id, { status: "delegated" });
		observe(me);
		assert.equal(f.store.task(f.id, task.id).status, "delegated", "manual delegated is never automatically cleared");
		assert.equal(f.store.task(f.id, task.id).delegatedTo, undefined);
	} finally {
		f.close();
	}
});

test("assignment observations and restoration persist across reopen", () => {
	const f = fixture();
	try {
		const { task, link } = f.add();
		f.store.observeLinearAssignee("p", link.id, other, "me");
		f.store.close();
		const reopened = new MissionStore(f.file);
		try {
			assert.equal(reopened.task(f.id, task.id).delegatedTo, "Alex");
			reopened.observeLinearAssignee("p", link.id, me, "me");
			assert.equal(reopened.task(f.id, task.id).status, "todo");
			reopened.observeLinearAssignee("p", link.id, other, "me");
			reopened.updateTask(f.id, task.id, { status: "in_progress" });
		} finally {
			reopened.close();
		}
		const again = new MissionStore(f.file);
		try {
			again.observeLinearAssignee("p", link.id, other, "me");
			assert.equal(again.task(f.id, task.id).status, "in_progress");
		} finally {
			again.close();
		}
	} finally {
		rmSync(join(f.file, ".."), { recursive: true, force: true });
	}
});

test("delegated is neither done nor startable, including inside a selected dependency chain; PR sync leaves it alone", () => {
	const f = fixture();
	try {
		const { task } = f.add();
		f.store.updateTask(f.id, task.id, { status: "delegated" });
		const dependent = f.store.addTask(f.id, { title: "Later", dependsOn: [task.id] });
		assert.throws(() => f.store.prepareTaskStart(f.id, [task.id]), /is delegated/);
		assert.throws(() => f.store.prepareTaskStart(f.id, [dependent.id]), /not done/);
		assert.throws(() => f.store.prepareTaskStart(f.id, [task.id, dependent.id]), /is delegated/);
		assert.equal(f.store.get(f.id)!.tasksDone, 0);
		assert.equal(f.store.get(f.id)!.tasksTotal, 2);
		f.store.addResource(f.id, {
			url: "https://github.com/octo/repo/pull/1",
			taskId: task.id,
			relationship: "ownership",
		});
		assert.equal(f.store.task(f.id, task.id).status, "delegated");
		f.store.updateTask(f.id, task.id, { status: "todo" });
		assert.equal(f.store.prepareTaskStart(f.id, [task.id])[0]!.status, "todo");
	} finally {
		f.close();
	}
});

test("poll reads only linked open tasks in active projects, rotates bounded batches, and failures leave status unchanged", async () => {
	const f = fixture();
	try {
		const links = Array.from({ length: 28 }, () => f.add());
		f.store.addResource(f.id, { url: "https://linear.app/team/issue/ENG-999/not-a-task" });
		const done = f.add();
		f.store.updateTask(f.id, done.task.id, { status: "done" });
		const archived = f.store.create({ projectId: "p", title: "Archived" });
		const hidden = f.store.addTask(archived.id, { title: "Hidden" });
		f.store.addResource(archived.id, { url: "https://linear.app/team/issue/ENG-888/hidden", taskId: hidden.id });
		f.store.update(archived.id, { status: "archived" });
		const issues: string[] = [];
		const ctx: SourcePollContext = {
			project: { id: "p" } as Project,
			config: { linearTeam: "team", slackChannels: [] },
			signal: new AbortController().signal,
			async call(tool, args): Promise<TrackingJson> {
				if (tool === "me") return args.query === "me" ? { id: "me" } : { id: "other", displayName: "Alex" };
				assert.equal(tool, "issue", "never write to Linear");
				assert.deepEqual(args.fields, ["id", "uuid", "identifier", "assigneeId"]);
				issues.push(args.id as string);
				return { id: args.id as string, assigneeId: "other" };
			},
		};
		const poll = createMissionLinearPoller(f.store);
		await poll(ctx);
		assert.equal(issues.length, 25);
		await poll(ctx);
		assert.equal(issues.length, 28);
		assert.equal(new Set(issues).size, 28, "no starvation");
		assert.ok(!issues.includes("ENG-999") && !issues.includes("ENG-888"));
		const target = links[0]!;
		f.store.updateTask(f.id, target.task.id, { status: "todo" });
		await poll({
			...ctx,
			call: async () => {
				throw new Error("offline");
			},
		}).catch(() => {});
		assert.equal(f.store.task(f.id, target.task.id).status, "todo");
		// Malformed/mismatched issues and failed user lookups do not checkpoint observations.
		for (const response of [
			{ id: "wrong", assigneeId: "me" },
			{ id: target.link.externalId! },
			{ id: target.link.externalId!, assigneeId: "unknown" },
		] as TrackingJson[]) {
			const fresh = createMissionLinearPoller(f.store);
			await fresh({
				...ctx,
				async call(tool, args): Promise<TrackingJson> {
					if (tool === "me") {
						if (args.query === "me") return { id: "me" };
						throw new Error("no access");
					}
					return response;
				},
			});
			assert.equal(f.store.task(f.id, target.task.id).status, "todo");
		}
	} finally {
		f.close();
	}
});

test("late poll results cannot update removed links, closed tasks, archived missions or aborted polls", async () => {
	const f = fixture();
	try {
		const { task, link } = f.add();
		const controller = new AbortController();
		const poll = createMissionLinearPoller(f.store);
		const ctx: SourcePollContext = {
			project: { id: "p" } as Project,
			config: { linearTeam: "team", slackChannels: [] },
			signal: controller.signal,
			async call(tool): Promise<TrackingJson> {
				if (tool === "me") return { id: "me" };
				controller.abort();
				return { id: link.externalId!, assigneeId: "me" };
			},
		};
		await assert.rejects(poll(ctx));
		assert.equal(f.store.task(f.id, task.id).status, "todo");
		f.store.updateTask(f.id, task.id, { status: "done" });
		f.store.observeLinearAssignee("p", link.id, other, "me");
		assert.equal(f.store.task(f.id, task.id).status, "done");
		f.store.updateTask(f.id, task.id, { status: "todo" });
		f.store.update(f.id, { status: "archived" });
		f.store.observeLinearAssignee("p", link.id, other, "me");
		assert.equal(f.store.task(f.id, task.id).status, "todo");
		f.store.update(f.id, { status: "active" });
		f.store.removeResource(f.id, link.id);
		f.store.observeLinearAssignee("p", link.id, other, "me");
		assert.equal(f.store.task(f.id, task.id).status, "todo");
	} finally {
		f.close();
	}
});

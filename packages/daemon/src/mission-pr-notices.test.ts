import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionPullRequest, SessionSummary } from "@pilot/protocol";
import { MissionNotices } from "./mission-notices.ts";
import { MissionStore, NOTICE_MAX_DELAY_MS } from "./missions.ts";
import type { SessionManager } from "./sessions.ts";

function setup(file = ":memory:") {
	const store = new MissionStore(file);
	const { id } = store.create({ projectId: "p", title: "M", tasks: [{ title: "Foundation" }] });
	store.join("lead", id);
	store.join("member", id);
	store.update(id, { coordinatorSessionId: "lead" });
	store.claimTask(id, "1", "member");
	const chat: SessionSummary = {
		id: "member",
		missionId: id,
		title: "Implementation",
		state: "idle",
		mode: "build",
		cwd: "/tmp",
		sessionPath: "/tmp",
		createdAt: 0,
		updatedAt: 0,
	};
	return { store, id, chat };
}

function pr(number = 1, state: SessionPullRequest["state"] = "open"): SessionPullRequest {
	return {
		number,
		url: `https://github.com/o/r/pull/${number}`,
		title: `Change ${number}`,
		state,
		checkedAt: Date.now(),
		...(state === "merged" ? { mergedAt: Date.now() } : {}),
	};
}

test("task merge queues one PR-keyed event with done, newly ready dependents and open stacked PRs", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id, chat } = setup();
	try {
		const first = store.resolveTask(id, "1");
		store.addTask(id, { title: "Ready", dependsOn: [first.id] });
		const unfinished = store.addTask(id, { title: "Unfinished" });
		store.addTask(id, { title: "Still blocked", dependsOn: [first.id, unfinished.id] });
		store.addTask(id, { title: "Dropped", dependsOn: [first.id], status: "dropped" });
		const stack = { number: 7, position: 1, size: 3, baseBranch: "main" };
		const open = { ...pr(), stack };
		store.addResource(id, { taskId: first.id, url: open.url });
		store.updatePullRequest(open, [chat]);
		const upper = { ...pr(2), stack: { ...stack, position: 2 } };
		const draft = { ...pr(3, "draft"), stack: { ...stack, position: 3 } };
		const unrelated = { ...pr(4), stack: { ...stack, position: 2, number: 8 } };
		const otherRepo = { ...pr(5), url: "https://github.com/else/r/pull/5", stack: { ...stack, position: 2 } };
		store.recordMemberPullRequests(chat, [upper, draft, unrelated, otherRepo]);
		const merged = { ...open, state: "merged" as const, mergedAt: 1_001, checkedAt: 1_001 };
		t.mock.timers.tick(1);
		store.updatePullRequest(merged, [chat], () => [upper, draft, unrelated, otherRepo]);
		assert.equal(store.task(id, first.id).status, "done");
		assert.equal(store.prepareNotice(id, "lead", Date.now()), undefined);
		const notice = store.prepareNotice(id, "lead", Date.now() + 30_000)!;
		assert.match(notice.content, /PR #1 Change 1 merged \(chat Implementation, task #1 marked done\)/);
		assert.match(notice.content, /unblocks task #2 Ready/);
		assert.match(notice.content, /open stacked PRs: #2 Change 2, #3 Change 3/);
		assert.doesNotMatch(notice.content, /Still blocked|Dropped|Change 4|Change 5/);
		assert.equal(notice.content.split("\n").filter((line) => line.startsWith("- ")).length, 1);
		store.acknowledgeNotice(notice, Date.now() + 30_000);
		store.updatePullRequest({ ...merged, checkedAt: 100_000 }, [chat]);
		store.recordMemberCompletion({ ...chat, outcome: "done", outcomeAt: 100_001, pullRequest: merged });
		const outcome = store.prepareNotice(id, "lead", 130_001);
		assert.ok(!outcome || !outcome.content.includes("merged"));
	} finally {
		store.close();
	}
});

test("chat-only merge after a finished chat is observed without changing its outcome version and stays grouped", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id, chat } = setup();
	store.join("second", id);
	const chats = new Map<string, SessionSummary>([
		["lead", { ...chat, id: "lead" }],
		["member", { ...chat, outcome: "done", outcomeAt: 1_000, pullRequest: pr() }],
		["second", { ...chat, id: "second", state: "working" }],
	]);
	let observe!: (chat: SessionSummary) => void;
	const delivered: string[] = [];
	const sessions = {
		list: () => [...chats.values()],
		get: (id: string) => chats.get(id),
		ownedPullRequests: (id: string) => (chats.get(id)?.pullRequest ? [chats.get(id)!.pullRequest!] : []),
		onChange: (listener: typeof observe) => {
			observe = listener;
			return () => {};
		},
		canSendNotice: () => chats.get("lead")!.state === "idle",
		sendNotice: async (_id: string, content: string) => {
			delivered.push(content);
			return true;
		},
	} as unknown as SessionManager;
	const delivery = new MissionNotices(store, sessions);
	delivery.start();
	try {
		const merged = { ...chats.get("member")!, pullRequest: pr(1, "merged") };
		chats.set("member", merged);
		store.updatePullRequest(merged.pullRequest, [merged]);
		observe(merged);
		store.addComment(id, { text: "Also review the next step" });
		t.mock.timers.tick(60_000);
		await delivery.flush();
		assert.equal(delivered.length, 0);
		assert.equal(store.pendingNotice(id), undefined, "no early inbox item is frozen");
		const idle = {
			...chats.get("second")!,
			state: "idle" as const,
			runningJobs: [
				{
					id: "tests",
					name: "Tests",
					state: "running" as const,
					outputPath: "/tmp/tests.log",
					startedAt: Date.now(),
				},
			],
		};
		chats.set("second", idle);
		observe(idle);
		t.mock.timers.tick(30_000);
		await delivery.flush();
		assert.equal(delivered.length, 0, "an idle member with a background job still holds PR notices");
		const finished = { ...idle, runningJobs: [] };
		chats.set("second", finished);
		observe(finished);
		t.mock.timers.tick(29_999);
		await delivery.flush();
		assert.equal(delivered.length, 0);
		t.mock.timers.tick(1);
		await delivery.flush();
		assert.equal(delivered.length, 1);
		assert.match(delivered[0]!, /PR #1 Change 1 merged \(chat Implementation\)/);
		assert.match(delivered[0]!, /chat finished/);
		assert.match(delivered[0]!, /Also review/);
		assert.equal(delivered[0]!.match(/merged/g)?.length, 1);
		observe({ ...merged, updatedAt: 100_000 });
		await delivery.flush();
		assert.equal(delivered.length, 1);
	} finally {
		await delivery.stop();
		store.close();
	}
});

test("closed-unmerged PRs wake once, remain stuck, and can later merge without repeating close", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id, chat } = setup();
	try {
		store.addResource(id, { taskId: "1", url: pr().url });
		store.updatePullRequest(pr(), [chat]);
		store.updatePullRequest(pr(1, "closed"), [chat]);
		assert.equal(store.resolveTask(id, "1").status, "in_review");
		store.recordMemberCompletion({ ...chat, outcome: "done", outcomeAt: 1_001, pullRequest: pr(1, "closed") });
		const notice = store.prepareNotice(id, "lead", 31_000)!;
		assert.match(notice.content, /PR #1 closed without merging \(chat Implementation, task #1\)/);
		assert.equal(notice.content.match(/closed without merging/g)?.length, 1);
		store.acknowledgeNotice(notice, 31_000);
		store.updatePullRequest({ ...pr(1, "closed"), url: pr().url.toUpperCase(), checkedAt: 2_000 }, [chat]);
		assert.deepEqual(store.noticeDeadlines(31_000), []);
		t.mock.timers.tick(1_000);
		store.updatePullRequest(pr(1, "merged"), [chat]);
		assert.match(store.prepareNotice(id, "lead", 32_000)!.content, /marked done/);
	} finally {
		store.close();
	}
});

test("own-chat and pre-membership merges do not wake; manual resets do not claim task completion", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id, chat } = setup();
	try {
		store.recordMemberPullRequests({ ...chat, id: "lead" }, [pr(1, "merged")]);
		store.recordMemberPullRequests(chat, [
			{ ...pr(2, "merged"), mergedAt: 999 },
			{ ...pr(3, "merged"), mergedAt: undefined },
		]);
		assert.deepEqual(store.noticeDeadlines(1_000), []);
		store.addResource(id, { taskId: "1", url: pr(4).url });
		store.updatePullRequest(pr(4), [chat]);
		store.updateTask(id, "1", { status: "todo" });
		store.updatePullRequest(pr(4, "merged"), [chat]);
		assert.equal(store.resolveTask(id, "1").status, "todo");
		assert.doesNotMatch(store.prepareNotice(id, "lead", 31_000)!.content, /marked done/);
	} finally {
		store.close();
	}
});

test("merge ledger, PR summary key, and consumed notice survive restart and refreshes", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const home = await mkdtemp(join(tmpdir(), "pilot-pr-notices-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const file = join(home, "state.sqlite");
	const { store, id, chat } = setup(file);
	const merged = pr(1, "merged");
	store.addResource(id, { taskId: "1", url: merged.url });
	store.updatePullRequest(merged, [chat]);
	store.close();
	const db = new DatabaseSync(file);
	assert.equal(db.prepare("SELECT group_key FROM pending_notice_summaries").get()!.group_key, `pr:${merged.url}`);
	db.close();
	let restarted = new MissionStore(file);
	restarted.recordMemberPullRequests(chat, [merged]);
	const notice = restarted.prepareNotice(id, "lead", 31_000)!;
	assert.equal(notice.content.match(/merged/g)?.length, 1);
	restarted.acknowledgeNotice(notice, 31_000);
	restarted.close();
	restarted = new MissionStore(file);
	const stale = { ...chat, archivedAt: 1, pullRequest: pr(1, "open") };
	const sessions = {
		list: () => [stale],
		get: (id: string) => (id === chat.id ? stale : undefined),
		ownedPullRequests: (id: string) => (id === chat.id ? [stale.pullRequest] : []),
		onChange: () => () => {},
	} as unknown as SessionManager;
	const recovery = new MissionNotices(restarted, sessions);
	recovery.start();
	try {
		assert.equal(
			restarted.detail(id).resources[0]!.pullRequest!.state,
			"merged",
			"startup prefers the durable linked cache over stale archived metadata",
		);
		restarted.updatePullRequest({ ...merged, checkedAt: 50_000 }, [chat]);
		restarted.recordMemberCompletion({ ...chat, outcome: "done", outcomeAt: 50_000, pullRequest: merged }, true);
		const later = restarted.prepareNotice(id, "lead", 80_000);
		assert.ok(!later || !later.content.includes("merged"));
	} finally {
		await recovery.stop();
		restarted.close();
	}
});

test("upgrade consumes terminal PRs already included in legacy outcome signatures", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const home = await mkdtemp(join(tmpdir(), "pilot-pr-upgrade-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const file = join(home, "state.sqlite");
	const { store, id, chat } = setup(file);
	const merged = pr(1, "merged");
	store.recordMemberCompletion({ ...chat, outcome: "done", outcomeAt: 1_001, pullRequest: merged });
	store.acknowledgeNotice(store.prepareNotice(id, "lead", 31_000)!, 31_000);
	store.close();
	const db = new DatabaseSync(file);
	db.exec("DROP TABLE pull_request_transitions");
	db.close();
	const upgraded = new MissionStore(file);
	try {
		upgraded.recordMemberPullRequests(chat, [merged]);
		assert.deepEqual(upgraded.noticeDeadlines(31_000), []);
	} finally {
		upgraded.close();
	}
});

test("PR notice respects the oldest-event safety cap but never interrupts the receiving chat", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id, chat } = setup();
	let leadBusy = true;
	let sent = 0;
	const sessions = {
		list: () => [],
		get: (id: string) => ({ ...chat, id, state: "working" }),
		onChange: () => () => {},
		canSendNotice: () => !leadBusy,
		sendNotice: async () => {
			sent++;
			return true;
		},
	} as unknown as SessionManager;
	const delivery = new MissionNotices(store, sessions);
	delivery.start();
	try {
		store.updatePullRequest(pr(1, "merged"), [chat]);
		t.mock.timers.tick(NOTICE_MAX_DELAY_MS - 1);
		await delivery.flush();
		assert.equal(sent, 0);
		t.mock.timers.tick(1);
		await delivery.flush();
		assert.equal(sent, 0);
		leadBusy = false;
		await delivery.flush();
		assert.equal(sent, 1);
	} finally {
		await delivery.stop();
		store.close();
	}
});

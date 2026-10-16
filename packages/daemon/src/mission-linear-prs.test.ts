import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { MissionTaskStatus } from "@pilot/protocol";
import { closingMentions, linearPrGuidance, unavailableClosingGuard } from "./mission-linear-pr-guidance.ts";
import { type LinearPrText, MissionLinearPrChecks, readLinearPrText } from "./mission-linear-prs.ts";
import { MissionStore } from "./missions.ts";

function fixture(t: TestContext, file = ":memory:") {
	const store = new MissionStore(file);
	let closed = false;
	const close = () => {
		if (!closed) {
			closed = true;
			store.close();
		}
	};
	t.after(close);
	const { id } = store.create({ projectId: "p", title: "Deliver" });
	const url = "https://linear.app/acme/issue/ENG-12";
	const manager = store.addResource(id, { url, linearRole: "managed" });
	const a = store.addTask(id, { title: "Earlier", status: "in_progress" });
	const b = store.addTask(id, { title: "Final", status: "in_progress" });
	const ca = store.addResource(id, { url, taskId: a.id, linearRole: "contribution" });
	store.addResource(id, { url, taskId: b.id, linearRole: "contribution" });
	const pr = store.addResource(id, { url: "https://github.com/o/r/pull/12", taskId: b.id });
	return { store, close, id, manager, a, b, ca, pr };
}
const allow = async () => ({ allowed: true });

for (const status of ["todo", "in_progress", "in_review", "blocked", "delegated", "dropped"] as MissionTaskStatus[]) {
	test(`other contributor ${status} blocks closing even for the last planned task`, async (t) => {
		const f = fixture(t);
		f.store.updateTask(f.id, f.a.id, { status });
		const result = await linearPrGuidance(f.store, f.id, f.b.id, () =>
			assert.fail("non-final must not request permission"),
		);
		assert.equal(result.tickets[0]!.closingAllowed, false);
		assert.equal(result.tickets[0]!.directive, "Related to ENG-12");
		assert.match(result.tickets[0]!.reason!, /not Done/);
	});
}

test("only final contributions close, references never do; each ticket is independent", async (t) => {
	const f = fixture(t);
	f.store.updateTask(f.id, f.a.id, { status: "done" });
	const context = f.store.addResource(f.id, { url: "https://linear.app/acme/issue/ENG-13", taskId: f.b.id });
	const result = await linearPrGuidance(f.store, f.id, f.b.id, allow);
	assert.equal(result.tickets[0]!.directive, "Closes ENG-12");
	assert.equal(result.tickets.find((ref) => ref.resourceId === context.id)!.closingAllowed, false);
	for (const reason of [
		"Deployed",
		"Canceled",
		"Duplicated",
		"Manual status pause",
		"Task reopened",
		"Stale observation",
		"Contributor scope changed",
	]) {
		const blocked = await linearPrGuidance(f.store, f.id, f.b.id, async () => ({ allowed: false, reason }));
		assert.equal(blocked.tickets[0]!.closingAllowed, false);
		assert.equal(blocked.tickets[0]!.reason, reason);
	}
	assert.equal(
		(await linearPrGuidance(f.store, f.id, f.b.id, unavailableClosingGuard)).tickets[0]!.closingAllowed,
		false,
	);
	assert.equal(
		(
			await linearPrGuidance(f.store, f.id, f.b.id, async () => {
				throw new Error("offline");
			})
		).tickets[0]!.closingAllowed,
		false,
	);
});

test("eligibility is invalidated if contributors reopen or links change during live verification", async (t) => {
	const f = fixture(t);
	f.store.updateTask(f.id, f.a.id, { status: "done" });
	const result = await linearPrGuidance(f.store, f.id, f.b.id, async () => {
		f.store.updateTask(f.id, f.a.id, { status: "in_progress" });
		return { allowed: true };
	});
	assert.match(result.tickets[0]!.reason!, /changed during/);
	f.store.updateTask(f.id, f.a.id, { status: "done" });
	const detached = await linearPrGuidance(f.store, f.id, f.b.id, async () => {
		f.store.removeResource(f.id, f.ca.id);
		return { allowed: true };
	});
	assert.equal(detached.tickets[0]!.closingAllowed, false);
});

test("closing keyword detection covers Linear variants, URLs and lists but not relation wording", () => {
	const ref = { externalId: "ENG-12", url: "https://linear.app/acme/issue/ENG-12" };
	for (const text of [
		"Closes ENG-12",
		"Fix: ENG-12",
		"Implementing ENG-12",
		"Linear issue ENG-12",
		"Resolves ENG-3, DES-4 and ENG-12",
		"Complete [ENG-12](https://linear.app/acme/issue/ENG-12)",
		"Closes https://linear.app/acme/issue/ENG-12/title",
	])
		assert.ok(closingMentions(text, ref), text);
	for (const text of [
		"Related to ENG-12",
		"Relates to ENG-12",
		"Refs ENG-12",
		"Contributes to ENG-12",
		"Fixes ENG-123",
		"Fixes DES-2; Related to ENG-12",
		"Fixes DES-2. Related to ENG-12",
	])
		assert.equal(closingMentions(text, ref), false, text);
});

test("automatic checks flag premature PR/commit directives and branch triggers, then recheck without editing", async (t) => {
	const f = fixture(t);
	let body = "Closes ENG-12",
		calls = 0;
	const text = (): LinearPrText => ({
		title: "Feature",
		body,
		branch: "feat/eng-12-work",
		commits: ["Fixes ENG-12"],
		complete: true,
	});
	const checker = new MissionLinearPrChecks(
		f.store,
		(id, task) => linearPrGuidance(f.store, id, task, allow),
		() => "/tmp",
		async () => {
			calls++;
			return text();
		},
	);
	t.after(() => checker.stop());
	checker.start();
	await checker.flush();
	assert.equal(calls, 1, "own report does not create repeated remote checks");
	const comments = () => f.store.detail(f.id).comments.filter((comment) => !comment.resolvedAt);
	assert.match(comments()[0]!.text, /premature closing directive/);
	assert.match(comments()[0]!.text, /branch-name linking/);
	f.store.updateTask(f.id, f.a.id, { status: "done" });
	await checker.flush();
	assert.equal(comments().length, 0, "safe final PR resolves only daemon-owned correction flag");
	body = "Related to ENG-12";
	// A local change drives revalidation even without a new GitHub polling interval.
	f.store.updateTask(f.id, f.b.id, { status: "in_review" });
	await checker.flush();
	assert.match(comments()[0]!.text, /final contributor should include Closes/);
	assert.equal(f.store.detail(f.id).resources.find((ref) => ref.id === f.pr.id)?.url, f.pr.url);
});

test("sync safeguard changes recheck existing directives, and unavailable/incomplete reads flag uncertainty", async (t) => {
	const f = fixture(t);
	f.store.updateTask(f.id, f.a.id, { status: "done" });
	let allowed = true,
		complete = true;
	const guard = async () => ({ allowed, reason: "Manual status pause" });
	const checker = new MissionLinearPrChecks(
		f.store,
		(id, task) => linearPrGuidance(f.store, id, task, guard),
		() => "/tmp",
		async () => ({ title: "Closes ENG-12", body: "", branch: "feat/work", commits: [], complete }),
	);
	t.after(() => checker.stop());
	checker.start();
	await checker.flush();
	assert.equal(f.store.detail(f.id).comments.length, 0);
	allowed = false;
	// Future sync fields must participate without a compile-time dependency on that PR.
	const detail = f.store.linearPrScope.bind(f.store);
	t.mock.method(f.store, "linearPrScope", (...args: Parameters<MissionStore["linearPrScope"]>) => {
		const value = detail(...args);
		Object.assign(value.resources.find((ref) => ref.id === f.manager.id)!, {
			linearSync: { state: "paused", reason: "manual_status", updatedAt: Date.now() },
		});
		return value;
	});
	f.store.log(f.id, { text: "Sync changed" });
	await checker.flush();
	assert.match(f.store.detail(f.id).comments.find((comment) => !comment.resolvedAt)!.text, /Manual status pause/);
	complete = false;
	f.store.updateTask(f.id, f.b.id, { status: "in_review" });
	await checker.flush();
	assert.match(f.store.detail(f.id).comments.find((comment) => !comment.resolvedAt)!.text, /coverage is incomplete/);
});

test("durable correction flags deduplicate on restart and do not resolve unrelated user questions", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "linear-pr-safety-"));
	const file = join(home, "missions.sqlite");
	const f = fixture(t, file);
	f.store.addComment(f.id, { text: "User question must remain open" });
	f.store.reportLinearPrSafety(f.id, f.pr.id, f.pr.url, ["Premature directive"]);
	await f.store.durable();
	f.close();
	const reopened = new MissionStore(file);
	t.after(async () => {
		await reopened.durable();
		reopened.close();
		await rm(home, { recursive: true, force: true });
	});
	reopened.reportLinearPrSafety(f.id, f.pr.id, f.pr.url, ["Premature directive"]);
	assert.equal(reopened.detail(f.id).comments.length, 2);
	reopened.reportLinearPrSafety(f.id, f.pr.id, f.pr.url, []);
	assert.deepEqual(
		reopened
			.detail(f.id)
			.comments.filter((comment) => !comment.resolvedAt)
			.map((comment) => comment.text),
		["User question must remain open"],
	);
});

test("PR text lookup is read-only, repository qualified, bounded, and reports incomplete commit coverage", async () => {
	const value = {
		title: "Title",
		body: "x".repeat(70_000),
		headRefName: "feat/work",
		commits: { pageInfo: { hasNextPage: true }, nodes: [{ commit: { message: "y".repeat(9000) } }] },
	};
	const result = await readLinearPrText(
		"https://github.com/o/r/pull/42",
		"/tmp",
		new AbortController().signal,
		async (file, args, cwd, timeout, signal) => {
			assert.equal(file, "gh");
			assert.equal(cwd, "/tmp");
			assert.equal(timeout, 20_000);
			assert.ok(signal);
			assert.ok(args.includes("owner=o"));
			assert.ok(args.includes("name=r"));
			assert.ok(args.includes("number=42"));
			assert.doesNotMatch(args.join(" "), /mutation|comments|reviews|--method/);
			return JSON.stringify({ data: { repository: { pullRequest: value } } });
		},
	);
	assert.equal(result.complete, false);
	assert.equal(result.body.length, 65_536);
	assert.equal(result.commits[0]!.length, 8000);
	await assert.rejects(
		readLinearPrText("https://github.com/o/r/pull/42", "/tmp", new AbortController().signal, async () =>
			JSON.stringify({ errors: [{ message: "denied" }] }),
		),
		/Invalid/,
	);
	await assert.rejects(
		readLinearPrText("https://evil.test/o/r/pull/42", "/tmp", new AbortController().signal, async () =>
			assert.fail("invalid origin must not run a process"),
		),
		/Invalid/,
	);
});

test("detaching a task does not hide its existing closing directive for a still-managed ticket", async (t) => {
	const f = fixture(t);
	f.store.updateTask(f.id, f.a.id, { status: "done" });
	const checker = new MissionLinearPrChecks(
		f.store,
		(id, task) => linearPrGuidance(f.store, id, task, allow),
		() => "/tmp",
		async () => ({ title: "Closes ENG-12", body: "", branch: "feat/work", commits: [], complete: true }),
	);
	t.after(() => checker.stop());
	checker.start();
	await checker.flush();
	const contribution = f.store
		.detail(f.id)
		.resources.find((ref) => ref.taskId === f.b.id && ref.linearRole === "contribution")!;
	f.store.removeResource(f.id, contribution.id);
	await checker.flush();
	assert.match(
		f.store.detail(f.id).comments.find((comment) => !comment.resolvedAt)!.text,
		/No explicit task contribution/,
	);
});

test("large-session streaming events coalesce without reads on the event path", async (t) => {
	const f = fixture(t);
	f.store.batchChanges(() => {
		for (let i = 0; i < 1000; i++) f.store.addTask(f.id, { title: `Unrelated ${i}`, body: "x".repeat(8000) });
	});
	let changed!: (id: string) => void,
		calls = 0;
	t.mock.method(f.store, "onChange", (callback: (id: string) => void) => {
		changed = callback;
		return () => {};
	});
	const checker = new MissionLinearPrChecks(
		f.store,
		(id, task) => linearPrGuidance(f.store, id, task, allow),
		() => "/tmp",
		async () => {
			calls++;
			return { title: "Related to ENG-12", body: "", branch: "feat/work", commits: [], complete: true };
		},
	);
	t.after(() => checker.stop());
	checker.start();
	await checker.flush();
	let reads = 0;
	t.mock.method(f.store, "detail", () => assert.fail("PR safety must not read task bodies, history or comments"));
	const detail = f.store.linearPrScope.bind(f.store);
	t.mock.method(f.store, "linearPrScope", (...args: Parameters<MissionStore["linearPrScope"]>) => {
		reads++;
		return detail(...args);
	});
	const start = performance.now();
	for (let i = 0; i < 10_000; i++) changed(f.id);
	const eventMs = performance.now() - start;
	assert.equal(reads, 0);
	assert.equal(calls, 1);
	await checker.flush();
	assert.equal(calls, 1, "no new PR observation or ticket-scope changes, no remote work");
	t.diagnostic(
		`1000 unrelated 8KB tasks, 10000 streaming events: ${eventMs.toFixed(2)}ms event handling, ${reads} coalesced detail read(s), zero additional network reads`,
	);
});

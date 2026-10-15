// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without forking a kernel or making them public.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand } from "@pilot/kernel";
import type { SessionPullRequest } from "@pilot/protocol";
import { githubRepository } from "./github.ts";
import { ProjectStore } from "./projects.ts";
import { mergeReadiness } from "./pull-request-readiness.ts";
import type { PullRequestResult } from "./pull-requests.ts";
import { CommandRejected, SessionManager, type SessionWorker, WorkerUnavailable } from "./sessions.ts";
import { legacyGitHub } from "./testing/legacy-github.ts";
import type { Runner } from "./workspaces.ts";

type Meta = Parameters<SessionManager["save"]>[0];
type Input = Extract<KernelCommand, { type: "input" }>;
const url = "https://github.com/octo/repo/pull/10";
const branch = "fix-pr-follow-ups";
const cooldown = 1_000;

async function bindingProject(f: Awaited<ReturnType<typeof setup>>) {
	const project = await f.manager["projects"].create({ path: f.home });
	for (const meta of f.manager["metas"].values()) meta.projectId = project.id;
	return project;
}

test("bound arbitrary heads receive follow-ups; unbinding suppresses rediscovery and rebinding restores ownership", async () => {
	await fixture(async (f) => {
		await bindingProject(f);
		f.controls.checks = false;
		f.controls.reviews = false;
		f.controls.conflicts = false;
		const other: SessionPullRequest = {
			number: 12,
			url: "https://github.com/octo/repo/pull/12",
			title: "Hand-built",
			state: "open",
			checkedAt: 1,
			branch: "feat/elsewhere",
		};
		f.controls.others = [other];
		f.controls.healthOutputs.set(
			12,
			JSON.stringify({
				state: "OPEN",
				headRefName: other.branch,
				statusCheckRollup: [{ __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "FAILURE" }],
				mergeable: "MERGEABLE",
			}),
		);
		await f.manager.bindPullRequest(f.id, other.url);
		await f.refresh();
		await Promise.allSettled(f.manager["starting"].values());
		assert.ok(f.manager.get(f.id)?.pullRequests?.some((pr) => pr.url === other.url));
		assert.equal(f.inputs.length, 1);
		assert.match(f.inputs[0]!.content, /feat\/elsewhere/);
		assert.ok(f.meta.boundPullRequests?.includes(other.url));
		await f.manager.unbindPullRequest(f.id, other.url);
		await f.manager.unbindPullRequest(f.id, other.url);
		f.meta.prFollowUp = undefined;
		await f.refresh();
		await f.apply({ others: [other] }); // An already-running lookup is also revoked.
		assert.equal(f.inputs.length, 1);
		assert.ok(!f.manager.get(f.id)?.pullRequests?.some((pr) => pr.url === other.url));
		assert.deepEqual((await f.saved()).unboundPullRequests, [other.url]);
		await f.manager.bindPullRequest(f.id, other.url);
		await f.refresh();
		await Promise.allSettled(f.manager["starting"].values());
		assert.equal(f.inputs.length, 2);
		assert.deepEqual(f.meta.unboundPullRequests, []);
		assert.deepEqual(f.meta.boundPullRequests, [other.url]);
	});
});

test("binding moves discovered ownership and rejects URLs outside the project repository", async () => {
	await fixture(async (f) => {
		await bindingProject(f);
		const previous = [...f.manager["metas"].values()].find((meta) => meta.id !== f.id)!;
		previous.agentPullRequests = [url];
		previous.pullRequest = { number: 10, url, title: "Wrongly attached", state: "open", checkedAt: 1, branch };
		delete f.meta.agentPullRequests;
		await f.manager.bindPullRequest(f.id, url);
		assert.deepEqual(previous.unboundPullRequests, [url]);
		assert.deepEqual(previous.agentPullRequests, []);
		assert.equal(previous.pullRequest, undefined);
		await f.manager["applyPullRequest"](previous, {
			pullRequest: { number: 10, url, title: "Stale", state: "open", checkedAt: 1, branch },
		});
		assert.equal(previous.pullRequest, undefined);
		assert.equal(f.manager["pullRequestOwner"](url), f.id);
		for (const bad of [
			"https://github.com/other/repo/pull/10",
			"https://example.com/octo/repo/pull/10",
			"https://github.com/octo/repo/issues/10",
			"https://github.com/octo/repo/pull/10?x=1",
		]) {
			await assert.rejects(f.manager.bindPullRequest(f.id, bad), /project repository|GitHub pull request URL/);
		}
		await f.manager.bindPullRequest(f.id, url);
		assert.deepEqual(f.meta.boundPullRequests, [url]);
		assert.deepEqual((await f.saved()).boundPullRequests, [url]);
	});
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function until(check: () => boolean) {
	for (let i = 0; i < 500 && !check(); i++) await delay(2);
	assert.ok(check(), "condition did not settle");
}

function activity(meta: Meta) {
	return {
		updatedAt: meta.updatedAt,
		lastUserMessageAt: meta.lastUserMessageAt,
		outcome: meta.outcome,
		outcomeAt: meta.outcomeAt,
		lastOutcomeAt: meta.lastOutcomeAt,
		lastCompletionAt: meta.lastCompletionAt,
	};
}

async function fixture(
	run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
	cooldownMs: number | null = cooldown,
) {
	const f = await setup(cooldownMs ?? undefined);
	try {
		await run(f);
	} finally {
		await f.manager.shutdown();
		await rm(f.home, { recursive: true, force: true });
	}
}

async function setup(cooldownMs?: number) {
	const home = await mkdtemp(join(tmpdir(), "pilot-pr-follow-ups-"));
	const id = randomUUID();
	const cwd = join(home, "sessions", id, "workspace");
	const initial: Meta = {
		id,
		title: "Private PR",
		cwd,
		createdAt: 1,
		updatedAt: 2,
		lastUserMessageAt: 1,
		workspace: { source: home, branch, upstream: "git@github.com:octo/repo.git", base: "origin/main", jj: false },
		working: false,
		outcome: "done",
		outcomeAt: 1,
		lastOutcomeAt: 1,
		lastCompletionAt: 1,
	};
	await mkdir(cwd, { recursive: true });
	await writeFile(join(home, "sessions", id, "meta.json"), JSON.stringify(initial));
	const otherId = randomUUID();
	await mkdir(join(home, "sessions", otherId));
	await writeFile(
		join(home, "sessions", otherId, "meta.json"),
		// The other session owns the PR during load, so the first sweep cannot claim it for this one.
		JSON.stringify({ id: otherId, title: "Other", cwd: home, createdAt: 1, updatedAt: 3, agentPullRequests: [url] }),
	);
	const controls = {
		checks: true,
		reviews: true,
		conflicts: true,
		draft: false,
		state: "OPEN",
		mergeable: undefined as string | undefined,
		listError: false,
		viewError: false,
		graphqlError: false,
		viewOutput: undefined as string | undefined,
		graphqlOutput: undefined as string | undefined,
		healthGate: undefined as ReturnType<typeof deferred> | undefined,
		healthCalls: 0,
		graphqlCalls: 0,
		request: undefined as ((command: Input) => Promise<void>) | undefined,
		others: [] as SessionPullRequest[],
		healthOutputs: new Map<number, string | Error>(),
		healthNumbers: [] as number[],
	};
	const inputs: Input[] = [];
	const runner: Runner = async (file, args) => {
		if (file === "git" && args[0] === "branch") return branch;
		assert.equal(file, "gh", `unexpected command: ${file} ${args.join(" ")}`);
		if (args[0] === "pr" && args[1] === "list") {
			if (controls.listError) throw new Error("GitHub list offline");
			const head = args.find((arg) => arg.startsWith("--head="))?.slice(7);
			if (head !== branch) {
				const pr = controls.others.find((pr) => pr.branch === head);
				if (!pr || (args.includes("--state=open") && (pr.state === "merged" || pr.state === "closed"))) return "[]";
				return JSON.stringify([
					{
						...pr,
						state: pr.state === "draft" ? "OPEN" : pr.state.toUpperCase(),
						isDraft: pr.state === "draft",
						headRefName: pr.branch,
						isCrossRepository: false,
						createdAt: "2026-01-01T00:00:00Z",
						mergedAt: new Date(Date.now()).toISOString(),
					},
				]);
			}
			if (args.includes("--state=open") && controls.state !== "OPEN") return "[]";
			return JSON.stringify([
				{
					number: 10,
					url,
					title: "Fix the PR",
					state: controls.state,
					isDraft: controls.draft,
					headRefName: branch,
					isCrossRepository: false,
					createdAt: "2026-01-01T00:00:00Z",
					mergedAt: new Date(Date.now()).toISOString(),
				},
			]);
		}
		if (args[0] === "pr" && args[1] === "view" && args.some((arg) => arg.includes("isCrossRepository"))) {
			// Known PRs are looked up by number.
			if (controls.listError) throw new Error("GitHub list offline");
			const number = Number(args[2]);
			const other = controls.others.find((pr) => pr.number === number);
			return JSON.stringify({
				number,
				url: other?.url ?? url,
				title: other?.title ?? "Fix the PR",
				state: other ? (other.state === "draft" ? "OPEN" : other.state.toUpperCase()) : controls.state,
				isDraft: other ? other.state === "draft" : controls.draft,
				headRefName: other?.branch ?? branch,
				isCrossRepository: false,
				createdAt: "2026-01-01T00:00:00Z",
				mergedAt: new Date(Date.now()).toISOString(),
			});
		}
		if (args[0] === "pr" && args[1] === "view") {
			controls.healthCalls++;
			controls.healthNumbers.push(Number(args[2]));
			await controls.healthGate?.promise;
			if (controls.viewError) throw new Error("GitHub checks offline");
			const output = controls.healthOutputs.get(Number(args[2]));
			if (output instanceof Error) throw output;
			if (output !== undefined) return output;
			return (
				controls.viewOutput ??
				JSON.stringify({
					state: controls.others.some((pr) => pr.number === Number(args[2])) ? "OPEN" : controls.state,
					headRefName: controls.others.find((pr) => pr.number === Number(args[2]))?.branch ?? branch,
					statusCheckRollup: controls.checks
						? [{ __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "FAILURE" }]
						: [],
					mergeable: controls.mergeable ?? (controls.conflicts ? "CONFLICTING" : "MERGEABLE"),
				})
			);
		}
		assert.deepEqual(args.slice(0, 2), ["api", "graphql"], "only read-only GitHub queries are allowed");
		controls.graphqlCalls++;
		if (controls.graphqlError) throw new Error("GitHub reviews offline");
		return (
			controls.graphqlOutput ??
			JSON.stringify({
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: controls.reviews
									? [{ id: "thread-1", isResolved: false, isOutdated: false, comments: { totalCount: 1 } }]
									: [],
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					},
				},
			})
		);
	};
	const makeManager = () =>
		new SessionManager(
			home,
			new ProjectStore(home),
			undefined,
			{
				title: async () => undefined,
				worker: (_spec, _onPacket, onExit) => {
					const worker: SessionWorker & { busy: boolean } = {
						ready: Promise.resolve(),
						state: "idle",
						busy: false,
						send: () => {},
						request: async (command) => {
							if (command.type !== "input") return;
							inputs.push(command);
							await controls.request?.(command);
						},
						close: async () => {
							worker.state = "idle";
							onExit(worker, 0);
						},
					};
					return worker;
				},
			},
			{ runner: legacyGitHub(runner), intervalMs: 60 * 60_000 },
			{ prFollowUpCooldownMs: cooldownMs },
		);
	let manager = makeManager();
	await manager.load();
	await manager["pullRequests"].settled();
	// Readiness is fetched on startup even before the PR becomes eligible for follow-ups.
	controls.healthCalls = 0;
	controls.graphqlCalls = 0;
	controls.healthNumbers = [];
	// Ownership is deliberately absent on load, so each test controls the first eligible sweep.
	delete manager["metas"].get(otherId)!.agentPullRequests;
	manager["metas"].get(id)!.agentPullRequests = [url];
	return {
		home,
		id,
		/** A PR owned by another session can never be claimed by this one. */
		ownElsewhere: (...urls: string[]) => {
			manager["metas"].get(otherId)!.agentPullRequests = urls;
		},
		controls,
		inputs,
		get manager() {
			return manager;
		},
		get meta() {
			return manager["metas"].get(id)!;
		},
		worker: async () => (await manager["ensureWorker"](id)) as SessionWorker & { busy: boolean | undefined },
		// Follow-up delivery runs detached from the PR sync. Wait for it too.
		refresh: async () => {
			await manager["pullRequests"].refresh(manager["metas"].get(id)!);
			await Promise.allSettled(manager["starting"].values());
		},
		saved: async (): Promise<Meta> => JSON.parse(await readFile(join(home, "sessions", id, "meta.json"), "utf8")),
		/** Apply a hand-made discovery result through the sync's health lookup, as one sync job would. */
		apply: async (result: PullRequestResult) => {
			const meta = manager["metas"].get(id)!;
			await manager["pullRequests"]["applyResults"]([
				{ key: id, session: meta, result, repo: githubRepository(meta.workspace!.upstream!) },
			]);
			await Promise.allSettled(manager["starting"].values());
		},
		settle: async () => {
			await manager["pullRequests"].settled();
			await manager["pullRequests"].refresh(manager["metas"].get(id)!);
			await Promise.allSettled(manager["starting"].values());
			await Promise.all(manager["saving"].values());
		},
		working: (working: boolean) => {
			const worker = manager["workers"].get(id)!;
			assert.ok(worker, "activity requires a live worker");
			worker.state = working ? "working" : "idle";
			manager["onPacket"](manager["metas"].get(id)!, worker, { type: "working", working });
		},
		restart: async () => {
			await manager.shutdown();
			manager = makeManager();
			await manager.load();
			await manager["pullRequests"].settled();
			await Promise.all(manager["starting"].values());
		},
	};
}

test("owned open and draft PRs reopen parked workers with one durable idle-only follow-up and no user activity", async () => {
	for (const draft of [false, true]) {
		await fixture(async (f) => {
			f.controls.draft = draft;
			const before = activity(f.meta);
			const order = f.manager.list().map((session) => session.id);
			assert.equal(f.manager["workers"].size, 0);
			f.controls.request = async (command) => {
				const persisted = await f.saved();
				assert.equal(persisted.prFollowUp?.attempts, 1);
				assert.equal(persisted.prFollowUp?.requestId, command.requestId);
				assert.deepEqual(persisted.pending, [command], "persist before sending to the kernel");
			};
			await f.refresh();
			assert.equal(f.inputs.length, 1);
			const input = f.inputs[0]!;
			assert.equal(input.mode, "followUp");
			assert.equal(input.onlyIfIdle, true);
			assert.match(input.content, /automatic PR follow-up \(1\/3\)/);
			assert.ok(input.content.includes(url));
			assert.match(input.content, /Failed CI checks:.*tests/);
			assert.match(input.content, /1 unresolved, non-outdated review thread/);
			assert.match(input.content, /merge conflicts/);
			assert.match(input.content, /flaky\/infra/);
			assert.match(input.content, /untrusted data/);
			assert.match(input.content, /Never comment, review, reply, merge, or close on GitHub/);
			assert.deepEqual(activity(f.meta), before);
			assert.deepEqual(
				f.manager.list().map((session) => session.id),
				order,
			);
			assert.deepEqual(f.meta.pending, []);
			assert.equal((await f.saved()).lastUserMessageAt, before.lastUserMessageAt);
			f.working(true);
			assert.ok(f.meta.updatedAt > before.updatedAt, "only worker activity reorders the session");
			assert.equal(f.meta.lastUserMessageAt, before.lastUserMessageAt);
			f.working(false);
			await f.settle();
			assert.equal(f.inputs.length, 1);
		});
	}
});

test("all PR problems share three attempts, and the cooldown starts after worker completion", async (t) => {
	let now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	await fixture(async (f) => {
		for (const [index, problem] of ["checks", "reviews", "conflicts"].entries()) {
			f.controls.checks = problem === "checks";
			f.controls.reviews = problem === "reviews";
			f.controls.conflicts = problem === "conflicts";
			await f.refresh();
			assert.equal(f.inputs.length, index + 1);
			assert.equal(f.manager.get(f.id)?.attentionReason, undefined, "automatic work has not finished");
			assert.equal(f.meta.prFollowUp?.attempts, index + 1);
			f.working(true);
			now += cooldown * 2;
			await f.refresh();
			assert.equal(f.inputs.length, index + 1, "long-running fixes do not admit another input");
			f.working(false);
			await f.settle();
			assert.equal(f.meta.prFollowUp?.nextAttemptAt, now + cooldown);
			now += cooldown - 1;
			await f.refresh();
			assert.equal(f.manager.get(f.id)?.attentionReason, undefined, "cooling follow-ups never need the user");
			assert.equal(f.inputs.length, index + 1, "cooldown is measured from finish, not admission");
			now++;
		}
		await f.refresh();
		assert.equal(f.inputs.length, 3);
		assert.deepEqual(f.manager.get(f.id)?.attentionReason, { kind: "pr_stuck", detail: "PR #10 · merge conflicts" });
		const attempts = f.meta.prFollowUp;
		await f.restart();
		assert.deepEqual(f.meta.prFollowUp, attempts);
		assert.deepEqual(f.meta.agentPullRequests, [url]);
		assert.equal(f.manager["workers"].size, 0, "the persisted cap prevents reopening after restart");
		assert.equal(f.inputs.length, 3);
		assert.equal(
			f.manager.get(f.id)?.attentionReason?.kind,
			"pr_stuck",
			"derived again from persisted health/budget",
		);
	});
});

test("each fresh PR problem needs the user only after the budget, and fixes and user input clear it", async () => {
	await fixture(async (f) => {
		f.meta.prFollowUp = { attempts: 3, nextAttemptAt: 0, generation: 0 };
		const before = activity(f.meta);
		for (const [problem, detail] of [
			["checks", "checks failing"],
			["reviews", "1 review thread"],
			["conflicts", "merge conflicts"],
		] as const) {
			f.controls.checks = problem === "checks";
			f.controls.reviews = problem === "reviews";
			f.controls.conflicts = problem === "conflicts";
			f.controls.draft = problem === "reviews";
			await f.refresh();
			assert.deepEqual(f.manager.get(f.id)?.attentionReason, { kind: "pr_stuck", detail: `PR #10 · ${detail}` });
			assert.equal(f.manager.get(f.id)?.pullRequest?.readiness?.state, "blocked");
			assert.equal(f.inputs.length, 0);
			assert.deepEqual(activity(f.meta), before, "PR attention is not an outcome or user activity");
		}
		f.controls.conflicts = false;
		await f.refresh();
		assert.equal(f.manager.get(f.id)?.attentionReason, undefined, "fresh healthy status clears it");
		f.controls.checks = true;
		await f.refresh();
		assert.equal(f.manager.get(f.id)?.attentionReason?.kind, "pr_stuck");
		await f.manager.send(f.id, "Try another approach", "followUp", "reset-stuck");
		assert.equal(f.meta.prFollowUp?.attempts, 0);
		assert.equal(f.manager.get(f.id)?.attentionReason, undefined, "user input immediately resets attention");
		await f.refresh();
		assert.equal(f.meta.prFollowUp?.attempts, 1);
		assert.equal(f.manager.get(f.id)?.attentionReason, undefined);
	});
});

test("stuck PRs require ownership and true idle, never sleep/update pauses, jobs or pending work", async () => {
	await fixture(async (f) => {
		f.meta.prFollowUp = { attempts: 3, nextAttemptAt: 0, generation: 0 };
		await f.refresh();
		const manager = f.manager;
		const meta = f.meta;
		const worker = await f.worker();
		const cases: [string, () => void, () => void][] = [
			["working", () => (worker.state = "working"), () => (worker.state = "idle")],
			["busy", () => (worker.busy = true), () => (worker.busy = false)],
			[
				"job",
				() =>
					(worker.runningJobs = [
						{ id: "j", name: "Tests", state: "running", startedAt: Date.now(), outputPath: "/tmp/j" },
					]),
				() => delete worker.runningJobs,
			],
			["job follow-up gap", () => (worker.awaitingJobFollowUp = true), () => delete worker.awaitingJobFollowUp],
			[
				"pending input",
				() =>
					(meta.pending = [
						{ type: "input", requestId: "auto", content: "Fix", mode: "followUp", onlyIfIdle: true },
					]),
				() => delete meta.pending,
			],
			[
				"cooldown",
				() => (meta.prFollowUp!.nextAttemptAt = Date.now() + 60_000),
				() => (meta.prFollowUp!.nextAttemptAt = 0),
			],
			["sleep marker", () => (meta.sleepPaused = true), () => delete meta.sleepPaused],
			["sleep gate", () => (manager["sleepPause"] = { since: 1 }), () => (manager["sleepPause"] = undefined)],
			["update marker", () => (meta.updatePaused = true), () => delete meta.updatePaused],
			[
				"update gate",
				() => {
					manager["updateGate"].pause();
				},
				() => manager["updateGate"].release(),
			],
			["kernel recovery", () => (meta.kernelRestartPending = true), () => delete meta.kernelRestartPending],
			["startup", () => (meta.initializing = true), () => delete meta.initializing],
			["failure", () => (meta.outcome = "failed"), () => (meta.outcome = "done")],
			["asks", () => (meta.outcome = "question"), () => (meta.outcome = "done")],
			["unowned", () => (meta.agentPullRequests = []), () => (meta.agentPullRequests = [url])],
			["archived", () => (meta.archivedAt = 1), () => delete meta.archivedAt],
		];
		for (const [label, start, stop] of cases) {
			try {
				start();
				assert.equal(manager.get(f.id)?.attentionReason, undefined, label);
			} finally {
				stop();
			}
		}
		assert.equal(manager.get(f.id)?.attentionReason?.kind, "pr_stuck");
		meta.prFollowUp!.attempts = 2;
		assert.equal(manager.get(f.id)?.attentionReason, undefined);
		// An owned PR with no automatic route should not silently disappear into Recent.
		meta.cancelled = true;
		assert.equal(manager.get(f.id)?.attentionReason?.kind, "pr_stuck");
	});
});

test("a diverged stack uses the cached health, but a closed or merged PR never needs attention", async () => {
	await fixture(async (f) => {
		f.meta.prFollowUp = { attempts: 3, nextAttemptAt: 0, generation: 0 };
		const pr: SessionPullRequest = {
			number: 10,
			url,
			title: "Stack head",
			branch,
			checkedAt: 1,
			state: "open",
			readiness: mergeReadiness(
				{ state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: null, mergeStateStatus: "CLEAN" },
				{ failedChecks: [], reviewComments: 0, mergeConflicts: false, divergedFrom: "feat/base" },
				false,
			),
		};
		await f.manager["applyPullRequest"](f.meta, { pullRequest: pr });
		assert.deepEqual(f.manager.get(f.id)?.attentionReason, {
			kind: "pr_stuck",
			detail: "PR #10 · diverged from feat/base",
		});
		for (const state of ["closed", "merged"] as const) {
			await f.manager["applyPullRequest"](f.meta, { pullRequest: { ...pr, state } });
			assert.equal(f.manager.get(f.id)?.attentionReason, undefined);
		}
	});
});

function stackPr(number: number, state: SessionPullRequest["state"] = "draft"): SessionPullRequest {
	return {
		number,
		url: `https://github.com/octo/repo/pull/${number}`,
		title: `Stack PR ${number}`,
		branch: `feat/stack-${number}`,
		state,
		checkedAt: 1,
	};
}

test("one follow-up covers all fresh owned stack heads, even when the current PR is closed", async () => {
	await fixture(async (f) => {
		const prs = [stackPr(11), stackPr(12), stackPr(13), stackPr(14, "closed")];
		f.controls.state = "CLOSED";
		f.controls.others = prs;
		f.meta.previousPullRequests = prs;
		f.meta.agentPullRequests = [url, ...prs.filter((pr) => pr.number !== 13).map((pr) => pr.url)];
		f.ownElsewhere(prs[2]!.url);
		const before = activity(f.meta);
		await f.refresh();
		assert.equal(f.inputs.length, 1);
		assert.deepEqual(f.controls.healthNumbers.sort(), [11, 12, 13], "unowned PRs still get display readiness");
		for (const pr of prs.slice(0, 2)) {
			assert.ok(f.inputs[0]!.content.includes(pr.url));
			assert.ok(f.inputs[0]!.content.includes(pr.branch!));
		}
		assert.ok(!f.inputs[0]!.content.includes(prs[2]!.url));
		assert.ok(!f.inputs[0]!.content.includes(prs[3]!.url));
		assert.equal(f.meta.workspace?.branch, branch, "daemon must not switch the workspace to an earlier PR");
		assert.equal(f.meta.prFollowUp?.attempts, 1, "the stack uses one shared reservation");
		assert.deepEqual(activity(f.meta), before);
	});
});

test("current and earlier problems share one prompt, while healthy or unfreshed cached heads stay out", async () => {
	await fixture(async (f) => {
		const prs = [stackPr(11), stackPr(12), stackPr(13)];
		f.controls.others = prs;
		f.meta.previousPullRequests = prs;
		f.meta.agentPullRequests = [url, ...prs.map((pr) => pr.url)];
		f.controls.healthOutputs.set(
			12,
			JSON.stringify({ state: "OPEN", headRefName: prs[1]!.branch, statusCheckRollup: [], mergeable: "MERGEABLE" }),
		);
		f.controls.reviews = false;
		await f.apply({ pullRequest: f.meta.pullRequest, others: prs.slice(0, 2) });
		assert.equal(f.inputs.length, 1);
		for (const target of [url, prs[0]!.url]) assert.ok(f.inputs[0]!.content.includes(target));
		for (const pr of prs.slice(1)) assert.ok(!f.inputs[0]!.content.includes(pr.url));
		assert.deepEqual(
			f.controls.healthNumbers.sort((a, b) => a - b),
			[10, 11, 12],
		);
		assert.equal(f.meta.prFollowUp?.attempts, 1);
	});
});

test("closed-current stacks keep polling across restart without bypassing cooldown or the shared cap", async (t) => {
	let now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	await fixture(async (f) => {
		const prs = [stackPr(11), stackPr(12)];
		f.controls.state = "CLOSED";
		f.controls.others = prs;
		f.meta.previousPullRequests = prs;
		f.meta.agentPullRequests = prs.map((pr) => pr.url);
		await f.refresh();
		assert.equal(f.inputs.length, 1);
		await f.restart();
		assert.equal(f.inputs.length, 1, "restart preserves the cooldown");
		for (let attempt = 2; attempt <= 3; attempt++) {
			now += cooldown;
			await f.refresh();
			assert.equal(f.inputs.length, attempt);
			assert.equal(f.meta.prFollowUp?.attempts, attempt);
			for (const pr of prs) assert.ok(f.inputs.at(-1)!.content.includes(pr.url));
		}
		now += cooldown;
		const calls = f.controls.healthCalls;
		await f.restart();
		assert.equal(f.inputs.length, 3);
		assert.equal(f.controls.healthCalls, calls + 2, "exhausted budget still refreshes display readiness");
	});
});

test("a failed or stale earlier head cannot hide actionable problems on another owned PR", async (t) => {
	t.mock.method(console, "warn", () => {});
	await fixture(async (f) => {
		const prs = [stackPr(11), stackPr(12), stackPr(13)];
		f.controls.state = "CLOSED";
		f.controls.others = prs;
		f.meta.previousPullRequests = prs;
		f.meta.agentPullRequests = prs.map((pr) => pr.url);
		f.controls.healthOutputs.set(11, new Error("GitHub offline"));
		f.controls.healthOutputs.set(12, JSON.stringify({ state: "OPEN", headRefName: "wrong-head" }));
		await f.refresh();
		assert.equal(f.inputs.length, 1);
		assert.ok(f.inputs[0]!.content.includes(prs[2]!.url));
		for (const pr of prs.slice(0, 2)) assert.ok(!f.inputs[0]!.content.includes(pr.url));
	});
});

test("an earlier-only fresh result is eligible without a fresh current PR", async () => {
	await fixture(async (f) => {
		const pr = stackPr(11);
		f.controls.others = [pr];
		f.meta.agentPullRequests = [pr.url];
		await f.apply({ others: [pr] });
		assert.equal(f.inputs.length, 1);
		assert.ok(f.inputs[0]!.content.includes(pr.url));
		assert.deepEqual(f.controls.healthNumbers, [11]);
	});
});

test("user input and branch changes invalidate in-flight stack health", async () => {
	for (const race of ["user", "branch", "ownership", "closed"] as const) {
		await fixture(async (f) => {
			const pr = stackPr(11);
			f.controls.state = "CLOSED";
			f.controls.others = [pr];
			f.meta.previousPullRequests = [pr];
			f.meta.agentPullRequests = [pr.url];
			const gate = deferred();
			f.controls.healthGate = gate;
			const refreshing = f.refresh();
			try {
				await until(() => f.controls.healthCalls === 1);
				if (race === "user") await f.manager.send(f.id, "New work", "followUp", "stack-race");
				else if (race === "branch") f.meta.workspace!.branch = "feat/new-work";
				else if (race === "ownership") {
					f.meta.agentPullRequests = [];
					f.ownElsewhere(pr.url);
				} else f.meta.previousPullRequests = [{ ...pr, state: "closed" }];
				gate.resolve();
				await refreshing;
				assert.equal(f.inputs.filter((input) => input.onlyIfIdle).length, 0, race);
			} finally {
				gate.resolve();
				await refreshing;
			}
		});
	}
});

test("real user input resets the shared budget, cooldown and generation and updates the user timestamp", async (t) => {
	let now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	await fixture(async (f) => {
		f.meta.prFollowUp = { attempts: 3, generation: 7, nextAttemptAt: now + cooldown * 10, requestId: "old-auto" };
		await f.refresh();
		assert.equal(f.inputs.length, 0);
		now++;
		await f.manager.send(f.id, "Please investigate again", "steer");
		assert.deepEqual(f.meta.prFollowUp, { attempts: 0, nextAttemptAt: 0, generation: 8 });
		assert.equal(f.meta.updatedAt, now);
		assert.equal(f.meta.lastUserMessageAt, now);
		assert.equal(f.inputs[0]?.onlyIfIdle, undefined);
		assert.equal(f.inputs[0]?.mode, "steer");
		assert.deepEqual((await f.saved()).prFollowUp, f.meta.prFollowUp);
		await f.refresh();
		assert.equal(f.inputs.length, 2);
		assert.equal(f.meta.prFollowUp?.attempts, 1);
		assert.equal(f.meta.prFollowUp?.generation, 8);
		assert.equal(f.meta.lastUserMessageAt, now);
	});
});

test("accepted user request retries cannot replenish the PR budget, including older IDs after restart and newer input", async (t) => {
	let now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	await fixture(async (f) => {
		const accepted = new Set<string>();
		f.controls.request = async (command) => {
			accepted.add(command.requestId);
		};
		const firstId = "first-accepted-user";
		await f.manager.send(f.id, "Investigate my PR", "followUp", firstId);
		assert.deepEqual(f.meta.prFollowUpResetRequests, [firstId]);
		for (let attempt = 1; attempt <= 3; attempt++) {
			await f.refresh();
			assert.equal(f.meta.prFollowUp?.attempts, attempt);
			if (attempt < 3) now += cooldown;
		}
		const exhausted = structuredClone(f.meta.prFollowUp);
		assert.equal(exhausted?.generation, 1);
		assert.equal(accepted.size, 4);
		now++;
		await f.manager.send(f.id, "Investigate my PR", "followUp", firstId);
		assert.deepEqual(f.meta.prFollowUp, exhausted, "transport retry must preserve attempts, cooldown and generation");
		assert.equal(f.meta.lastUserMessageAt, now, "existing API retry timestamp behavior remains unchanged");
		assert.equal(accepted.size, 4, "the fake durable inbox deduplicates the accepted user request");
		assert.deepEqual((await f.saved()).prFollowUpResetRequests, [firstId]);
		await f.restart();
		assert.deepEqual(f.meta.prFollowUp, exhausted);
		assert.deepEqual(f.meta.prFollowUpResetRequests, [firstId]);
		now += cooldown * 2;
		await f.manager.send(f.id, "Investigate my PR", "followUp", firstId);
		await f.refresh();
		assert.deepEqual(f.meta.prFollowUp, exhausted, "restart and expired cooldown do not make a retry new user work");
		assert.equal(f.inputs.filter((input) => input.onlyIfIdle).length, 3);
		const newerId = "newer-accepted-user";
		await f.manager.send(f.id, "A genuinely new instruction", "followUp", newerId);
		assert.deepEqual(f.meta.prFollowUp, { attempts: 0, nextAttemptAt: 0, generation: 2 });
		await f.refresh();
		const renewed = structuredClone(f.meta.prFollowUp);
		assert.equal(renewed?.attempts, 1);
		assert.equal(renewed?.generation, 2);
		await f.restart();
		now++;
		await f.manager.send(f.id, "Investigate my PR", "followUp", firstId);
		assert.deepEqual(f.meta.prFollowUp, renewed, "an older accepted ID cannot reset a newer user's budget");
		assert.deepEqual(f.meta.prFollowUpResetRequests, [firstId, newerId]);
		const persisted = await f.saved();
		assert.deepEqual(persisted.prFollowUpResetRequests, [firstId, newerId]);
		assert.deepEqual(persisted.prFollowUp, renewed);
		assert.equal(f.meta.lastUserMessageAt, now);
		assert.equal(f.inputs.filter((input) => input.onlyIfIdle).length, 4);
		assert.equal(accepted.size, 6);
	});
});

test("the default five-minute cooldown and ownership persist across restart", async (t) => {
	let now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	await fixture(async (f) => {
		await f.refresh();
		f.working(true);
		now += 10_000;
		f.working(false);
		await f.settle();
		const nextAttemptAt = now + 5 * 60_000;
		assert.equal(f.meta.prFollowUp?.nextAttemptAt, nextAttemptAt);
		await f.restart();
		assert.equal(f.inputs.length, 1);
		assert.equal(f.manager["workers"].size, 0);
		assert.equal(f.meta.prFollowUp?.nextAttemptAt, nextAttemptAt);
		now = nextAttemptAt - 1;
		await f.refresh();
		assert.equal(f.inputs.length, 1);
		now++;
		await f.refresh();
		assert.equal(f.inputs.length, 2);
		assert.equal(f.meta.prFollowUp?.attempts, 2);
	}, null);
});

test("failed, malformed, unknown and stale GitHub health never consume an attempt", async (t) => {
	t.mock.method(console, "warn", () => {});
	await fixture(async (f) => {
		const before = activity(f.meta);
		const cases: [string, () => void, () => void][] = [
			["stale listing", () => (f.controls.listError = true), () => (f.controls.listError = false)],
			["failed checks query", () => (f.controls.viewError = true), () => (f.controls.viewError = false)],
			["failed reviews query", () => (f.controls.graphqlError = true), () => (f.controls.graphqlError = false)],
			["invalid checks JSON", () => (f.controls.viewOutput = "{"), () => delete f.controls.viewOutput],
			["missing health fields", () => (f.controls.viewOutput = "{}"), () => delete f.controls.viewOutput],
			[
				"unknown check variant",
				() =>
					(f.controls.viewOutput = JSON.stringify({
						state: "OPEN",
						headRefName: branch,
						statusCheckRollup: [{ __typename: "FutureCheck" }],
						mergeable: "CONFLICTING",
					})),
				() => delete f.controls.viewOutput,
			],
			[
				"PR merged since list",
				() => (f.controls.viewOutput = JSON.stringify({ state: "MERGED" })),
				() => delete f.controls.viewOutput,
			],
			[
				"PR changed head since list",
				() => (f.controls.viewOutput = JSON.stringify({ state: "OPEN", headRefName: "another-branch" })),
				() => delete f.controls.viewOutput,
			],
			["invalid reviews JSON", () => (f.controls.graphqlOutput = "{}"), () => delete f.controls.graphqlOutput],
			[
				"partial GraphQL error",
				() => (f.controls.graphqlOutput = JSON.stringify({ data: {}, errors: [{ message: "offline" }] })),
				() => delete f.controls.graphqlOutput,
			],
			[
				"unknown mergeability without actionable evidence",
				() => {
					f.controls.checks = false;
					f.controls.reviews = false;
					f.controls.mergeable = "UNKNOWN";
				},
				() => {
					f.controls.checks = true;
					f.controls.reviews = true;
					delete f.controls.mergeable;
				},
			],
		];
		for (const [label, start, stop] of cases) {
			try {
				start();
				await f.refresh();
				assert.equal(f.inputs.length, 0, label);
				assert.equal(f.meta.prFollowUp, undefined, label);
				assert.equal(f.manager["workers"].size, 0, label);
				assert.deepEqual(activity(f.meta), before, label);
				assert.equal((await f.saved()).prFollowUp, undefined, label);
			} finally {
				stop();
			}
		}
		await f.refresh();
		assert.equal(f.inputs.length, 1, "queries recover without losing any budget");
	});
});

test("busy, queued, unowned, direct, ask, archived and transitional sessions never get automatic follow-ups", async () => {
	await fixture(async (f) => {
		const manager = f.manager;
		const meta = f.meta;
		const worker = await f.worker();
		const workspace = meta.workspace!;
		const before = activity(meta);
		const cases: [string, () => void, () => void][] = [
			["working metadata", () => (meta.working = true), () => (meta.working = false)],
			["initializing", () => (meta.initializing = true), () => delete meta.initializing],
			["preparing", () => (meta.preparing = { source: meta.cwd }), () => delete meta.preparing],
			[
				"workspace maintenance",
				() => manager["workspaceMaintenance"].set(meta.id, 1),
				() => manager["workspaceMaintenance"].delete(meta.id),
			],
			[
				"workspace recovery",
				() =>
					(meta.workspaceRecovery = {
						phase: "restoring",
						commitId: "commit",
						changeId: "change",
						repository: f.home,
						name: "private",
						path: meta.cwd,
						archiveRef: "refs/pilot/archive/test",
						localConfigs: {},
					}),
				() => delete meta.workspaceRecovery,
			],
			["cancelled", () => (meta.cancelled = true), () => delete meta.cancelled],
			["failed", () => (meta.failure = "failed"), () => delete meta.failure],
			["input error", () => (meta.inputError = "uncertain"), () => delete meta.inputError],
			[
				"queued user input",
				() => (meta.pending = [{ type: "input", requestId: "user", content: "Hi", mode: "followUp" }]),
				() => delete meta.pending,
			],
			["worker starting", () => (worker.state = "starting"), () => (worker.state = "idle")],
			["worker working", () => (worker.state = "working"), () => (worker.state = "idle")],
			["worker failed", () => (worker.state = "failed"), () => (worker.state = "idle")],
			["accepted input busy", () => (worker.busy = true), () => (worker.busy = false)],
			["unknown worker busy", () => (worker.busy = undefined), () => (worker.busy = false)],
			["sending", () => manager["sending"].set(meta.id, 1), () => manager["sending"].delete(meta.id)],
			[
				"starting drain",
				() => manager["starting"].set(meta.id, Promise.resolve(new Map())),
				() => manager["starting"].delete(meta.id),
			],
			[
				"parking",
				() => manager["parking"].set(meta.id, Promise.resolve()),
				() => manager["parking"].delete(meta.id),
			],
			[
				"model change",
				() => manager["changingModels"].set(meta.id, Promise.resolve()),
				() => manager["changingModels"].delete(meta.id),
			],
			[
				"archive transition",
				() =>
					manager["archiveTransitions"].set(meta.id, {
						archived: true,
						promise: Promise.resolve(manager.get(meta.id)!),
					}),
				() => manager["archiveTransitions"].delete(meta.id),
			],
			["archived", () => (meta.archivedAt = 20), () => delete meta.archivedAt],
			["ask", () => (meta.mode = "ask"), () => delete meta.mode],
			["direct workspace", () => delete meta.workspace, () => (meta.workspace = workspace)],
			[
				"PR owned by another session",
				() => {
					meta.agentPullRequests = [];
					f.ownElsewhere(url);
				},
				() => {
					meta.agentPullRequests = [url];
					f.ownElsewhere();
				},
			],
			[
				"different owned PR",
				() => {
					meta.agentPullRequests = ["https://github.com/octo/repo/pull/11"];
					f.ownElsewhere(url);
				},
				() => {
					meta.agentPullRequests = [url];
					f.ownElsewhere();
				},
			],
			["closed PR", () => (f.controls.state = "CLOSED"), () => (f.controls.state = "OPEN")],
			["merged PR", () => (f.controls.state = "MERGED"), () => (f.controls.state = "OPEN")],
		];
		for (const [label, start, stop] of cases) {
			try {
				start();
				await f.refresh();
				assert.equal(f.inputs.length, 0, label);
				assert.equal(meta.prFollowUp, undefined, label);
				assert.deepEqual(activity(meta), before, label);
			} finally {
				stop();
			}
		}
		await f.refresh();
		assert.equal(f.inputs.length, 1, "a proven idle live worker accepts the follow-up");
	});
});

test("the first private session to discover an unowned PR claims it, and a PR has one owner", async () => {
	await fixture(async (f) => {
		// Another session owns it, archived or not: discovery and creation packets cannot take it over.
		delete f.meta.agentPullRequests;
		f.ownElsewhere(url);
		await f.refresh();
		f.manager["onPacket"](f.meta, await f.worker(), { type: "pullRequest.created", url });
		assert.equal(f.meta.agentPullRequests, undefined);
		assert.ok(f.controls.healthCalls > 0, "unowned PR still receives display readiness");
		assert.equal(f.inputs.length, 0);

		// Ask and archived sessions never claim delivery PRs.
		f.ownElsewhere();
		for (const [start, stop] of [
			[() => (f.meta.mode = "ask"), () => delete f.meta.mode],
			[() => (f.meta.archivedAt = 20), () => delete f.meta.archivedAt],
		] as const) {
			start();
			await f.refresh();
			stop();
			assert.equal(f.meta.agentPullRequests, undefined);
		}

		// An unrecognized creation, or a PR the session was asked to take over, is claimed on discovery.
		await f.refresh();
		assert.deepEqual(f.meta.agentPullRequests, [url]);
		assert.deepEqual((await f.saved()).agentPullRequests, [url]);
		assert.equal(f.inputs.length, 1);
		assert.match(f.inputs[0]!.content, /merge conflicts/);
		assert.equal(f.manager["pullRequestOwner"](url), f.id);
	});
});

test("PR-created packets persist ownership only from the current private workspace worker", async () => {
	await fixture(async (f) => {
		delete f.meta.agentPullRequests;
		const before = activity(f.meta);
		const worker = await f.worker();
		const packet = { type: "pullRequest.created" as const, url };
		f.manager["onPacket"](f.meta, { ...worker }, packet);
		assert.equal(f.meta.agentPullRequests, undefined, "stale worker cannot claim a PR");
		f.meta.mode = "ask";
		f.manager["onPacket"](f.meta, worker, packet);
		assert.equal(f.meta.agentPullRequests, undefined, "Ask sessions cannot claim delivery PRs");
		delete f.meta.mode;
		const workspace = f.meta.workspace;
		delete f.meta.workspace;
		f.manager["onPacket"](f.meta, worker, packet);
		assert.equal(f.meta.agentPullRequests, undefined, "shared workspaces cannot claim delivery PRs");
		f.meta.workspace = workspace;
		f.manager["onPacket"](f.meta, worker, packet);
		f.manager["onPacket"](f.meta, worker, packet);
		await Promise.all(f.manager["saving"].values());
		assert.deepEqual(f.meta.agentPullRequests, [url]);
		assert.deepEqual((await f.saved()).agentPullRequests, [url]);
		assert.deepEqual(activity(f.meta), before);
		await f.restart();
		assert.deepEqual(f.meta.agentPullRequests, [url]);
		assert.equal(f.inputs.length, 1, "persisted ownership makes the parked session eligible on restart");
		assert.deepEqual(activity(f.meta), before);
	});
});

test("user input wins a health-fetch race even after the user command has finished admission", async () => {
	await fixture(async (f) => {
		const gate = deferred();
		f.controls.healthGate = gate;
		const refreshing = f.refresh();
		try {
			await until(() => f.controls.healthCalls === 1);
			await f.manager.send(f.id, "My next instruction", "followUp", "real-user");
			assert.equal(f.inputs.length, 1);
			assert.equal(f.inputs[0]?.requestId, "real-user");
			assert.equal((await f.worker()).state, "idle");
			const afterUser = activity(f.meta);
			gate.resolve();
			await refreshing;
			assert.equal(f.inputs.length, 1, "stale health cannot inject after a newer user generation");
			assert.deepEqual(f.meta.prFollowUp, { attempts: 0, nextAttemptAt: 0, generation: 1 });
			assert.deepEqual(activity(f.meta), afterUser);
			delete f.controls.healthGate;
			await f.refresh();
			assert.equal(f.inputs.length, 2, "a genuinely fresh check may start the reset budget");
			assert.equal(f.meta.prFollowUp?.attempts, 1);
			assert.deepEqual(activity(f.meta), afterUser);
		} finally {
			gate.resolve();
			await refreshing;
		}
	});
});

test("busy idle-guard rejection refunds the attempt without recording user activity or an agent failure", async (t) => {
	let now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	await fixture(async (f) => {
		const before = activity(f.meta);
		f.controls.request = async (command) => {
			assert.equal(command.onlyIfIdle, true);
			throw new CommandRejected("Session is busy", "busy");
		};
		await f.refresh();
		assert.equal(f.inputs.length, 1);
		assert.equal(f.meta.prFollowUp?.attempts, 0);
		assert.equal(f.meta.prFollowUp?.requestId, undefined);
		assert.deepEqual(f.meta.pending, []);
		assert.equal(f.meta.inputError, undefined);
		assert.equal(f.meta.failure, undefined);
		assert.deepEqual(activity(f.meta), before);
		assert.equal((await f.saved()).prFollowUp?.attempts, 0);
		delete f.controls.request;
		now += cooldown;
		await f.refresh();
		assert.equal(f.inputs.length, 2);
		assert.equal(f.meta.prFollowUp?.attempts, 1);
		assert.match(f.inputs[1]!.content, /\(1\/3\)/);
		assert.deepEqual(activity(f.meta), before);
	});
});

test("non-busy automatic rejection keeps its attempt and useful input error until real user input resets it", async (t) => {
	let now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	await fixture(async (f) => {
		const before = activity(f.meta);
		const message = "Input transform rejected the automatic follow-up";
		f.controls.request = async (command) => {
			assert.equal(command.onlyIfIdle, true);
			throw new CommandRejected(message);
		};
		await f.refresh();
		assert.equal(f.inputs.length, 1);
		assert.equal(f.meta.prFollowUp?.attempts, 1, "only explicit busy rejections refund attempts");
		assert.equal(f.meta.inputError, message);
		assert.equal(f.manager.get(f.id)?.error, message);
		assert.equal(f.meta.failure, undefined);
		assert.deepEqual(f.meta.pending, []);
		assert.deepEqual(activity(f.meta), before);
		const persisted = await f.saved();
		assert.equal(persisted.prFollowUp?.attempts, 1);
		assert.equal(persisted.inputError, message);
		for (let i = 0; i < 3; i++) {
			now += cooldown * 2;
			await f.refresh();
		}
		assert.equal(f.inputs.length, 1, "expired cooldowns must not loop on input transform rejection");
		await f.restart();
		assert.equal(f.inputs.length, 1, "restart preserves the error and consumed attempt");
		assert.equal(f.meta.prFollowUp?.attempts, 1);
		assert.equal(f.meta.inputError, message);
		delete f.controls.request;
		await f.manager.send(f.id, "Retry after fixing the input transform", "followUp", "user-reset");
		assert.equal(f.inputs[1]?.requestId, "user-reset");
		assert.equal(f.meta.inputError, undefined);
		assert.deepEqual(f.meta.prFollowUp, { attempts: 0, nextAttemptAt: 0, generation: 1 });
		assert.equal(f.meta.lastUserMessageAt, now);
		await f.refresh();
		assert.equal(f.inputs.length, 3);
		assert.equal(f.meta.prFollowUp?.attempts, 1);
		assert.equal(f.meta.prFollowUp?.generation, 1);
		assert.equal(f.meta.lastUserMessageAt, now);
	});
});

test("user input supersedes an automatic reservation blocked in persistence, including stale outbox replay", async (t) => {
	t.mock.method(console, "warn", () => {});
	await fixture(async (f) => {
		const blocked = deferred();
		const release = deferred();
		const save = f.manager["save"].bind(f.manager);
		const registry = f.manager as unknown as { save: (meta: Meta) => Promise<void> };
		let blockOnce = true;
		const mock = t.mock.method(registry, "save", async (meta: Meta) => {
			await save(meta);
			if (blockOnce && meta.pending?.some((command) => command.type === "input" && command.onlyIfIdle)) {
				blockOnce = false;
				blocked.resolve();
				await release.promise;
			}
		});
		const refreshing = f.refresh();
		try {
			await blocked.promise;
			const automatic = (await f.saved()).pending![0]!;
			assert.equal(automatic.type, "input");
			assert.equal(f.inputs.length, 0, "reservation has not reached IPC");
			assert.equal(f.meta.prFollowUp?.attempts, 1);
			await f.manager.send(f.id, "User work takes precedence", "followUp", "new-user");
			assert.deepEqual(
				f.inputs.map((input) => input.requestId),
				["new-user"],
			);
			assert.deepEqual(f.meta.prFollowUp, { attempts: 0, nextAttemptAt: 0, generation: 1 });
			const afterUser = activity(f.meta);
			release.resolve();
			await refreshing;
			assert.equal(f.inputs.length, 1);
			assert.deepEqual(f.meta.pending, []);
			assert.deepEqual(activity(f.meta), afterUser);
			mock.mock.restore();
			// Model a restart with an older automatic outbox snapshot but the newer user generation.
			f.meta.pending = [automatic];
			await save(f.meta);
			f.controls.listError = true;
			await f.restart();
			assert.deepEqual(
				f.inputs.map((input) => input.requestId),
				["new-user"],
			);
			assert.deepEqual(f.meta.pending, [], "invalidated automatic request IDs are dropped on replay");
			assert.deepEqual((await f.saved()).prFollowUp, { attempts: 0, nextAttemptAt: 0, generation: 1 });
			assert.deepEqual(activity(f.meta), afterUser);
		} finally {
			release.resolve();
			await refreshing;
		}
	});
});

test("uncertain admission retains its durable request ID and retries idempotently across restart without another attempt", async (t) => {
	let now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	await fixture(async (f) => {
		const before = activity(f.meta);
		const accepted = new Set<string>();
		let loseAcknowledgement = true;
		f.controls.request = async (command) => {
			accepted.add(command.requestId);
			if (loseAcknowledgement) throw new WorkerUnavailable("lost admission acknowledgement");
		};
		await f.refresh();
		const original = f.inputs[0]!;
		assert.equal(f.meta.prFollowUp?.attempts, 1);
		assert.equal(f.meta.prFollowUp?.requestId, original.requestId);
		assert.deepEqual(f.meta.pending, [original]);
		assert.deepEqual((await f.saved()).pending, [original]);
		assert.equal(f.meta.failure, undefined);
		assert.deepEqual(activity(f.meta), before);
		now += cooldown * 2;
		await f.refresh();
		assert.equal(f.inputs.length, 1, "pending/uncertain admission cannot allocate another attempt");
		loseAcknowledgement = false;
		await f.restart();
		assert.equal(f.inputs.length, 2);
		assert.deepEqual(f.inputs[1], original);
		assert.equal(accepted.size, 1, "the fake durable inbox deduplicates the stable request ID");
		assert.equal(f.meta.prFollowUp?.attempts, 1);
		assert.deepEqual(f.meta.pending, []);
		assert.equal(f.meta.inputError, undefined);
		assert.deepEqual(activity(f.meta), before);
		f.working(true);
		f.working(false);
		await f.settle();
		now += cooldown;
		await f.refresh();
		assert.equal(f.meta.prFollowUp?.attempts, 2);
		assert.equal(accepted.size, 2);
		assert.notEqual(f.inputs[2]?.requestId, original.requestId);
		assert.equal(f.meta.lastUserMessageAt, before.lastUserMessageAt);
	});
});

test("failed follow-up persistence rolls back its reservation and never admits an undurable command", async (t) => {
	t.mock.method(console, "warn", () => {});
	await fixture(async (f) => {
		const before = activity(f.meta);
		const save = f.manager["save"].bind(f.manager);
		const registry = f.manager as unknown as { save: (meta: Meta) => Promise<void> };
		const mock = t.mock.method(registry, "save", async (meta: Meta) => {
			if (meta.pending?.some((command) => command.type === "input" && command.onlyIfIdle))
				throw new Error("disk full");
			await save(meta);
		});
		await f.refresh();
		assert.equal(f.inputs.length, 0);
		assert.equal(f.meta.prFollowUp, undefined);
		assert.deepEqual(f.meta.pending, []);
		assert.equal((await f.saved()).prFollowUp, undefined);
		assert.deepEqual(activity(f.meta), before);
		mock.mock.restore();
		await f.refresh();
		assert.equal(f.inputs.length, 1);
		assert.equal((await f.saved()).prFollowUp?.attempts, 1);
	});
});

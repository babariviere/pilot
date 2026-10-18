import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { KernelCommand } from "@pilot/kernel";
import type { SessionPullRequest } from "@pilot/protocol";
import type { PullRequestProblems } from "./github.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";
import { fixture, git, jj } from "./testing/shared-workspace.ts";
import { type Runner, run } from "./workspaces.ts";

async function setup(conflict = false) {
	const f = fixture();
	const remote = join(f.root, "remote.git");
	git(f.root, "clone", "--bare", f.source, remote);
	jj(f.source, "git", "remote", "add", "origin", remote);
	jj(f.source, "git", "fetch", "--remote", "origin");
	jj(f.source, "bookmark", "track", "main@origin");
	const id = randomUUID();
	const a = await f.store.create(f.source, f.path(id));
	writeFileSync(join(a.path, conflict ? "a.txt" : "feature.txt"), "PR change\n");
	jj(a.path, "commit", "-m", "feature");
	jj(a.path, "bookmark", "create", "fix/feature", "-r", "@-");
	jj(a.path, "git", "push", "--bookmark", "fix/feature");
	const oldHead = git(remote, "rev-parse", "refs/heads/fix/feature");
	writeFileSync(join(f.source, "a.txt"), "base advanced\n");
	jj(f.source, "commit", "-m", "advance main");
	jj(f.source, "bookmark", "set", "main", "-r", "@-");
	jj(f.source, "git", "push", "--bookmark", "main");
	const base = git(remote, "rev-parse", "refs/heads/main");
	// Dirty files and operation heads must not be touched by the daemon.
	writeFileSync(join(a.path, "dirty.txt"), "uncommitted user input\n");
	const operation = jj(a.path, "--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id");
	const prs: SessionPullRequest[] = [
		{
			number: 1,
			url: "https://github.com/octo/repo/pull/1",
			title: "Feature",
			branch: "fix/feature",
			state: "open",
			checkedAt: Date.now(),
			stack: { number: 1, position: 1, size: 1, baseBranch: "main" },
		},
	];
	const bases = new Map([[1, "main"]]);
	const controls = {
		beforeMetadata: undefined as (() => Promise<void>) | undefined,
		beforePush: undefined as (() => Promise<void>) | undefined,
		pushCalls: 0,
		metadataCalls: 0,
	};
	const runner: Runner = async (file, args, ...rest) => {
		if (file === "gh") {
			controls.metadataCalls++;
			await controls.beforeMetadata?.();
			const number = Number(args.find((arg) => arg.startsWith("number="))?.slice(7));
			const pr = prs.find((pr) => pr.number === number)!;
			const branch = bases.get(number)!;
			return JSON.stringify({
				data: {
					repository: {
						defaultBranchRef: { name: "main" },
						pullRequest: {
							state: "OPEN",
							isCrossRepository: false,
							headRefName: pr.branch,
							headRefOid: git(remote, "rev-parse", `refs/heads/${pr.branch}`),
							baseRefName: branch,
							baseRefOid: git(remote, "rev-parse", `refs/heads/${branch}`),
						},
					},
				},
			});
		}
		if (file === "git" && args.includes("push")) {
			controls.pushCalls++;
			await controls.beforePush?.();
		}
		return run(file, args, ...rest);
	};
	const commands: KernelCommand[] = [];
	const home = join(f.root, "daemon");
	await mkdir(join(home, "sessions", id), { recursive: true });
	const manager = new SessionManager(
		home,
		new ProjectStore(home),
		undefined,
		{
			worker: (_spec, _onPacket, onExit) => {
				const worker: SessionWorker = {
					ready: Promise.resolve(),
					busy: false,
					state: "idle",
					send: () => {},
					request: async (command) => {
						commands.push(command);
					},
					close: async () => {
						onExit(worker, 0);
					},
				};
				return worker;
			},
		},
		{ runner },
	);
	const meta = {
		id,
		title: "Restack",
		cwd: a.path,
		createdAt: 1,
		updatedAt: 2,
		workspace: {
			source: f.source,
			upstream: remote,
			base: a.base,
			jj: true,
			shared: a.shared,
			branch: "fix/feature",
		},
		pullRequest: prs[0]!,
		boundPullRequests: [prs[0]!.url],
	};
	manager["metas"].set(id, meta);
	return {
		...f,
		a,
		remote,
		oldHead,
		base,
		operation,
		prs,
		bases,
		controls,
		commands,
		manager,
		meta,
		follow: async (
			problems: PullRequestProblems = {
				failedChecks: [],
				reviewComments: 0,
				mergeConflicts: conflict,
				divergedFrom: "main",
			},
		) => {
			await manager["followUpPullRequests"](meta, "fix/feature", 0, [
				{
					pr: prs[0]!,
					problems,
				},
			]);
			await Promise.all(manager["starting"].values());
		},
		close: async () => {
			await manager.shutdown();
			f.close();
		},
	};
}

for (const scenario of ["clean", "conflict", "current", "reviews"] as const) {
	test(`failed CI on an unstacked PR: ${scenario}`, async () => {
		const f = await setup(scenario === "conflict");
		try {
			delete f.prs[0]!.stack;
			if (scenario === "current") {
				// The PR already contains its current base, so rewriting it cannot help CI.
				git(f.remote, "update-ref", "refs/heads/main", git(f.remote, "rev-parse", `${f.oldHead}^`));
			}
			await f.follow({
				failedChecks: ["tests"],
				reviewComments: scenario === "reviews" ? 1 : 0,
				mergeConflicts: scenario === "conflict",
			});
			const head = git(f.remote, "rev-parse", "refs/heads/fix/feature");
			const meta = f.manager["metas"].get(f.meta.id)!;
			const inputs = f.commands.filter((command) => command.type === "input");
			if (scenario === "clean" || scenario === "reviews") {
				assert.notEqual(head, f.oldHead);
				assert.equal(git(f.remote, "rev-parse", `${head}^`), f.base);
				assert.equal(git(f.remote, "show", `${head}:feature.txt`), "PR change");
				assert.equal(f.controls.pushCalls, 1);
				if (scenario === "reviews") {
					assert.equal(inputs.length, 1);
					assert.match(inputs[0]!.content, /1 unresolved, non-outdated review thread/);
					assert.doesNotMatch(inputs[0]!.content, /Failed CI checks|Automatic rebase skipped|merge conflicts/);
				} else {
					assert.equal(inputs.length, 0, "old-head failures must not wake the agent after a rebase");
					assert.equal(meta.prFollowUp?.attempts ?? 0, 0);
					const saved = JSON.parse(
						readFileSync(join(f.root, "daemon", "sessions", f.meta.id, "meta.json"), "utf8"),
					);
					assert.equal(saved.prFollowUp?.attempts ?? 0, 0);
					assert.equal(saved.prAutoRebases.length, 1);
					// The next health observation still fails: wake the agent, never rewrite on the same base twice.
					await f.follow({ failedChecks: ["tests after rebase"], reviewComments: 0, mergeConflicts: false });
					assert.equal(f.controls.pushCalls, 1);
					const followUps = f.commands.filter((command) => command.type === "input");
					assert.equal(followUps.length, 1);
					assert.match(followUps[0]!.content, /tests after rebase/);
					assert.doesNotMatch(followUps[0]!.content, /"tests"/);
					assert.equal(meta.prFollowUp?.attempts, 1);
				}
			} else {
				assert.equal(head, f.oldHead);
				assert.equal(f.controls.pushCalls, 0);
				assert.equal(inputs.length, 1);
				assert.match(inputs[0]!.content, /Failed CI checks: \["tests"\]/);
				assert.doesNotMatch(inputs[0]!.content, /stacked base branch/);
				if (scenario === "conflict")
					assert.match(inputs[0]!.content, /Automatic rebase skipped: Rebase has conflicts/);
				else assert.doesNotMatch(inputs[0]!.content, /Automatic rebase skipped/);
			}
			assert.equal(readFileSync(join(f.a.path, "dirty.txt"), "utf8"), "uncommitted user input\n");
			assert.equal(
				jj(f.a.path, "--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id"),
				f.operation,
			);
		} finally {
			await f.close();
		}
	});
}

test("review-only feedback does not trigger a rebase", async () => {
	const f = await setup();
	try {
		delete f.prs[0]!.stack;
		await f.follow({ failedChecks: [], reviewComments: 1, mergeConflicts: false });
		assert.equal(f.controls.metadataCalls, 0);
		assert.equal(f.controls.pushCalls, 0);
		assert.equal(git(f.remote, "rev-parse", "refs/heads/fix/feature"), f.oldHead);
		const inputs = f.commands.filter((command) => command.type === "input");
		assert.equal(inputs.length, 1);
		assert.match(inputs[0]!.content, /1 unresolved, non-outdated review thread/);
	} finally {
		await f.close();
	}
});

for (const scenario of ["clean", "conflict", "moved-head"] as const) {
	test(`automatic divergence handling: ${scenario}`, async () => {
		const f = await setup(scenario === "conflict");
		try {
			if (scenario === "moved-head")
				f.controls.beforePush = async () => {
					// Race after the last GitHub read, exercising the actual transport lease.
					git(f.remote, "update-ref", "refs/heads/fix/feature", f.base);
				};
			await f.follow();
			const head = git(f.remote, "rev-parse", "refs/heads/fix/feature");
			const inputs = f.commands.filter((command) => command.type === "input");
			if (scenario === "clean") {
				assert.notEqual(head, f.oldHead);
				assert.equal(git(f.remote, "merge-base", head, f.base), f.base);
				assert.equal(git(f.remote, "show", `${head}:feature.txt`), "PR change");
				assert.equal(inputs.length, 0);
				assert.equal(f.commands.filter((command) => command.type === "activity").length, 1);
				assert.ok(
					f.commands.some((command) => command.type === "activity" && command.text === "Rebased PR #1 onto main"),
				);
			} else {
				assert.equal(head, scenario === "conflict" ? f.oldHead : f.base);
				assert.equal(inputs.length, 1);
				assert.match(inputs[0]!.content, /Automatic rebase skipped:/);
				if (scenario === "conflict") assert.match(inputs[0]!.content, /Rebase has conflicts/);
			}
			assert.equal(git(f.remote, "rev-parse", "refs/heads/main"), f.base);
			assert.equal(readFileSync(join(f.a.path, "dirty.txt"), "utf8"), "uncommitted user input\n");
			assert.equal(
				jj(f.a.path, "--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id"),
				f.operation,
			);
		} finally {
			await f.close();
		}
	});
}

for (const conflict of [false, true])
	test(`bottom-to-top coalescing: upper ${conflict ? "conflict" : "clean"}`, async () => {
		const f = await setup();
		try {
			jj(f.a.path, "new", "fix/feature");
			writeFileSync(join(f.a.path, conflict ? "a.txt" : "upper.txt"), "upper change\n");
			jj(f.a.path, "commit", "-m", "upper feature");
			jj(f.a.path, "bookmark", "create", "fix/upper", "-r", "@-");
			jj(f.a.path, "git", "push", "--bookmark", "fix/upper");
			f.prs[0]!.stack!.size = 2;
			const upper: SessionPullRequest = {
				...f.prs[0]!,
				number: 2,
				url: "https://github.com/octo/repo/pull/2",
				branch: "fix/upper",
				stack: { ...f.prs[0]!.stack!, position: 2 },
			};
			f.prs.push(upper);
			f.bases.set(2, "fix/feature");
			f.meta.boundPullRequests.push(upper.url);
			const oldTop = git(f.remote, "rev-parse", "refs/heads/fix/upper");
			const meta = f.manager["metas"].get(f.meta.id)!;
			meta.previousPullRequests = [upper];
			await f.follow();
			const bottom = git(f.remote, "rev-parse", "refs/heads/fix/feature");
			const top = git(f.remote, "rev-parse", "refs/heads/fix/upper");
			if (conflict) {
				assert.equal(top, oldTop);
				const inputs = f.commands.filter((command) => command.type === "input");
				assert.equal(inputs.length, 1);
				assert.match(inputs[0]!.content, /pull\/2/);
				assert.doesNotMatch(inputs[0]!.content, /pull\/1/);
				assert.match(inputs[0]!.content, /Rebase has conflicts/);
			} else {
				assert.equal(git(f.remote, "rev-parse", `${top}^`), bottom);
				assert.equal(git(f.remote, "rev-list", "--count", `${f.base}..${top}`), "2");
				assert.equal(f.commands.filter((command) => command.type === "input").length, 0);
				assert.equal(f.commands.filter((command) => command.type === "activity").length, 2);
			}
		} finally {
			await f.close();
		}
	});

test("GitHub's already-retargeted bottom skips its known squash-merged lower PR", async () => {
	const f = await setup();
	try {
		jj(f.a.path, "new", "fix/feature");
		writeFileSync(join(f.a.path, "upper.txt"), "upper change\n");
		jj(f.a.path, "commit", "-m", "upper feature");
		jj(f.a.path, "bookmark", "create", "fix/upper", "-r", "@-");
		jj(f.a.path, "git", "push", "--bookmark", "fix/upper");
		writeFileSync(join(f.source, "feature.txt"), "PR change\n");
		jj(f.source, "commit", "-m", "squash merge lower");
		jj(f.source, "bookmark", "set", "main", "-r", "@-");
		jj(f.source, "git", "push", "--bookmark", "main");
		git(f.remote, "update-ref", "-d", "refs/heads/fix/feature");
		const upper: SessionPullRequest = {
			...f.prs[0]!,
			number: 2,
			url: "https://github.com/octo/repo/pull/2",
			branch: "fix/upper",
		};
		f.prs.push(upper);
		f.bases.set(2, "main");
		const meta = f.manager["metas"].get(f.meta.id)!;
		meta.workspace!.branch = "fix/upper";
		meta.pullRequest = upper;
		meta.previousPullRequests = [{ ...f.prs[0]!, state: "merged" }];
		meta.boundPullRequests!.push(upper.url);
		await f.manager["followUpPullRequests"](meta, "fix/upper", 0, [
			{ pr: upper, problems: { failedChecks: [], reviewComments: 0, mergeConflicts: false, divergedFrom: "main" } },
		]);
		await Promise.all(f.manager["starting"].values());
		const main = git(f.remote, "rev-parse", "refs/heads/main");
		const head = git(f.remote, "rev-parse", "refs/heads/fix/upper");
		assert.equal(git(f.remote, "rev-parse", `${head}^`), main);
		assert.equal(git(f.remote, "rev-list", "--count", `${main}..${head}`), "1");
		assert.equal(f.commands.filter((command) => command.type === "input").length, 0);
	} finally {
		await f.close();
	}
});

test("foreign commits are rejected even on an owned PR", async () => {
	const f = await setup();
	try {
		const sibling = await f.store.create(f.source, f.path("other-chat"));
		writeFileSync(join(sibling.path, "foreign.txt"), "foreign\n");
		jj(sibling.path, "commit", "-m", "foreign commit");
		jj(sibling.path, "bookmark", "create", "fix/foreign", "-r", "@-");
		jj(f.a.path, "new", "fix/foreign");
		writeFileSync(join(f.a.path, "feature.txt"), "own\n");
		jj(f.a.path, "commit", "-m", "own on foreign");
		jj(f.a.path, "bookmark", "set", "--allow-backwards", "fix/feature", "-r", "@-");
		jj(f.a.path, "git", "push", "--bookmark", "fix/feature");
		// Advance the base again, so this new head diverges.
		writeFileSync(join(f.source, "advance.txt"), "advance\n");
		jj(f.source, "commit", "-m", "advance again");
		jj(f.source, "bookmark", "set", "main", "-r", "@-");
		jj(f.source, "git", "push", "--bookmark", "main");
		const head = git(f.remote, "rev-parse", "refs/heads/fix/feature");
		await f.follow();
		assert.equal(git(f.remote, "rev-parse", "refs/heads/fix/feature"), head);
		assert.equal(f.controls.pushCalls, 0);
		assert.ok(f.commands.some((command) => command.type === "input" && command.content.includes("foreign commits")));
	} finally {
		await f.close();
	}
});

test("user work during the trial wins before push", async () => {
	const f = await setup();
	try {
		f.controls.beforeMetadata = async () => {
			if (f.controls.metadataCalls === 2) f.manager["metas"].get(f.meta.id)!.working = true;
		};
		await f.follow();
		assert.equal(f.controls.pushCalls, 0);
		assert.equal(git(f.remote, "rev-parse", "refs/heads/fix/feature"), f.oldHead);
		assert.equal(f.commands.length, 0, "today's idle-only follow-up waits until user work finishes");
	} finally {
		await f.close();
	}
});

test("failed base admissions survive metadata reload and never retry that base", async () => {
	const f = await setup(true);
	try {
		await f.follow();
		const saved = JSON.parse(readFileSync(join(f.root, "daemon", "sessions", f.meta.id, "meta.json"), "utf8"));
		assert.equal(saved.prAutoRebases.length, 1);
		saved.prFollowUp.nextAttemptAt = 0;
		saved.agentPushedAt = Date.now();
		f.manager["metas"].set(f.meta.id, saved);
		await f.manager["followUpPullRequests"](saved, "fix/feature", 0, [
			{
				pr: f.prs[0]!,
				problems: { failedChecks: [], reviewComments: 0, mergeConflicts: true, divergedFrom: "main" },
			},
		]);
		await Promise.all(f.manager["starting"].values());
		assert.equal(f.manager["metas"].get(f.meta.id)!.prAutoRebases!.length, 1);
		assert.ok(
			f.commands.some((command) => command.type === "input" && command.content.includes("Already attempted")),
		);
		assert.equal(f.controls.pushCalls, 0);
	} finally {
		await f.close();
	}
});

// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without starting real kernels.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KernelCommand } from "@pilot/kernel";
import { ProjectStore } from "./projects.ts";
import { type PullRequestBinding, SessionManager, type SessionMissionBridge, type SessionWorker } from "./sessions.ts";
import { legacyGitHub } from "./testing/legacy-github.ts";
import type { Runner } from "./workspaces.ts";

type Meta = Parameters<SessionManager["save"]>[0];
type Input = Extract<KernelCommand, { type: "input" }>;
const url = "https://github.com/octo/repo/pull/42";
const head = "external/fix";
const day = 24 * 60 * 60_000;

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function activity(meta: Meta) {
	return [meta.updatedAt, meta.lastUserMessageAt, meta.outcome, meta.outcomeAt, meta.lastCompletionAt];
}

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
	const f = await setup();
	try {
		await run(f);
	} finally {
		f.controls.healthGate?.release.resolve();
		f.controls.workerReady?.resolve();
		await f.manager.shutdown();
		await rm(f.home, { recursive: true, force: true });
	}
}

async function setup() {
	const home = await mkdtemp(join(tmpdir(), "pilot-pr-bindings-"));
	const projects = new ProjectStore(home);
	const project = await projects.create({ path: home, workspace: "direct" });
	const ids = [randomUUID(), randomUUID()] as const;
	for (const id of ids) {
		const meta: Meta = {
			id,
			projectId: project.id,
			mode: "build",
			title: "Direct project chat",
			cwd: home,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastUserMessageAt: Date.now(),
			working: false,
			outcome: "done",
			outcomeAt: 1,
			lastCompletionAt: 1,
		};
		await mkdir(join(home, "sessions", id), { recursive: true });
		await writeFile(join(home, "sessions", id, "meta.json"), JSON.stringify(meta));
	}
	const controls = {
		upstream: "git@github.com:Octo/Repo.git",
		state: "OPEN",
		failing: false,
		mergedAt: Date.now(),
		discoveries: 0,
		healthCalls: 0,
		healthGate: undefined as
			| { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
			| undefined,
		workerReady: undefined as ReturnType<typeof deferred> | undefined,
		workerStarted: deferred(),
	};
	const inputs: { id: string; input: Input }[] = [];
	const runner: Runner = legacyGitHub(async (file, args) => {
		if (file === "git") {
			assert.deepEqual(
				args,
				["remote", "get-url", "origin"],
				"direct chats never infer ownership from local branches",
			);
			return controls.upstream;
		}
		assert.equal(file, "gh");
		if (args[0] === "pr" && args[1] === "view") {
			assert.equal(args[2], "42");
			if (args.some((arg) => arg.includes("isCrossRepository"))) {
				controls.discoveries++;
				return JSON.stringify({
					number: 42,
					url,
					title: "Bound PR",
					state: controls.state,
					isDraft: false,
					headRefName: head,
					isCrossRepository: true,
					createdAt: "2026-01-01T00:00:00Z",
					mergedAt: controls.state === "MERGED" ? new Date(controls.mergedAt).toISOString() : null,
				});
			}
			controls.healthCalls++;
			const gate = controls.healthGate;
			controls.healthGate = undefined;
			gate?.entered.resolve();
			await gate?.release.promise;
			return JSON.stringify({
				state: controls.state,
				headRefName: head,
				isDraft: false,
				statusCheckRollup: controls.failing
					? [{ __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "FAILURE" }]
					: [],
				mergeable: "MERGEABLE",
				reviewDecision: null,
				mergeStateStatus: "CLEAN",
			});
		}
		assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
		return JSON.stringify({
			data: {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: [],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			},
		});
	});
	let bridge: SessionMissionBridge | undefined;
	const makeManager = () => {
		const manager = new SessionManager(
			home,
			projects,
			undefined,
			{
				title: async () => undefined,
				worker: (spec, _onPacket, onExit) => {
					const worker: SessionWorker = {
						ready: controls.workerReady?.promise ?? Promise.resolve(),
						state: "idle",
						busy: false,
						send: () => {},
						request: async (command) => {
							if (command.type === "input") inputs.push({ id: spec.sessionId, input: command });
						},
						close: async () => {
							onExit(worker, 0);
						},
					};
					controls.workerStarted.resolve();
					return worker;
				},
			},
			{ runner, intervalMs: 60 * 60_000 },
		);
		if (bridge) manager.setMissionBridge(bridge);
		return manager;
	};
	let manager = makeManager();
	await manager.load();
	await manager["pullRequests"].settled();
	const settle = async () => {
		await manager["pullRequests"].settled();
		await Promise.allSettled(manager["starting"].values());
		await Promise.all(manager["saving"].values());
	};
	return {
		home,
		ids,
		inputs,
		controls,
		journal: join(home, "sessions", "pull-request-binding.json"),
		get manager() {
			return manager;
		},
		meta: (id = ids[0]) => manager["metas"].get(id)!,
		saved: async (id = ids[0]): Promise<Meta> =>
			JSON.parse(await readFile(join(home, "sessions", id, "meta.json"), "utf8")),
		settle,
		bridge: (value: SessionMissionBridge) => {
			bridge = value;
			manager.setMissionBridge(value);
		},
		restart: async () => {
			await manager.shutdown();
			manager = makeManager();
			await manager.load();
			await settle();
		},
	};
}

function missionBridge(apply: (operation: PullRequestBinding) => void): SessionMissionBridge {
	return {
		spawnProject: () => {
			throw new Error("not spawning");
		},
		joinSpawn: () => {},
		membership: () => undefined,
		context: () => undefined,
		call: async () => undefined,
		validatePullRequestBinding: () => ({ missionId: "mission", taskId: "task" }),
		applyPullRequestBinding: apply,
	};
}

test("binding accepts PR numbers against the project origin and moves canonical ownership", async () => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], "42");
		await f.settle();
		assert.deepEqual(f.meta().boundPullRequests, [url]);
		const moved = await f.manager.bindPullRequest(f.ids[1], " #42\n");
		await f.settle();
		assert.equal(moved.previousOwner?.id, f.ids[0]);
		assert.deepEqual(f.meta().boundPullRequests, []);
		assert.deepEqual(f.meta(f.ids[1]).boundPullRequests, [url]);
		assert.deepEqual((await f.saved(f.ids[1])).boundPullRequests, [url]);
	});
});

test("binding numbers uses the workspace upstream rather than the origin", async () => {
	await fixture(async (f) => {
		f.meta().workspace = {
			source: f.home,
			branch: head,
			upstream: "https://github.com/Octo/Repo.git",
			base: "origin/main",
			jj: false,
		};
		f.controls.upstream = "git@gitlab.com:other/repo.git";
		await f.manager.bindPullRequest(f.ids[0], "#42");
		await f.settle();
		assert.deepEqual(f.meta().boundPullRequests, [url]);
	});
});

test("binding rejects malformed numbers and retains strict link validation", async () => {
	await fixture(async (f) => {
		for (const input of [
			"0",
			"#0",
			"042",
			"#042",
			"-42",
			"+42",
			"# 42",
			"##42",
			"4 2",
			"42.0",
			"4e2",
			"42x",
			"４２",
			"٤٢",
			"2147483648",
			"#99999999999999999999999999999",
			`${url}/files`,
			`${url}?x=1`,
			`${url}#top`,
			"http://github.com/octo/repo/pull/42",
			"https://github.com:8443/octo/repo/pull/42",
			"https://user@github.com/octo/repo/pull/42",
		]) {
			await assert.rejects(f.manager.bindPullRequest(f.ids[0], input), /GitHub pull request URL/, input);
		}
		await assert.rejects(
			f.manager.bindPullRequest(f.ids[0], "https://github.com/other/repo/pull/42"),
			/project repository/,
		);
		assert.equal(f.meta().boundPullRequests, undefined);
	});
});

test("binding by number clearly rejects non-GitHub project and workspace upstreams", async () => {
	await fixture(async (f) => {
		for (const upstream of ["git@gitlab.com:octo/repo.git", "https://example.com/octo/repo.git", "/local/repo"]) {
			f.controls.upstream = upstream;
			for (const input of ["42", "#42"]) {
				await assert.rejects(f.manager.bindPullRequest(f.ids[0], input), /GitHub.*(upstream|repository URL)/);
			}
		}
		f.meta().workspace = {
			source: f.home,
			branch: head,
			upstream: "git@gitlab.com:octo/repo.git",
			base: "origin/main",
			jj: false,
		};
		f.controls.upstream = "git@github.com:octo/repo.git";
		await assert.rejects(f.manager.bindPullRequest(f.ids[0], "42"), /GitHub.*upstream/);
		assert.equal(f.meta().boundPullRequests, undefined);
	});
});

test("direct-project bindings receive durable idle-only follow-ups without changing user activity", async () => {
	await fixture(async (f) => {
		const before = activity(f.meta());
		f.controls.failing = true;
		await f.manager.bindPullRequest(f.ids[0], "https://github.com/Octo/Repo/pull/42");
		await f.settle();
		const summary = f.manager.get(f.ids[0])!;
		assert.equal(f.meta().workspace, undefined);
		assert.equal(summary.pullRequest?.url, url);
		assert.equal(summary.pullRequest?.branch, head);
		assert.equal(f.inputs.length, 1);
		assert.equal(f.inputs[0]!.id, f.ids[0]);
		assert.equal(f.inputs[0]!.input.onlyIfIdle, true);
		assert.match(f.inputs[0]!.input.content, /external\/fix/);
		assert.deepEqual(activity(f.meta()), before);
		assert.equal((await f.saved()).prFollowUp?.attempts, 1);
		assert.deepEqual((await f.saved()).boundPullRequests, [url]);
		assert.equal(f.meta().failure, undefined);
	});
});

test("binding results distinguish no-ops, discovered ownership and taskless detach across restart", async () => {
	await fixture(async (f) => {
		const result = ({
			changed,
			previousOwner,
			taskLinkRemoved,
		}: Awaited<ReturnType<SessionManager["bindPullRequest"]>>) => ({ changed, previousOwner, taskLinkRemoved });
		assert.deepEqual(result(await f.manager.unbindPullRequest(f.ids[0], url)), {
			changed: false,
			previousOwner: null,
			taskLinkRemoved: false,
		});
		assert.ok((await f.saved()).unboundPullRequests?.includes(url), "even a no-op suppresses future rediscovery");
		const previous = f.meta(f.ids[1]);
		previous.agentPullRequests = [url];
		const owner = { id: previous.id, title: previous.title };
		assert.deepEqual(f.manager.pullRequestOwnerSummary(url), owner);
		assert.deepEqual(result(await f.manager.bindPullRequest(f.ids[0], url)), {
			changed: true,
			previousOwner: owner,
			taskLinkRemoved: false,
		});
		await f.settle();
		await f.restart();
		const currentOwner = { id: f.ids[0], title: f.meta().title };
		assert.deepEqual(f.manager.pullRequestOwnerSummary(url), currentOwner);
		assert.deepEqual(result(await f.manager.bindPullRequest(f.ids[0], url)), {
			changed: false,
			previousOwner: currentOwner,
			taskLinkRemoved: false,
		});
		assert.deepEqual(result(await f.manager.unbindPullRequest(f.ids[0], url)), {
			changed: true,
			previousOwner: currentOwner,
			taskLinkRemoved: false,
		});
		assert.equal(f.manager.pullRequestOwnerSummary(url), undefined);
		assert.deepEqual(result(await f.manager.unbindPullRequest(f.ids[0], url)), {
			changed: false,
			previousOwner: null,
			taskLinkRemoved: false,
		});
	});
});

test("summaries list explicit bindings until they are detached or moved", async () => {
	await fixture(async (f) => {
		assert.equal(f.manager.get(f.ids[0])!.boundPullRequests, undefined);
		// Returned before GitHub is refreshed, so clients can show the binding while its PR is pending.
		const bound = await f.manager.bindPullRequest(f.ids[0], "https://github.com/Octo/Repo/pull/42");
		assert.deepEqual(bound.boundPullRequests, [url]);
		await f.settle();
		const moved = await f.manager.bindPullRequest(f.ids[1], url);
		assert.deepEqual(moved.boundPullRequests, [url]);
		assert.equal(f.manager.get(f.ids[0])!.boundPullRequests, undefined);
		const detached = await f.manager.unbindPullRequest(f.ids[1], url);
		assert.equal(detached.boundPullRequests, undefined);
		assert.equal(detached.pullRequests, undefined);
		await f.settle();
	});
});

test("binding returns after the local commit without waiting for blocked GitHub health", async () => {
	await fixture(async (f) => {
		const gate = { entered: deferred(), release: deferred() };
		f.controls.healthGate = gate;
		const binding = f.manager.bindPullRequest(f.ids[0], url);
		try {
			const first = await Promise.race([
				binding.then(() => "local commit returned"),
				gate.entered.promise.then(() => "GitHub health blocked"),
			]);
			assert.equal(first, "local commit returned", "the binding API must not await its background GitHub refresh");
			assert.deepEqual((await f.saved()).boundPullRequests, [url]);
			assert.equal(f.manager["pullRequestOwner"](url), f.ids[0]);
			await gate.entered.promise;
			assert.equal(f.meta().pullRequest, undefined, "remote state is still pending when the local commit returns");
			assert.equal(f.inputs.length, 0);
			gate.release.resolve();
			await f.settle();
			assert.equal(f.meta().pullRequest?.url, url);
		} finally {
			gate.release.resolve();
			await binding;
			await f.settle();
		}
	});
});

test("a bound primary PR refreshed by number replaces its cached open status when merged", async () => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		assert.equal(f.manager.get(f.ids[0])?.pullRequest?.state, "open");
		f.controls.state = "MERGED";
		await f.manager["pullRequests"].refresh(f.meta());
		await f.settle();
		assert.equal(f.manager.get(f.ids[0])?.pullRequest?.state, "merged");
		assert.equal(f.manager.get(f.ids[0])?.pullRequests?.length, 1);
		assert.equal((await f.saved()).pullRequest?.state, "merged");
	});
});

test("a merged bound PR archives direct chats even with a closed primary, using persisted status after restart", async (t) => {
	let now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	await fixture(async (f) => {
		f.controls.state = "MERGED";
		f.controls.mergedAt = now;
		f.meta().pullRequest = {
			number: 9,
			url: "https://github.com/octo/repo/pull/9",
			title: "Closed primary",
			state: "closed",
			checkedAt: now,
		};
		await f.manager["save"](f.meta());
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		assert.equal(f.manager.get(f.ids[0])?.pullRequest?.state, "closed");
		assert.deepEqual(
			f.manager.get(f.ids[0])?.pullRequests?.map((pr) => pr.state),
			["closed", "merged"],
		);
		assert.equal(f.meta().archivedAt, undefined);
		assert.equal(f.manager["mergeArchiveTarget"](f.meta())?.url, url);
		const calls = f.controls.discoveries;
		await f.restart();
		assert.equal(f.controls.discoveries, calls, "terminal direct bindings never poll on restart");
		now += day - 1;
		await f.manager["archiveInactiveSessions"]();
		assert.equal(f.meta().archivedAt, undefined);
		now++;
		await f.manager["archiveInactiveSessions"]();
		assert.equal(f.meta().autoArchivedPullRequest, url);
		assert.equal((await f.saved()).archivedAt, now);
		assert.equal(f.controls.discoveries, calls, "merge deadline needs no GitHub request or private workspace");
	});
});

test("handoff revokes stale in-flight health for the old direct owner", async () => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		f.controls.failing = true;
		const gate = { entered: deferred(), release: deferred() };
		f.controls.healthGate = gate;
		const refreshing = f.manager["pullRequests"].refresh(f.meta());
		try {
			await gate.entered.promise;
			await f.manager.bindPullRequest(f.ids[1], url);
			gate.release.resolve();
			await refreshing;
			await f.settle();
			assert.equal(f.inputs.length, 1);
			assert.equal(f.inputs[0]!.id, f.ids[1]);
			assert.equal(f.meta().pullRequest, undefined, "the stale discovery result cannot reattach the old PR");
			assert.deepEqual((await f.saved()).unboundPullRequests, [url]);
			assert.equal(f.manager["pullRequestOwner"](url), f.ids[1]);
		} finally {
			gate.release.resolve();
			await refreshing;
		}
	});
});

test("PR ownership remains unique across two projects that use the same GitHub repository", async () => {
	await fixture(async (f) => {
		const path = join(f.home, "another-checkout");
		await mkdir(path);
		const project = await f.manager["projects"].create({ path, workspace: "direct" });
		f.meta(f.ids[1]).projectId = project.id;
		f.meta(f.ids[1]).cwd = path;
		await f.manager["save"](f.meta(f.ids[1]));
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		await f.manager.bindPullRequest(f.ids[1], url);
		await f.settle();
		assert.equal(f.manager["pullRequestOwner"](url), f.ids[1]);
		assert.deepEqual((await f.saved()).unboundPullRequests, [url]);
		assert.deepEqual((await f.saved(f.ids[1])).boundPullRequests, [url]);
	});
});

test("unbinding revokes a pending follow-up but preserves user input and rejects stale replay", async () => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		f.controls.failing = true;
		const ready = deferred();
		f.controls.workerReady = ready;
		try {
			await f.manager["pullRequests"].refresh(f.meta());
			await f.controls.workerStarted.promise;
			const automatic = f.meta().pending?.[0];
			assert.equal(automatic?.type, "input");
			assert.equal(f.inputs.length, 0);
			await f.manager.unbindPullRequest(f.ids[0], "https://github.com/octo/repo/pull/4");
			assert.deepEqual(f.meta().pending, [automatic], "PR #4 is not PR #42 in an automatic repair prompt");
			assert.equal(f.meta().prFollowUp?.requestId, automatic?.requestId);
			assert.equal(f.meta().prFollowUp?.attempts, 1, "an unrelated exclusion cannot refund the pending repair");
			const user: Input = {
				type: "input",
				requestId: "user-request",
				content: "Keep the user's queued work",
				mode: "followUp",
			};
			f.meta().pending!.push(user);
			await f.manager["save"](f.meta());
			await f.manager.unbindPullRequest(f.ids[0], url);
			assert.deepEqual(f.meta().pending, [user]);
			assert.equal(f.meta().prFollowUp?.attempts, 0);
			assert.equal(f.meta().prFollowUp?.requestId, undefined);
			ready.resolve();
			await f.settle();
			assert.deepEqual(
				f.inputs.map(({ input }) => input.requestId),
				[user.requestId],
			);
			// Older outbox snapshots cannot resurrect the revoked request after restart.
			f.meta().pending = [automatic!];
			await f.manager["save"](f.meta());
			await f.restart();
			assert.deepEqual(
				f.inputs.map(({ input }) => input.requestId),
				[user.requestId],
			);
			assert.deepEqual((await f.saved()).pending, []);
		} finally {
			ready.resolve();
		}
	});
});

test("journal recovery rolls a partially saved handoff forward before discovery and preserves operation identity", async (t) => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		const applied: PullRequestBinding[] = [];
		f.bridge(
			missionBridge((operation) => {
				assert.equal(
					f.manager["pullRequestOwner"](url),
					f.ids[1],
					"ownership changes synchronously before mission links move",
				);
				applied.push(operation);
			}),
		);
		const save = f.manager["save"].bind(f.manager);
		const registry = f.manager as unknown as { save(meta: Meta): Promise<void> };
		const mock = t.mock.method(registry, "save", async (meta: Meta) => {
			assert.equal(applied.length, 1, "task links move before the first asynchronous metadata save");
			if (meta.id === f.ids[1]) throw new Error("crash before target metadata write");
			await save(meta);
		});
		await assert.rejects(
			f.manager.bindPullRequest(f.ids[1], url, { sessionId: "actor" }, "task"),
			/crash before target/,
		);
		mock.mock.restore();
		const journal: PullRequestBinding = JSON.parse(await readFile(f.journal, "utf8"));
		assert.deepEqual(journal.previousSessionIds, [f.ids[0]]);
		assert.equal(journal.missionId, "mission");
		assert.equal(journal.changed, true);
		assert.deepEqual((await f.saved()).unboundPullRequests, [url]);
		assert.equal((await f.saved(f.ids[1])).boundPullRequests, undefined);
		assert.equal(applied.length, 1, "the committed journal protects links already moved before metadata failure");
		await f.restart();
		assert.deepEqual((await f.saved(f.ids[1])).boundPullRequests, [url]);
		assert.equal(f.manager["pullRequestOwner"](url), f.ids[1]);
		assert.equal(applied.length, 2);
		assert.deepEqual(applied[0], journal);
		assert.deepEqual(applied[1], journal, "mission storage can idempotently replay the same operation ID");
		await assert.rejects(readFile(f.journal), { code: "ENOENT" });
		await f.restart();
		assert.equal(applied.length, 2, "a cleared journal never replays another handoff");
	});
});

test("journal survives mission-store failure and replays the same committed operation exactly once", async () => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		let fail = true;
		const seen: string[] = [];
		const committed = new Set<string>();
		f.bridge(
			missionBridge((operation) => {
				seen.push(operation.id);
				if (fail) throw new Error("mission transaction unavailable");
				committed.add(operation.id);
			}),
		);
		await assert.rejects(f.manager.bindPullRequest(f.ids[1], url), /mission transaction unavailable/);
		const operation: PullRequestBinding = JSON.parse(await readFile(f.journal, "utf8"));
		assert.deepEqual((await f.saved()).boundPullRequests, [url], "mission failure precedes every metadata write");
		assert.equal((await f.saved(f.ids[1])).boundPullRequests, undefined);
		fail = false;
		await f.restart();
		assert.deepEqual(seen, [operation.id, operation.id]);
		assert.equal(committed.size, 1);
		assert.equal(f.manager["pullRequestOwner"](url), f.ids[1]);
		await assert.rejects(readFile(f.journal), { code: "ENOENT" });
	});
});

test("recovering a committed unbind drops queued automatic input before any worker can start", async (t) => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		const requestId = "pr-follow-up:interrupted";
		f.meta().prFollowUp = { attempts: 1, nextAttemptAt: Date.now() + 60_000, generation: 0, requestId };
		f.meta().pending = [
			{
				type: "input",
				requestId,
				content: `Stale automatic repair for ${url}.`,
				mode: "followUp",
				onlyIfIdle: true,
			},
		];
		await f.manager["save"](f.meta());
		const registry = f.manager as unknown as { save(meta: Meta): Promise<void> };
		const mock = t.mock.method(registry, "save", async () => {
			throw new Error("crash before unbind save");
		});
		await assert.rejects(f.manager.unbindPullRequest(f.ids[0], url), /crash before unbind/);
		mock.mock.restore();
		assert.equal((await f.saved()).pending?.[0]?.requestId, requestId, "disk still holds the old outbox");
		await f.restart();
		assert.equal(f.inputs.length, 0);
		assert.equal(f.manager["workers"].size, 0);
		assert.deepEqual((await f.saved()).pending, []);
		assert.equal((await f.saved()).prFollowUp?.attempts, 0);
		assert.equal((await f.saved()).prFollowUp?.requestId, undefined);
		assert.deepEqual((await f.saved()).unboundPullRequests, [url]);
		await assert.rejects(readFile(f.journal), { code: "ENOENT" });
	});
});

test("an uncommitted temporary journal never changes the durable owner", async () => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		const operation: PullRequestBinding = {
			id: randomUUID(),
			sessionId: f.ids[1],
			url,
			bound: true,
			previousSessionIds: [f.ids[0]],
			actor: {},
			changed: true,
		};
		await writeFile(`${f.journal}.tmp`, JSON.stringify(operation));
		await f.restart();
		assert.equal(f.manager["pullRequestOwner"](url), f.ids[0]);
		assert.equal((await f.saved(f.ids[1])).boundPullRequests, undefined);
		assert.deepEqual((await f.saved()).boundPullRequests, [url]);
	});
});

test("queued lifecycle saves freeze ordinary PR snapshots until a binding operation changes", async () => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		const gate = deferred();
		f.manager["saving"].set(f.ids[0], gate.promise);
		f.meta().title = "Captured lifecycle title";
		const saving = f.manager["save"](f.meta());
		try {
			f.meta().title = "Unsaved lifecycle title";
			f.meta().pullRequest = { ...f.meta().pullRequest!, state: "closed" };
			gate.resolve();
			await saving;
			const persisted = await f.saved();
			assert.equal(persisted.title, "Captured lifecycle title");
			assert.equal(persisted.pullRequest?.state, "open", "ordinary writes retain their captured PR snapshot");
			assert.equal(persisted.prBindingOperation, f.meta().prBindingOperation);
		} finally {
			gate.resolve();
			await saving;
		}
	});
});

test("a queued lifecycle snapshot cannot resurrect links revoked by a newer binding operation", async (t) => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		const marker = f.meta().prBindingOperation;
		const gate = deferred();
		f.manager["saving"].set(f.ids[0], gate.promise);
		f.meta().title = "Captured lifecycle title";
		const save = f.manager["save"].bind(f.manager);
		const saving = save(f.meta());
		f.meta().title = "New lifecycle title";
		const staged = deferred();
		const release = deferred();
		const registry = f.manager as unknown as { save(meta: Meta): Promise<void> };
		const mock = t.mock.method(registry, "save", async (meta: Meta) => {
			assert.notEqual(meta.prBindingOperation, marker);
			staged.resolve();
			await release.promise;
			await save(meta);
		});
		const unbinding = f.manager.unbindPullRequest(f.ids[0], url);
		try {
			await staged.promise;
			gate.resolve();
			await saving;
			const persisted = await f.saved();
			assert.equal(persisted.title, "Captured lifecycle title", "unrelated lifecycle fields still use the snapshot");
			assert.deepEqual(persisted.boundPullRequests, []);
			assert.deepEqual(persisted.unboundPullRequests, [url]);
			assert.equal(persisted.pullRequest, undefined);
			assert.equal(persisted.prBindingOperation, f.meta().prBindingOperation);
			assert.notEqual(persisted.prBindingOperation, marker);
			release.resolve();
			await unbinding;
		} finally {
			gate.resolve();
			release.resolve();
			await saving;
			await unbinding;
			mock.mock.restore();
		}
	});
});

test("unbind during discovery persistence suppresses stale mission links and PR updates", async (t) => {
	await fixture(async (f) => {
		const discovered: string[][] = [];
		const updated: string[] = [];
		f.bridge({
			...missionBridge(() => {}),
			pullRequestsDiscovered: (_id, urls) => {
				discovered.push(urls);
			},
			pullRequestUpdated: (pr) => {
				updated.push(pr.url);
			},
		});
		const entered = deferred();
		const release = deferred();
		const save = f.manager["save"].bind(f.manager);
		const registry = f.manager as unknown as { save(meta: Meta): Promise<void> };
		let first = true;
		const mock = t.mock.method(registry, "save", async (meta: Meta) => {
			await save(meta);
			if (first) {
				first = false;
				entered.resolve();
				await release.promise;
			}
		});
		f.meta().agentPullRequests = [url];
		const applying = f.manager["applyPullRequest"](f.meta(), {
			pullRequest: { number: 42, url, title: "Fresh discovery", branch: head, state: "open", checkedAt: Date.now() },
		});
		try {
			await entered.promise;
			await f.manager.unbindPullRequest(f.ids[0], url);
			assert.deepEqual((await f.saved()).unboundPullRequests, [url]);
			release.resolve();
			await applying;
			assert.deepEqual(discovered, [], "a result saved before revocation cannot recreate the old task link");
			assert.deepEqual(updated, [], "stale health/status cannot update task state after the unbind");
			assert.equal(f.meta().pullRequest, undefined);
			assert.equal((await f.saved()).pullRequest, undefined);
			assert.equal(f.inputs.length, 0);
		} finally {
			release.resolve();
			await applying;
			mock.mock.restore();
		}
	});
});

test("a failed stale discovery save cannot roll back a newer unbind", async (t) => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		const entered = deferred();
		const release = deferred();
		const save = f.manager["save"].bind(f.manager);
		const registry = f.manager as unknown as { save(meta: Meta): Promise<void> };
		let first = true;
		const mock = t.mock.method(registry, "save", async (meta: Meta) => {
			if (first) {
				first = false;
				entered.resolve();
				await release.promise;
				throw new Error("stale PR write failed");
			}
			await save(meta);
		});
		const applying = assert.rejects(
			f.manager["applyPullRequest"](f.meta(), {
				pullRequest: { ...f.meta().pullRequest!, title: "Stale update", checkedAt: Date.now() },
			}),
			/stale PR write failed/,
		);
		try {
			await entered.promise;
			await f.manager.unbindPullRequest(f.ids[0], url);
			const marker = f.meta().prBindingOperation;
			release.resolve();
			await applying;
			assert.equal(f.meta().pullRequest, undefined, "rollback must not resurrect the previously bound PR");
			assert.deepEqual(f.meta().unboundPullRequests, [url]);
			assert.equal(f.meta().prBindingOperation, marker);
			assert.equal(f.manager["pullRequestOwner"](url), undefined);
			assert.equal((await f.saved()).pullRequest, undefined);
		} finally {
			release.resolve();
			await applying;
			mock.mock.restore();
		}
	});
});

test("explicit-owned sync does not scan the chat registry, including with 10,000 chats", async (t) => {
	await fixture(async (f) => {
		await f.manager.bindPullRequest(f.ids[0], url);
		await f.settle();
		const metas = f.manager["metas"];
		const foreignUrl = "https://github.com/octo/repo/pull/43";
		f.manager["boundPullRequestOwners"].set(foreignUrl, f.ids[1]);
		const registry = f.manager as unknown as { save(meta: Meta): Promise<void> };
		let saves = 0;
		const saveMock = t.mock.method(registry, "save", async () => {
			saves++;
		});
		const valuesMock = t.mock.method(metas, "values", () => {
			throw new Error("explicit-owned sync must not scan every chat");
		});
		const synthetic: string[] = [];
		const sample = async () => {
			const start = performance.now();
			for (let round = 0; round < 100; round++) {
				await f.manager["applyPullRequest"](f.meta(), {
					pullRequest: { number: 42, url, title: `Round ${round}`, branch: head, state: "open", checkedAt: round },
					others: [{ number: 43, url: foreignUrl, title: "Owned elsewhere", state: "open", checkedAt: round }],
				});
			}
			return performance.now() - start;
		};
		try {
			const small = await sample();
			for (let index = 0; index < 10_000; index++) {
				const id = `synthetic-${index}`;
				synthetic.push(id);
				metas.set(id, { id, title: "Unrelated chat", cwd: f.home, createdAt: 1, updatedAt: 1 });
			}
			const large = await sample();
			assert.equal(f.meta().pullRequest?.title, "Round 99");
			assert.equal(f.meta().previousPullRequests, undefined, "the owner index rejects another chat's PR");
			assert.equal(saves, 200);
			assert.equal(valuesMock.mock.callCount(), 0);
			t.diagnostic(
				`100 direct-owned PR applies, mocked persistence/no health: 2 chats ${small.toFixed(2)} ms; 10,002 chats ${large.toFixed(2)} ms`,
			);
		} finally {
			valuesMock.mock.restore();
			saveMock.mock.restore();
			for (const id of synthetic) metas.delete(id);
			f.manager["boundPullRequestOwners"].delete(foreignUrl);
		}
	});
});

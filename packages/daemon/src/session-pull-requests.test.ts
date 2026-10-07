// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without forking a kernel or making them public.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionPullRequest, SessionSummary } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import type { PullRequestOptions } from "./pull-requests.ts";
import { SessionManager } from "./sessions.ts";
import type { Runner } from "./workspaces.ts";

type Meta = Parameters<SessionManager["save"]>[0];
type Worker = Parameters<SessionManager["onPacket"]>[1];
const branch = "fix-pr-tracking";
const cached: SessionPullRequest = {
	number: 10,
	url: "https://github.com/octo/repo/pull/10",
	title: "Cached PR",
	state: "open",
	checkedAt: 1,
};

function candidate(state = "OPEN", isDraft = false) {
	return {
		...cached,
		state,
		isDraft,
		headRefName: branch,
		isCrossRepository: false,
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function lifecycle(manager: SessionManager, meta: Meta) {
	const summary = manager.get(meta.id)!;
	return {
		state: summary.state,
		outcome: summary.outcome,
		outcomeAt: summary.outcomeAt,
		outcomeReason: summary.outcomeReason,
		error: summary.error,
		updatedAt: summary.updatedAt,
		working: meta.working,
		lastOutcomeAt: meta.lastOutcomeAt,
		lastCompletionAt: meta.lastCompletionAt,
	};
}

async function fixture(
	options: PullRequestOptions,
	run: (manager: SessionManager, meta: Meta, home: string, changes: SessionSummary[]) => Promise<void>,
	initialPullRequest?: SessionPullRequest,
	currentBranch: () => string = () => "",
) {
	const home = await mkdtemp(join(tmpdir(), "pilot-prs-"));
	const id = randomUUID();
	const cwd = join(home, "sessions", id, "workspace");
	const meta: Meta = {
		id,
		title: "Private",
		cwd,
		createdAt: 1,
		updatedAt: 2,
		workspace: { source: home, branch, upstream: "git@github.com:octo/repo.git", base: "origin/main", jj: false },
		working: false,
		outcome: "needs_input",
		outcomeAt: 10,
		outcomeReason: "Approval",
		lastOutcomeAt: 10,
		lastCompletionAt: 10,
		...(initialPullRequest ? { pullRequest: initialPullRequest } : {}),
	};
	const direct: Meta = { id: randomUUID(), title: "Direct", cwd: home, createdAt: 1, updatedAt: 3 };
	await mkdir(cwd, { recursive: true });
	await mkdir(join(home, "sessions", direct.id), { recursive: true });
	await writeFile(join(home, "sessions", id, "meta.json"), JSON.stringify(meta));
	await writeFile(join(home, "sessions", direct.id, "meta.json"), JSON.stringify(direct));
	const manager = new SessionManager(
		home,
		new ProjectStore(home),
		undefined,
		{},
		{
			...options,
			runner: async (file, args, ...rest) =>
				file === "git" && args[0] === "branch" ? currentBranch() : options.runner!(file, args, ...rest),
		},
	);
	const changes: SessionSummary[] = [];
	manager.onChange((summary) => changes.push(summary));
	try {
		await manager.load();
		// load reads fresh objects. Use the live registry metadata for supervision and refreshes.
		await run(manager, manager["metas"].get(id)!, home, changes);
	} finally {
		await manager.shutdown();
		await rm(home, { recursive: true, force: true });
	}
}

async function saved(home: string, id: string): Promise<Meta> {
	return JSON.parse(await readFile(join(home, "sessions", id, "meta.json"), "utf8"));
}

async function until(predicate: () => boolean) {
	for (let i = 0; i < 200 && !predicate(); i++) await delay(5);
	assert.ok(predicate(), "condition did not settle");
}

test("load discovers parked private sessions without a client/worker, refresh broadcasts freshness without reordering or outcome changes", async () => {
	let calls = 0;
	await fixture(
		{
			runner: async (file) => {
				assert.equal(file, "gh");
				calls++;
				return JSON.stringify([candidate()]);
			},
		},
		async (manager, meta, home, changes) => {
			const initial = lifecycle(manager, meta);
			const order = manager.list().map((summary) => summary.id);
			await manager["pullRequests"]["polling"];
			assert.equal(calls, 1, "direct workspace must not be discovered");
			assert.equal(manager["workers"].size, 0);
			assert.equal(manager.get(meta.id)?.pullRequest?.number, 10);
			assert.equal(changes.length, 1);
			const firstCheck = changes[0]!.pullRequest!.checkedAt;
			await delay(2);
			await manager["pullRequests"].refresh(meta);
			assert.equal(changes.length, 2, "same-state successful check must broadcast its new checkedAt");
			assert.ok(changes[1]!.pullRequest!.checkedAt > firstCheck);
			assert.deepEqual(lifecycle(manager, meta), initial);
			assert.deepEqual(
				manager.list().map((summary) => summary.id),
				order,
			);
			const persisted = await saved(home, meta.id);
			assert.equal(persisted.pullRequest?.checkedAt, changes[1]!.pullRequest!.checkedAt);
			assert.equal(persisted.updatedAt, 2);
			assert.equal(persisted.outcomeAt, 10);
		},
	);
});

test("fourth-argument factories remain compatible: preparation immediately discovers PRs without blocking spawn or worker readiness", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-pr-startup-"));
	const source = join(home, "source");
	await mkdir(source);
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: source });
	let releaseClone!: () => void;
	let releaseReady!: () => void;
	let releaseLookup!: () => void;
	const clone = new Promise<void>((resolve) => {
		releaseClone = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		releaseReady = resolve;
	});
	const lookup = new Promise<void>((resolve) => {
		releaseLookup = resolve;
	});
	let cloning = false;
	let workerCreated = false;
	let lookups = 0;
	let admit = () => {};
	const manager = new SessionManager(
		home,
		projects,
		undefined,
		{
			title: async () => undefined,
			workspace: async (_source, path) => {
				cloning = true;
				await clone;
				return { path, base: "origin/main", upstream: "git@github.com:octo/repo.git", jj: false };
			},
			worker: (_spec, onPacket, onExit) => {
				workerCreated = true;
				const worker: Worker = {
					ready,
					state: "starting",
					send: () => {},
					request: async (command) => {
						worker.state = command.type === "input" ? "working" : "idle";
						onPacket({ type: "working", working: worker.state === "working" });
					},
					close: async () => {
						releaseReady();
						onExit(worker, 0);
					},
				};
				admit = () => {
					worker.state = "idle";
					onPacket({ type: "ready", model: "test/model", working: false, usage: {} });
					releaseReady();
				};
				return worker;
			},
		},
		{
			runner: async (file, args) => {
				if (file === "git" && args[0] === "branch") return branch;
				assert.equal(file, "gh", "new clone must use the daemon-recorded upstream, not read origin");
				lookups++;
				await lookup;
				const headRefName = args.find((arg) => arg.startsWith("--head="))!.slice("--head=".length);
				return JSON.stringify([{ ...candidate(), headRefName }]);
			},
		},
	);
	try {
		await manager.load();
		const created = await manager.spawn({ projectId: project.id, message: "Discover my PR" });
		assert.equal(created.state, "starting", "spawn returns before clone/worker/GitHub readiness");
		await until(() => cloning);
		assert.equal(lookups, 0, "unprepared workspaces must not be attributed to the source checkout");
		releaseClone();
		await until(() => lookups === 1 && workerCreated);
		assert.equal(manager.get(created.id)?.state, "starting");
		// A blocked GitHub command must not block durable admission to the ready worker.
		admit();
		await until(() => manager.get(created.id)?.state === "working");
		assert.equal(manager.get(created.id)?.pullRequest, undefined);
		const active = lifecycle(manager, manager["metas"].get(created.id)!);
		releaseLookup();
		await until(() => manager.get(created.id)?.pullRequest?.state === "open");
		await manager["pullRequests"].refresh(manager["metas"].get(created.id)!);
		assert.equal(manager.get(created.id)?.branch, branch);
		assert.equal((await saved(home, created.id)).workspace?.branch, branch);
		assert.deepEqual(lifecycle(manager, manager["metas"].get(created.id)!), active);
	} finally {
		releaseClone();
		releaseReady();
		releaseLookup();
		await manager.shutdown();
		await rm(home, { recursive: true, force: true });
	}
});

test("agent branch changes persist for the UI, clear the prior PR, and survive deleted refs", async () => {
	let chosen = branch;
	let hasPr = true;
	await fixture(
		{
			runner: async (_file, args) => {
				const head = args.find((arg) => arg.startsWith("--head="))!.slice("--head=".length);
				return JSON.stringify(hasPr ? [{ ...candidate(), headRefName: head }] : []);
			},
		},
		async (manager, meta, home, changes) => {
			await manager["pullRequests"]["polling"];
			const initial = lifecycle(manager, meta);
			chosen = "fix-branch-discovery";
			hasPr = false;
			await manager["pullRequests"].refresh(meta);
			assert.equal(manager.get(meta.id)?.branch, chosen);
			assert.equal(changes.at(-1)?.branch, chosen);
			assert.equal(manager.get(meta.id)?.pullRequest, undefined);
			assert.equal(manager.get(meta.id)?.pullRequestError, undefined);
			assert.equal((await saved(home, meta.id)).workspace?.branch, chosen);
			hasPr = true;
			await manager["pullRequests"].refresh(meta);
			assert.equal(manager.get(meta.id)?.pullRequest?.state, "open");
			chosen = "";
			await manager["pullRequests"].refresh(meta);
			assert.equal(manager.get(meta.id)?.branch, "fix-branch-discovery");
			assert.equal(manager.get(meta.id)?.pullRequest?.number, 10);
			assert.deepEqual(lifecycle(manager, meta), initial);
		},
		cached,
		() => chosen,
	);
});

test("draft/open/merged/closed PR changes persist and broadcast independently of agent completion", async () => {
	let state = "OPEN";
	let isDraft = true;
	const runner: Runner = async (_file, args) =>
		JSON.stringify(args.includes("--state=open") && state !== "OPEN" ? [] : [candidate(state, isDraft)]);
	await fixture({ runner }, async (manager, meta, home, changes) => {
		const initial = lifecycle(manager, meta);
		await manager["pullRequests"]["polling"];
		assert.equal(manager.get(meta.id)?.pullRequest?.state, "draft");
		for (const [remoteState, draft, expected] of [
			["OPEN", false, "open"],
			["MERGED", true, "merged"],
			["CLOSED", true, "closed"],
		] as const) {
			state = remoteState;
			isDraft = draft;
			await manager["pullRequests"].refresh(meta);
			assert.equal(changes.at(-1)?.pullRequest?.state, expected);
			assert.equal((await saved(home, meta.id)).pullRequest?.state, expected);
			assert.deepEqual(lifecycle(manager, meta), initial);
		}
		assert.equal(changes.length, 5, "merge also broadcasts the committed archive timestamp");
	});
});

test("failed and empty lookups retain last known badge and stale timestamp, dedupe identical errors, then recover", async () => {
	let mode = "error";
	await fixture(
		{
			runner: async (_file, args) => {
				if (mode === "error") throw new Error("authentication required");
				if (mode === "empty" || args.includes("--state=open")) return "[]";
				return JSON.stringify([candidate("MERGED", true)]);
			},
		},
		async (manager, meta, home, changes) => {
			const initial = lifecycle(manager, meta);
			await manager["pullRequests"]["polling"];
			assert.deepEqual(manager.get(meta.id)?.pullRequest, cached);
			assert.match(manager.get(meta.id)?.pullRequestError ?? "", /authentication required/);
			assert.equal(changes.length, 1);
			assert.equal((await saved(home, meta.id)).pullRequestError, meta.pullRequestError);
			await manager["pullRequests"].refresh(meta);
			assert.equal(changes.length, 1, "identical failures must not repeatedly broadcast");
			mode = "empty";
			await manager["pullRequests"].refresh(meta);
			assert.deepEqual(manager.get(meta.id)?.pullRequest, cached);
			assert.match(manager.get(meta.id)?.pullRequestError ?? "", /keeping last known status/);
			assert.equal(changes.length, 2);
			await manager["pullRequests"].refresh(meta);
			assert.equal(changes.length, 2);
			mode = "success";
			await manager["pullRequests"].refresh(meta);
			assert.equal(manager.get(meta.id)?.pullRequest?.state, "merged");
			assert.equal(manager.get(meta.id)?.pullRequestError, undefined);
			assert.ok(manager.get(meta.id)!.pullRequest!.checkedAt > cached.checkedAt);
			assert.equal(changes.length, 4, "successful merge recovery also archives the chat");
			assert.deepEqual(lifecycle(manager, meta), initial);
			assert.equal((await saved(home, meta.id)).pullRequestError, undefined);
		},
		cached,
	);
});

test("fresh merge archives durably, retains files, and restoration survives checks and restart", async () => {
	let number = 10;
	const runner: Runner = async (_file, args) =>
		args.includes("--state=open")
			? "[]"
			: JSON.stringify([{ ...candidate("MERGED"), number, url: `https://github.com/octo/repo/pull/${number}` }]);
	await fixture({ runner }, async (manager, meta, home, changes) => {
		await writeFile(join(meta.cwd, "work.txt"), "retained workspace");
		await mkdir(join(home, "sessions", meta.id, "durable"));
		await writeFile(join(home, "sessions", meta.id, "durable", "history"), "retained transcript");
		await manager["pullRequests"]["polling"];
		const archivedAt = manager.get(meta.id)!.archivedAt;
		assert.ok(archivedAt);
		assert.equal(changes.at(-1)?.archivedAt, archivedAt);
		assert.equal((await saved(home, meta.id)).archivedAt, archivedAt);
		assert.equal((await saved(home, meta.id)).autoArchivedPullRequest, cached.url);
		assert.ok(!manager.list().some((summary) => summary.id === meta.id));
		assert.equal(manager.list({ archived: "true" })[0]?.id, meta.id);
		assert.equal(await readFile(join(meta.cwd, "work.txt"), "utf8"), "retained workspace");
		assert.equal(
			await readFile(join(home, "sessions", meta.id, "durable", "history"), "utf8"),
			"retained transcript",
		);
		await manager["pullRequests"].refresh(meta);
		assert.equal(manager.get(meta.id)?.archivedAt, archivedAt, "repeated checks retain the archive timestamp");
		await manager.restore(meta.id);
		await manager["pullRequests"].refresh(meta);
		assert.equal(manager.get(meta.id)?.archivedAt, undefined);
		await manager.shutdown();
		const reopened = new SessionManager(
			home,
			new ProjectStore(home),
			undefined,
			{},
			{
				runner: async (file, args, ...rest) =>
					file === "git" && args[0] === "branch" ? "" : runner(file, args, ...rest),
			},
		);
		try {
			await reopened.load();
			await reopened["pullRequests"]["polling"];
			assert.equal(reopened.get(meta.id)?.archivedAt, undefined, "restoration survives a daemon restart");
			number = 11;
			await reopened["pullRequests"].refresh(reopened["metas"].get(meta.id)!);
			assert.ok(reopened.get(meta.id)?.archivedAt, "a different merged PR can archive the chat again");
		} finally {
			await reopened.shutdown();
		}
	});
});

test("draft, open, closed and failed lookups of a cached merge never auto-archive", async () => {
	for (const state of ["draft", "open", "closed", "stale"] as const) {
		await fixture(
			{
				runner: async (_file, args) => {
					if (state === "stale") throw new Error("offline");
					if (state === "closed" && args.includes("--state=open")) return "[]";
					return JSON.stringify([candidate(state === "closed" ? "CLOSED" : "OPEN", state === "draft")]);
				},
			},
			async (manager, meta, home) => {
				await manager["pullRequests"]["polling"];
				assert.equal(manager.get(meta.id)?.archivedAt, undefined, state);
				assert.equal((await saved(home, meta.id)).archivedAt, undefined, state);
			},
			{ ...cached, state: "merged" },
		);
	}
});

test("merge archiving defers all busy states and retries after the chat becomes inactive", async () => {
	let merged = false;
	const runner: Runner = async (_file, args) =>
		merged && args.includes("--state=open") ? "[]" : JSON.stringify([candidate(merged ? "MERGED" : "OPEN")]);
	await fixture({ runner }, async (manager, meta) => {
		await manager["pullRequests"]["polling"];
		const worker: Worker & { busy: boolean } = {
			ready: Promise.resolve(),
			state: "idle",
			busy: false,
			send: () => {},
			request: async () => {},
			close: async () => {},
		};
		manager["workers"].set(meta.id, worker);
		merged = true;
		const busyStates: [() => void, () => void][] = [
			[() => (meta.working = true), () => (meta.working = false)],
			[() => (meta.initializing = true), () => delete meta.initializing],
			[() => (meta.preparing = { source: meta.cwd }), () => delete meta.preparing],
			[
				() => (meta.pending = [{ type: "input", requestId: "queued", content: "Hi", mode: "followUp" }]),
				() => delete meta.pending,
			],
			[() => (worker.state = "starting"), () => (worker.state = "idle")],
			[() => (worker.state = "working"), () => (worker.state = "idle")],
			[() => (worker.busy = true), () => (worker.busy = false)],
			[() => manager["sending"].set(meta.id, 1), () => manager["sending"].delete(meta.id)],
		];
		for (const [start, stop] of busyStates) {
			start();
			await manager["pullRequests"].refresh(meta);
			assert.equal(meta.pullRequest?.state, "merged");
			assert.equal(meta.archivedAt, undefined);
			assert.equal(meta.autoArchivedPullRequest, undefined);
			stop();
		}
		await manager["pullRequests"].refresh(meta);
		assert.ok(meta.archivedAt);
	});
});

test("failed automatic archive writes leave the merge retryable and publish no archive", async () => {
	let merged = false;
	const runner: Runner = async (_file, args) =>
		merged && args.includes("--state=open") ? "[]" : JSON.stringify([candidate(merged ? "MERGED" : "OPEN")]);
	await fixture({ runner }, async (manager, meta, home, changes) => {
		await manager["pullRequests"]["polling"];
		const save = manager["save"].bind(manager);
		manager["save"] = async (current, archive) => {
			if (archive) throw new Error("disk full");
			await save(current);
		};
		try {
			merged = true;
			await manager["pullRequests"].refresh(meta);
			assert.equal(meta.pullRequest?.state, "merged");
			assert.equal(meta.archivedAt, undefined);
			assert.equal(meta.autoArchivedPullRequest, undefined);
			assert.equal((await saved(home, meta.id)).autoArchivedPullRequest, undefined);
			assert.ok(changes.every((summary) => summary.archivedAt === undefined));
			manager["save"] = save;
			await manager["pullRequests"].refresh(meta);
			assert.ok(meta.archivedAt);
			assert.equal((await saved(home, meta.id)).autoArchivedPullRequest, cached.url);
		} finally {
			manager["save"] = save;
		}
	});
});

test("queued lifecycle saves preserve the committed automatic archive marker", async () => {
	let merged = false;
	const runner: Runner = async (_file, args) =>
		merged && args.includes("--state=open") ? "[]" : JSON.stringify([candidate(merged ? "MERGED" : "OPEN")]);
	await fixture({ runner }, async (manager, meta, home) => {
		await manager["pullRequests"]["polling"];
		const save = manager["save"].bind(manager);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let stage!: () => void;
		const staged = new Promise<void>((resolve) => {
			stage = resolve;
		});
		manager["save"] = (current, archive) => {
			if (archive) manager["saving"].set(meta.id, gate);
			const writing = save(current, archive);
			if (archive) stage();
			return writing;
		};
		merged = true;
		const refresh = manager["pullRequests"].refresh(meta);
		try {
			await staged;
			assert.equal(meta.archivedAt, undefined, "archive state stays uncommitted during I/O");
			assert.equal(meta.autoArchivedPullRequest, undefined);
			manager["save"] = save;
			meta.model = "updated/model";
			const queuedSave = save(meta);
			release();
			await refresh;
			await queuedSave;
			const persisted = await saved(home, meta.id);
			assert.equal(persisted.model, "updated/model");
			assert.equal(persisted.archivedAt, meta.archivedAt);
			assert.equal(persisted.autoArchivedPullRequest, cached.url);
		} finally {
			release();
			manager["save"] = save;
			await refresh;
		}
	});
});

test("successful empty lookup without a cache clears discovery errors and cannot invent a badge", async () => {
	let fail = true;
	await fixture(
		{
			runner: async () => {
				if (fail) throw new Error("offline");
				return "[]";
			},
		},
		async (manager, meta) => {
			await manager["pullRequests"]["polling"];
			assert.match(manager.get(meta.id)?.pullRequestError ?? "", /offline/);
			fail = false;
			await manager["pullRequests"].refresh(meta);
			assert.equal(manager.get(meta.id)?.pullRequest, undefined);
			assert.equal(manager.get(meta.id)?.pullRequestError, undefined);
			assert.equal(manager.get(meta.id)?.outcome, "needs_input");
		},
	);
});

test("failed PR cache write rolls back only PR fields, so the identical lookup error retries and publishes after recovery", async () => {
	let offline = false;
	await fixture(
		{
			runner: async () => {
				if (offline) throw new Error("offline");
				return JSON.stringify([candidate()]);
			},
		},
		async (manager, meta, home, changes) => {
			await manager["pullRequests"]["polling"];
			const previous = structuredClone(meta.pullRequest);
			const save = manager["save"].bind(manager);
			let rejectWrite!: (error: Error) => void;
			let writing = false;
			const failingWrite = new Promise<void>((_resolve, reject) => {
				rejectWrite = reject;
			});
			manager["save"] = async () => {
				writing = true;
				await failingWrite;
			};
			offline = true;
			const refresh = manager["pullRequests"].refresh(meta);
			try {
				await until(() => writing);
				// Independent kernel metadata can change while the PR write awaits I/O.
				meta.outcome = "done";
				meta.outcomeAt = 42;
				meta.lastCompletionAt = 42;
				meta.lastOutcomeAt = 42;
				meta.updatedAt = 50;
				const independent = lifecycle(manager, meta);
				rejectWrite(new Error("disk full"));
				await refresh;
				assert.deepEqual(meta.pullRequest, previous);
				assert.equal(meta.pullRequestError, undefined);
				assert.equal(changes.length, 1, "failed persistence must not publish an uncommitted PR update");
				assert.deepEqual(
					lifecycle(manager, meta),
					independent,
					"must not roll back concurrent activity/outcome fields",
				);
				assert.equal((await saved(home, meta.id)).pullRequestError, undefined);
				manager["save"] = save;
				await manager["pullRequests"].refresh(meta);
				assert.match(meta.pullRequestError ?? "", /offline/);
				assert.deepEqual(meta.pullRequest, previous);
				assert.equal(
					changes.length,
					2,
					"identical lookup failure retries persistence then publishes its stale signal",
				);
				assert.equal((await saved(home, meta.id)).pullRequestError, meta.pullRequestError);
				assert.equal((await saved(home, meta.id)).outcomeAt, 42);
				assert.deepEqual(lifecycle(manager, meta), independent);
				await manager["pullRequests"].refresh(meta);
				assert.equal(changes.length, 2, "persisted repeated error remains deduplicated");
			} finally {
				rejectWrite(new Error("disk full"));
				manager["save"] = save;
				await refresh;
			}
		},
	);
});

test("restart exposes persisted badge/error immediately and immediately rechecks parked sessions", async () => {
	await fixture(
		{
			runner: async () => {
				throw new Error("offline");
			},
		},
		async (manager, meta, home) => {
			await manager["pullRequests"]["polling"];
			await manager.shutdown();
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let calls = 0;
			const reopened = new SessionManager(
				home,
				new ProjectStore(home),
				undefined,
				{},
				{
					runner: async (_file, args) => {
						if (_file === "git" && args[0] === "branch") return "";
						calls++;
						await gate;
						return args.includes("--state=open") ? "[]" : JSON.stringify([candidate("MERGED", true)]);
					},
				},
			);
			try {
				await reopened.load();
				assert.deepEqual(reopened.get(meta.id)?.pullRequest, cached);
				assert.match(reopened.get(meta.id)?.pullRequestError ?? "", /offline/);
				assert.equal(reopened["workers"].size, 0);
				await until(() => calls === 1);
				release();
				await reopened["pullRequests"]["polling"];
				assert.equal(reopened.get(meta.id)?.pullRequest?.state, "merged");
				assert.equal(reopened.get(meta.id)?.pullRequestError, undefined);
				assert.equal(reopened.get(meta.id)?.outcomeAt, 10);
				assert.equal(reopened.get(meta.id)?.updatedAt, 2);
			} finally {
				release();
				await reopened.shutdown();
			}
		},
		cached,
	);
});

test("settled kernel activity refreshes immediately, overlapping triggers dedupe, completion replay does not recheck", async () => {
	let calls = 0;
	await fixture(
		{
			runner: async () => {
				calls++;
				return JSON.stringify([candidate()]);
			},
		},
		async (manager, meta) => {
			await manager["pullRequests"]["polling"];
			assert.equal(calls, 1);
			const worker: Worker = {
				ready: Promise.resolve(),
				state: "idle",
				send: () => {},
				request: async () => {},
				close: async () => {},
			};
			manager["onPacket"](meta, worker, { type: "working", working: true });
			assert.equal(calls, 1);
			const packet = {
				type: "working" as const,
				working: false,
				completion: { outcome: "done" as const, outcomeAt: 20 },
			};
			manager["onPacket"](meta, worker, packet);
			const settled = lifecycle(manager, meta);
			manager["onPacket"](meta, worker, packet);
			await manager["pullRequests"].refresh(meta);
			assert.equal(calls, 2, "settled completion starts one deduplicated immediate lookup");
			assert.equal(meta.outcome, "done");
			assert.equal(meta.outcomeAt, 20);
			assert.deepEqual(lifecycle(manager, meta), settled);
			manager["onPacket"](meta, worker, packet);
			await delay(5);
			assert.equal(calls, 2, "replayed completion must not cause another lookup");
		},
	);
});

test("daemon polls even with no watchers/workers, and shutdown drains and persists an active lookup", async () => {
	let state = "OPEN";
	let calls = 0;
	await fixture(
		{
			intervalMs: 10,
			runner: async (_file, args) => {
				calls++;
				return args.includes("--state=open") && state !== "OPEN" ? "[]" : JSON.stringify([candidate(state)]);
			},
		},
		async (manager, meta) => {
			await manager["pullRequests"]["polling"];
			const initial = lifecycle(manager, meta);
			state = "MERGED";
			await until(() => manager.get(meta.id)?.pullRequest?.state === "merged");
			assert.equal(manager["watchers"].size, 0);
			assert.equal(manager["workers"].size, 0);
			assert.deepEqual(lifecycle(manager, meta), initial);
			await manager.shutdown();
			const stopped = calls;
			await delay(30);
			assert.equal(calls, stopped);
		},
	);

	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started = false;
	await fixture(
		{
			runner: async () => {
				started = true;
				await gate;
				return JSON.stringify([candidate()]);
			},
		},
		async (manager, meta, home) => {
			try {
				await until(() => started);
				let finished = false;
				const shuttingDown = manager.shutdown().then(() => {
					finished = true;
				});
				await delay(5);
				assert.equal(finished, false, "shutdown waits for in-flight GitHub lookup and metadata persistence");
				release();
				await shuttingDown;
				assert.equal((await saved(home, meta.id)).pullRequest?.number, 10);
				assert.equal((await saved(home, meta.id)).outcomeAt, 10);
			} finally {
				release();
			}
		},
	);
});

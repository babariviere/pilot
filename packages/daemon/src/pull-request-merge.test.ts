// biome-ignore-all lint/complexity/useLiteralKeys: Test registry and scheduler seams without live workers.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MergePullRequestRequest } from "@pilot/protocol";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { mergeTarget, PullRequestMerger } from "./pull-request-merge.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import type { Runner } from "./workspaces.ts";

const url = "https://github.com/octo/repo/pull/42";
const sha = "a".repeat(40);
const request: MergePullRequestRequest = { url, headSha: sha, baseBranch: "main", method: "squash" };

function fixture() {
	const calls: string[][] = [];
	const pr = {
		title: "Fix export",
		state: "open",
		draft: false,
		merged: false,
		head: { sha, ref: "fix/export" },
		base: { ref: "main" },
	};
	const repo = { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false };
	let result: unknown = { merged: true };
	const runner: Runner = async (file, args, cwd, timeout) => {
		assert.equal(file, "gh");
		assert.equal(cwd, "/project");
		assert.equal(timeout, 20_000);
		calls.push([...args]);
		if (args.includes("PUT")) {
			if (result instanceof Error) throw result;
			return JSON.stringify(result);
		}
		return JSON.stringify(args[5] === "repos/octo/repo" ? repo : pr);
	};
	return {
		calls,
		pr,
		repo,
		merger: new PullRequestMerger(runner),
		result: (value: unknown) => {
			result = value;
		},
	};
}

test("merge confirmation reads the explicit repository and offers only allowed methods", async () => {
	const f = fixture();
	const preview = await f.merger.preview(url, "/project");
	assert.deepEqual(preview, {
		url,
		number: 42,
		title: "Fix export",
		headSha: sha,
		headBranch: "fix/export",
		baseBranch: "main",
		methods: ["squash", "merge"],
	});
	assert.deepEqual(f.calls, [
		["api", "--hostname", "github.com", "--method", "GET", "repos/octo/repo/pulls/42"],
		["api", "--hostname", "github.com", "--method", "GET", "repos/octo/repo"],
	]);
	await f.merger.merge(request, preview, "/project");
	assert.deepEqual(f.calls[2], [
		"api",
		"--hostname",
		"github.com",
		"--method",
		"PUT",
		"repos/octo/repo/pulls/42/merge",
		"-f",
		`sha=${sha}`,
		"-f",
		"merge_method=squash",
	]);
});

test("changed heads, retargets and disabled methods never issue a mutation", async () => {
	const f = fixture();
	const preview = await f.merger.preview(url, "/project");
	for (const changed of [{ headSha: "b".repeat(40) }, { baseBranch: "release" }, { method: "rebase" as const }])
		await assert.rejects(f.merger.merge({ ...request, ...changed }, preview, "/project"), /changed|not available/);
	assert.equal(f.calls.length, 2);
});

test("draft, closed, merged and methodless repositories cannot be confirmed", async () => {
	for (const patch of [{ draft: true }, { state: "closed" }, { merged: true }]) {
		const f = fixture();
		Object.assign(f.pr, patch);
		await assert.rejects(f.merger.preview(url, "/project"), /open|already merged/);
	}
	const f = fixture();
	f.repo.allow_squash_merge = false;
	f.repo.allow_merge_commit = false;
	await assert.rejects(f.merger.preview(url, "/project"), /no available merge methods/);
});

test("GitHub protection failures and uncertain outcomes are surfaced without retries", async () => {
	for (const result of [{ merged: false, message: "Required checks pending" }, new Error("connection lost")]) {
		const f = fixture();
		const preview = await f.merger.preview(url, "/project");
		f.result(result);
		await assert.rejects(f.merger.merge(request, preview, "/project"), /checks pending|connection lost/);
		assert.equal(f.calls.filter((args) => args.includes("PUT")).length, 1);
	}
});

test("PR actions reject duplicates, cap concurrency and release on failure", async () => {
	const merger = new PullRequestMerger();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const active = [url, `${url}0`, `${url}1`].map((key) => merger.perform(key, () => gate));
	await assert.rejects(
		merger.perform(url.toUpperCase(), async () => {}),
		/already has an action/,
	);
	await assert.rejects(
		merger.perform(`${url}2`, async () => {}),
		/Other pull request actions/,
	);
	release();
	await Promise.all(active);
	await assert.rejects(
		merger.perform(url, async () => {
			throw new Error("failed");
		}),
		/failed/,
	);
	await merger.perform(url, async () => {});
});

test("shutdown drains an admitted PR action before returning", async () => {
	const merger = new PullRequestMerger();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const action = merger.perform(url, () => gate);
	let drained = false;
	const drain = merger.settled().then(() => {
		drained = true;
	});
	await Promise.resolve();
	assert.equal(drained, false);
	release();
	await Promise.all([action, drain]);
	assert.equal(drained, true);
});

test("merge targets reject credentials, ports, schemes and non-PR paths", () => {
	for (const value of [
		"http://github.com/o/r/pull/1",
		"https://x@y/o/r/pull/1",
		"https://github.com:8443/o/r/pull/1",
		`${url}?a=1`,
		`${url}#merge`,
		"https://github.com/o/r/issues/1",
		"https://github.com/o/r/pull/0",
	])
		assert.throws(() => mergeTarget(value));
	assert.equal(mergeTarget("https://git.example.com/o/r/pull/1").repo.host, "git.example.com");
});

test("native merge routes validate confirmation fields and browser origins", async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const previews = t.mock.method(sessions, "previewPullRequestMerge", async () => ({ headSha: sha }));
	const merges = t.mock.method(sessions, "mergePullRequest", async () => {});
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/s/pull-requests`;
	const post = (path: string, body: unknown, origin?: string) =>
		fetch(`${base}/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(origin ? { origin } : {}) },
			body: JSON.stringify(body),
		});
	const preview = await post("merge-preview", { url });
	assert.equal(preview.status, 200);
	await preview.arrayBuffer();
	const merged = await post("merge", request);
	assert.equal(merged.status, 200);
	assert.deepEqual(await merged.json(), { merged: true });
	assert.deepEqual(merges.mock.calls[0]!.arguments, ["s", request]);
	for (const body of [
		null,
		{},
		{ url: "" },
		{ ...request, method: "admin" },
		{ ...request, headSha: "" },
		{ ...request, baseBranch: "" },
	]) {
		const response = await post("merge", body);
		assert.equal(response.status, 400);
		await response.arrayBuffer();
	}
	const denied = await post("merge", request, "https://example.com");
	assert.equal(denied.status, 403);
	await denied.arrayBuffer();
	assert.equal(previews.mock.callCount(), 1);
	assert.equal(merges.mock.callCount(), 1);
});

test("registry revalidates linkage after confirmation reads and refreshes only on success", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-pr-merge-"));
	const projects = new ProjectStore(home);
	const project = await projects.create({ path: home, workspace: "direct" });
	const id = randomUUID();
	const meta = {
		id,
		projectId: project.id,
		mode: "build",
		title: "Chat",
		cwd: home,
		createdAt: 1,
		updatedAt: 1,
		working: false,
		pullRequest: { number: 42, url, title: "PR", state: "open", checkedAt: 1 },
	};
	await mkdir(join(home, "sessions", id), { recursive: true });
	await writeFile(join(home, "sessions", id, "meta.json"), JSON.stringify(meta));
	const f = fixture();
	let reads = 0;
	let mutations = 0;
	let detach = false;
	const manager = new SessionManager(
		home,
		projects,
		undefined,
		{ title: async () => undefined },
		{
			runner: async (file, args) => {
				if (file === "git") return "https://github.com/octo/repo.git";
				if (args.includes("PUT")) {
					mutations++;
					return JSON.stringify({ merged: true });
				}
				reads++;
				if (detach) manager["metas"].get(id)!.unboundPullRequests = [url];
				return JSON.stringify(args[5] === "repos/octo/repo" ? f.repo : f.pr);
			},
			intervalMs: 3_600_000,
		},
	);
	t.after(async () => {
		await manager.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await manager.load();
	const refresh = t.mock.method(manager["pullRequests"], "refresh", async () => {});
	await assert.rejects(
		manager.previewPullRequestMerge(id, "https://github.com/other/repo/pull/42"),
		/project repository/,
	);
	await assert.rejects(manager.previewPullRequestMerge(id, `${url}0`), /no longer linked/);
	assert.equal(reads, 0);
	await manager.mergePullRequest(id, request);
	assert.equal(mutations, 1);
	assert.equal(refresh.mock.callCount(), 1);
	await assert.rejects(manager.mergePullRequest(id, { ...request, headSha: "b".repeat(40) }), /changed/);
	assert.equal(mutations, 1);
	detach = true;
	await assert.rejects(manager.mergePullRequest(id, request), /no longer linked/);
	assert.equal(mutations, 1);
	assert.equal(refresh.mock.callCount(), 1);
});

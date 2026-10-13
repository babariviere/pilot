import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SharedWorkspaceStore } from "./shared-workspaces.ts";
import { fixture, git, jj } from "./testing/shared-workspace.ts";
import { type Runner, run } from "./workspaces.ts";

test("selected origin branches fetch fresh tips, default offline bases fall back, and explicit offline selections fail", async () => {
	const f = fixture();
	try {
		const remote = join(f.root, "remote.git");
		git(f.root, "init", "--quiet", "--bare", "-b", "release", remote);
		git(f.source, "remote", "add", "origin", "../remote.git");
		git(f.source, "push", "--quiet", "origin", "HEAD:release");
		git(f.source, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
		const w = await f.store.create(f.source, f.path(), undefined, "release");
		assert.equal(w.baseBranch, "release");
		assert.equal(w.base, git(remote, "rev-parse", "refs/heads/release"));
		const publisher = join(f.root, "publisher");
		git(f.root, "clone", "--quiet", remote, publisher);
		writeFileSync(join(publisher, "a.txt"), "fresh tip\n");
		git(publisher, "commit", "--quiet", "-am", "fresh");
		git(publisher, "push", "--quiet", "origin", "HEAD");
		const fresh = await f.store.create(f.source, f.path("fresh"), undefined, "release");
		assert.equal(fresh.base, git(publisher, "rev-parse", "HEAD"));
		assert.equal(readFileSync(join(fresh.path, "a.txt"), "utf8"), "fresh tip\n");
		writeFileSync(join(publisher, "a.txt"), "agent-fetched tip\n");
		git(publisher, "commit", "--quiet", "-am", "newer");
		git(publisher, "push", "--quiet", "origin", "HEAD");
		jj(w.path, "git", "fetch", "--remote", "origin", "--branch", "release");
		rmSync(remote, { recursive: true, force: true });
		const offline = await f.store.create(f.source, f.path("offline"));
		assert.equal(offline.baseBranch, "release");
		// Both source and daemon cache are older than the agent's jj view. Never rewind it offline.
		assert.equal(offline.base, git(publisher, "rev-parse", "HEAD"));
		assert.notEqual(offline.base, git(f.source, "rev-parse", "refs/remotes/origin/release"));
		// Refs the shared repository lacks, or that the source has moved forward, are still seeded.
		git(f.source, "update-ref", "refs/remotes/origin/source-only", git(f.source, "rev-parse", "HEAD"));
		await f.store.create(f.source, f.path("seeded"));
		assert.equal(
			git(w.shared!.repository, "rev-parse", "refs/pilot/origin/source-only"),
			git(f.source, "rev-parse", "HEAD"),
		);
		await assert.rejects(
			f.store.create(f.source, f.path("selected-offline"), undefined, "release"),
			/Origin branch unavailable/,
		);
		await assert.rejects(f.store.create(f.source, f.path("invalid"), undefined, "main~1"), /valid exact/);
	} finally {
		f.close();
	}
});

test("a local-only source's newly published HEAD is imported without rewriting existing workspaces", async () => {
	const f = fixture();
	try {
		const first = await f.store.create(f.source, f.path());
		const initial = jj(first.path, "--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id");
		writeFileSync(join(f.source, "a.txt"), "local published tip\n");
		jj(f.source, "commit", "-m", "local published tip");
		const sourceRefs = git(f.source, "show-ref");
		const next = await f.store.create(f.source, f.path("local-new"));
		assert.equal(next.base, git(f.source, "rev-parse", "HEAD"));
		assert.equal(readFileSync(join(next.path, "a.txt"), "utf8"), "local published tip\n");
		assert.equal(jj(first.path, "--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id"), initial);
		assert.equal(git(f.source, "show-ref"), sourceRefs);
	} finally {
		f.close();
	}
});

for (const boundary of ["base import", "workspace add", "partial cleanup"] as const) {
	test(`concurrent push and launch at ${boundary} preserves refs and sibling files despite stale colocated Git refs`, async () => {
		const barrier = () => {
			let resolve!: () => void;
			const promise = new Promise<void>((done) => {
				resolve = done;
			});
			return { promise, resolve };
		};
		const reached = barrier();
		const resume = barrier();
		let armed = false;
		const runner: Runner = async (file, args, cwd, ...rest) => {
			const atBoundary =
				boundary === "base import"
					? args.includes("import") || (args.includes("fetch") && args.includes("exact:pilot-base"))
					: boundary === "workspace add"
						? args.includes("workspace") && args.includes("add")
						: args.includes("colocation") && args.includes("enable");
			const hit = armed && file === "jj" && atBoundary;
			if (hit) {
				armed = false;
				reached.resolve();
				await resume.promise;
			}
			const result = await run(file, args, cwd, ...rest);
			if (hit && boundary === "partial cleanup") throw new Error("simulated launch cancellation");
			return result;
		};
		const f = fixture(runner);
		let launching: Promise<unknown> | undefined;
		try {
			const remote = join(f.root, "remote.git");
			git(f.root, "init", "--quiet", "--bare", "-b", "main", remote);
			git(f.source, "remote", "add", "origin", remote);
			git(f.source, "push", "--quiet", "origin", "HEAD:main");
			const staleMain = git(remote, "rev-parse", "main");
			const a = await f.store.create(f.source, f.path());
			const b = await f.store.create(f.source, f.path("sibling"));
			const repository = a.shared!.repository;
			// A different publisher moves main. The source's origin view deliberately stays old.
			const publisher = join(f.root, "publisher");
			git(f.root, "clone", "--quiet", remote, publisher);
			writeFileSync(join(publisher, "a.txt"), "fresh main\n");
			git(publisher, "commit", "--quiet", "-am", "fresh main");
			git(publisher, "push", "--quiet", "origin", "HEAD:main");
			const freshMain = git(remote, "rev-parse", "main");
			jj(a.path, "git", "fetch", "--remote", "origin", "--branch", "main");
			// The launch selects a still newer base that jj has not indexed, exercising the private import.
			writeFileSync(join(publisher, "a.txt"), "launch base\n");
			git(publisher, "commit", "--quiet", "-am", "launch base");
			git(publisher, "push", "--quiet", "origin", "HEAD:main");
			const launchBase = git(remote, "rev-parse", "main");
			writeFileSync(join(a.path, "implementation.txt"), "published implementation\n");
			jj(a.path, "commit", "-m", "implementation");
			const bookmark = "feat/concurrent-import";
			jj(a.path, "bookmark", "create", bookmark, "-r", "@-");
			const published = jj(a.path, "log", "--no-graph", "-r", "@-", "-T", "commit_id");
			writeFileSync(join(b.path, "sibling.txt"), "unpushed sibling\n");
			jj(b.path, "commit", "-m", "sibling implementation");
			writeFileSync(join(b.path, "dirty.txt"), "ongoing edits\n");
			jj(b.path, "status");
			git(repository, "update-ref", "refs/tags/agent-only", staleMain);
			git(remote, "update-ref", "refs/tags/upstream-only", launchBase);
			const state = (path: string) =>
				jj(
					path,
					"--ignore-working-copy",
					"log",
					"--no-graph",
					"-r",
					"@",
					"-T",
					'commit_id ++ change_id ++ parents.map(|p| p.commit_id()).join(",")',
				);
			const before = [state(a.path), state(b.path), state(repository)];
			// The launch has already fetched its base when the agent's push completes. Reproduce the
			// incident's stale Git view without touching jj's refs, then let daemon synchronization run.
			armed = true;
			launching = f.store.create(f.source, f.path("launched"));
			await Promise.race([
				reached.promise,
				launching.then(() => {
					throw new Error("boundary was not reached");
				}),
			]);
			await run(
				"jj",
				["--config=user.name=t", "--config=user.email=t@t", "git", "push", "--bookmark", bookmark],
				a.path,
			);
			git(repository, "update-ref", "refs/remotes/origin/main", staleMain);
			git(repository, "update-ref", "-d", `refs/remotes/origin/${bookmark}`);
			git(repository, "update-ref", "-d", `refs/heads/${bookmark}`);
			resume.resolve();
			if (boundary === "partial cleanup") {
				await assert.rejects(launching, /simulated launch cancellation/);
				await f.store.discardPartial(f.path("launched"), f.source);
				assert.equal(existsSync(f.path("launched")), false);
			} else {
				const launched = (await launching) as Awaited<ReturnType<SharedWorkspaceStore["create"]>>;
				assert.equal(launched.base, launchBase);
				assert.equal(readFileSync(join(launched.path, "a.txt"), "utf8"), "launch base\n");
			}
			assert.deepEqual([state(a.path), state(b.path), state(repository)], before);
			for (const ref of [bookmark, `${bookmark}@origin`])
				assert.equal(
					jj(a.path, "--ignore-working-copy", "log", "--no-graph", "-r", ref, "-T", "commit_id"),
					published,
				);
			assert.equal(
				jj(a.path, "--ignore-working-copy", "log", "--no-graph", "-r", "main@origin", "-T", "commit_id"),
				freshMain,
			);
			assert.equal(
				jj(a.path, "--ignore-working-copy", "log", "--no-graph", "-r", `${published} & all()`, "-T", "commit_id"),
				published,
			);
			assert.equal(git(remote, "rev-parse", `refs/heads/${bookmark}`), published);
			// No opportunistic ref updates, pruning or export of unrelated refs during preparation.
			assert.equal(git(repository, "rev-parse", "refs/remotes/origin/main"), staleMain);
			assert.equal(git(repository, "rev-parse", "refs/tags/agent-only"), staleMain);
			assert.equal(git(repository, "tag", "--list", "upstream-only"), "");
			// Restore the deliberately corrupted test Git view before exercising ordinary agent commands,
			// which intentionally retain jj's normal Git-import semantics.
			git(repository, "update-ref", "refs/remotes/origin/main", freshMain);
			git(repository, "update-ref", `refs/remotes/origin/${bookmark}`, published);
			git(repository, "update-ref", `refs/heads/${bookmark}`, published);
			jj(a.path, "workspace", "update-stale");
			jj(b.path, "workspace", "update-stale");
			assert.deepEqual([state(a.path), state(b.path)], before.slice(0, 2));
			assert.equal(readFileSync(join(a.path, "implementation.txt"), "utf8"), "published implementation\n");
			assert.equal(readFileSync(join(b.path, "sibling.txt"), "utf8"), "unpushed sibling\n");
			assert.equal(readFileSync(join(b.path, "dirty.txt"), "utf8"), "ongoing edits\n");
			assert.equal(git(f.source, "rev-parse", "refs/remotes/origin/main"), staleMain);
		} finally {
			resume.resolve();
			await launching?.catch(() => {});
			f.close();
		}
	});
}

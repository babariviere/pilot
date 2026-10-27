import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SharedWorkspaceStore } from "./shared-workspaces.ts";
import { fixture, git, jj } from "./testing/shared-workspace.ts";

test("concurrent children share an independent repository, pin bases, leave source untouched and use linked .git", async () => {
	const f = fixture();
	try {
		writeFileSync(join(f.source, "a.txt"), "source dirty\n");
		const before = git(f.source, "show-ref");
		const [a, b] = await Promise.all([
			f.store.create(f.source, f.path()),
			f.store.create(f.source, f.path("session-b")),
		]);
		assert.equal(a.shared!.repository, b.shared!.repository);
		assert.notEqual(a.shared!.name, b.shared!.name);
		const control = join(a.shared!.repository, ".jj/pilot-control");
		assert.equal(existsSync(join(control, ".git")), false);
		assert.equal(
			jj(control, "--ignore-working-copy", "log", "--no-graph", "-r", "@-", "-T", "commit_id"),
			"0".repeat(40),
		);
		assert.match(a.shared!.name, /session-a/);
		assert.match(a.base, /^[0-9a-f]{40}$/);
		assert.equal(git(a.shared!.repository, "rev-parse", `refs/pilot/base/${a.shared!.name}`), a.base);
		assert.equal(existsSync(join(a.shared!.repository, ".git/objects/info/alternates")), false);
		assert.equal(git(f.source, "show-ref"), before);
		assert.equal(readFileSync(join(f.source, "a.txt"), "utf8"), "source dirty\n");
		assert.equal(readFileSync(join(a.path, "a.txt"), "utf8"), "base\n");
		assert.match(readFileSync(join(a.path, ".git"), "utf8"), /^gitdir: .*\.git\/worktrees\//);
		assert.equal(
			git(a.path, "rev-parse", "--path-format=absolute", "--git-common-dir"),
			`${a.shared!.repository}/.git`,
		);
		rmSync(f.source, { recursive: true, force: true });
		git(a.path, "fsck", "--connectivity-only", "--no-dangling");
		const recovery = await f.store.snapshot(a.path, a.shared!, f.recovery);
		await f.store.remove(a.path, a.shared!, recovery);
		await f.store.restore(a.path, a.shared!, recovery, f.recovery);
		assert.equal(jj(a.path, "log", "--no-graph", "-r", "@", "-T", "commit_id"), recovery.commitId);
	} finally {
		f.close();
	}
});

test("dirty edits, unpushed stack, local configs and exact change survive removal, GC and offline restore", async () => {
	const f = fixture();
	try {
		for (const config of [
			"mise.local.toml",
			".mise.local.toml",
			"mise/config.local.toml",
			".mise/config.local.toml",
		]) {
			mkdirSync(dirname(join(f.source, config)), { recursive: true });
			writeFileSync(join(f.source, config), `input ${config}\n`);
		}
		const w = await f.store.create(f.source, f.path());
		writeFileSync(join(w.path, "a.txt"), "stack one\n");
		jj(w.path, "commit", "-m", "unpushed");
		writeFileSync(join(w.path, "a.txt"), "dirty final\n");
		writeFileSync(join(w.path, "new.txt"), "new tracked by jj\n");
		writeFileSync(join(w.path, "mise.local.toml"), "session specific\n");
		mkdirSync(join(w.path, "node_modules"));
		writeFileSync(join(w.path, "node_modules", "generated"), "regenerable\n");
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		assert.equal(Object.keys(recovery.localConfigs).length, 4);
		assert.equal(git(w.shared!.repository, "rev-parse", recovery.archiveRef), recovery.commitId);
		assert.equal(jj(w.path, "bookmark", "list"), "");
		await f.store.remove(w.path, w.shared!, recovery);
		await f.store.remove(w.path, w.shared!, recovery);
		assert.equal(existsSync(w.path), false);
		jj(w.shared!.repository, "util", "gc", "--expire=now");
		git(w.shared!.repository, "gc", "--prune=now");
		rmSync(f.source, { recursive: true, force: true });
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(readFileSync(join(w.path, "a.txt"), "utf8"), "dirty final\n");
		assert.equal(readFileSync(join(w.path, "new.txt"), "utf8"), "new tracked by jj\n");
		assert.equal(readFileSync(join(w.path, "mise.local.toml"), "utf8"), "session specific\n");
		assert.equal(jj(w.path, "log", "--no-graph", "-r", "@", "-T", "change_id"), recovery.changeId);
		assert.equal(jj(w.path, "log", "--no-graph", "-r", "@", "-T", "commit_id"), recovery.commitId);
		assert.match(jj(w.path, "log", "--no-graph", "-r", "@-", "-T", "description"), /unpushed/);
		assert.equal(existsSync(join(w.path, "node_modules")), false);
	} finally {
		f.close();
	}
});

test("empty saved change remains jj-resolvable and restores exact IDs after both GCs", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, recovery);
		jj(w.shared!.repository, "util", "gc", "--expire=now");
		git(w.shared!.repository, "gc", "--prune=now");
		assert.equal(
			jj(
				w.shared!.repository,
				"log",
				"--ignore-working-copy",
				"--no-graph",
				"-r",
				recovery.commitId,
				"-T",
				"change_id",
			),
			recovery.changeId,
		);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(jj(w.path, "log", "--no-graph", "-r", "@", "-T", "commit_id"), recovery.commitId);
	} finally {
		f.close();
	}
});

test("daily maintenance abandons unreferenced originals of commits that landed rewritten elsewhere", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		const repository = w.shared!.repository;
		const head = () => jj(w.path, "log", "--no-graph", "-r", "@-", "-T", "commit_id");
		// Same change ID, new commit: what a jj rewrite in another repository pushes to origin.
		const rewrite = (commit: string) =>
			execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
				cwd: repository,
				encoding: "utf8",
				input: execFileSync("git", ["cat-file", "commit", commit], { cwd: repository, encoding: "utf8" }).replace(
					/\n\n/,
					"\n\nlanded: ",
				),
			}).trim();
		writeFileSync(join(w.path, "one.txt"), "one\n");
		jj(w.path, "commit", "-m", "one");
		const one = head();
		jj(w.path, "new", w.base);
		writeFileSync(join(w.path, "two.txt"), "two\n");
		jj(w.path, "commit", "-m", "two");
		const two = head();
		const twoChange = jj(w.path, "log", "--no-graph", "-r", two, "-T", "change_id");
		git(repository, "push", "--quiet", f.source, `${rewrite(one)}:refs/heads/landed-one`);
		git(repository, "push", "--quiet", f.source, `${rewrite(two)}:refs/heads/landed-two`);
		// The local "two" is amended after landing, so its diff no longer matches the landed copy.
		jj(w.path, "edit", two);
		writeFileSync(join(w.path, "two.txt"), "two amended\n");
		jj(w.path, "new", w.base);
		const amended = jj(w.path, "log", "--no-graph", "-r", `change_id(${twoChange})`, "-T", "commit_id");
		jj(w.path, "git", "fetch", "--remote", "origin");
		const divergent = () =>
			jj(w.path, "log", "--no-graph", "-r", "divergent()", "-T", 'commit_id ++ "\\n"').split("\n").sort();
		assert.equal(divergent().length, 4);
		assert.equal(await f.store.maintain(repository), true);
		const left = divergent();
		assert.equal(left.length, 2, "only the amended change stays divergent");
		assert.ok(left.includes(amended));
		assert.equal(jj(w.path, "log", "--no-graph", "-r", `${one} & ::visible_heads()`, "-T", "commit_id"), "");
	} finally {
		f.close();
	}
});

test("daily maintenance packs objects, persists its schedule and keeps live and saved workspaces intact", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		const live = await f.store.create(f.source, f.path("session-b"));
		writeFileSync(join(w.path, "a.txt"), "dirty final\n");
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, recovery);
		writeFileSync(join(live.path, "a.txt"), "live work\n");
		jj(live.path, "status");
		const repository = w.shared!.repository;
		assert.deepEqual(await f.store.repositories(), [repository]);
		assert.doesNotMatch(git(repository, "count-objects", "-v"), /^count: 0$/m);
		const now = Date.now();
		assert.equal(await f.store.maintain(repository, now), true);
		assert.match(git(repository, "count-objects", "-v"), /^count: 0$/m, "git gc packed loose objects");
		assert.equal(await f.store.maintain(repository, now + 1), false, "at most one run a day");
		const restarted = new SharedWorkspaceStore(join(f.root, "home"));
		assert.equal(await restarted.maintain(repository, now + 86_400_000 - 1), false, "persisted across restarts");
		assert.equal(await restarted.maintain(repository, now + 86_400_000), true);
		assert.match(jj(live.path, "diff", "--name-only"), /a\.txt/);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(readFileSync(join(w.path, "a.txt"), "utf8"), "dirty final\n");
		assert.equal(jj(w.path, "log", "--no-graph", "-r", "@", "-T", "commit_id"), recovery.commitId);
	} finally {
		f.close();
	}
});

test("a working copy left stale by another workspace's rewrite is updated before reclamation", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		writeFileSync(join(w.path, "a.txt"), "edited\n");
		jj(w.path, "status");
		const commit = jj(w.path, "log", "--no-graph", "-r", "@", "-T", "commit_id");
		// A sibling rewrites this child's commit onto a different tree, as a Git import rebasing it would.
		const sibling = await f.store.create(f.source, f.path("session-b"));
		writeFileSync(join(sibling.path, "b.txt"), "sibling\n");
		jj(sibling.path, "commit", "-m", "sibling");
		const parent = jj(sibling.path, "log", "--no-graph", "-r", "@-", "-T", "commit_id");
		jj(w.shared!.repository, "--ignore-working-copy", "rebase", "-r", commit, "-d", parent);
		assert.throws(() => jj(w.path, "status"), /stale/);
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		assert.notEqual(recovery.commitId, commit);
		assert.equal(existsSync(join(w.path, ".git")), true);
		assert.equal(existsSync(join(w.path, ".jj/pilot-refresh-git")), false);
		await f.store.remove(w.path, w.shared!, recovery);
		assert.equal(existsSync(w.path), false);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(readFileSync(join(w.path, "a.txt"), "utf8"), "edited\n");
		assert.equal(readFileSync(join(w.path, "b.txt"), "utf8"), "sibling\n");
	} finally {
		f.close();
	}
});

test("merge conflicts survive exact recovery", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		writeFileSync(join(w.path, "a.txt"), "left\n");
		jj(w.path, "describe", "-m", "left");
		const left = jj(w.path, "log", "--no-graph", "-r", "@", "-T", "commit_id");
		jj(w.path, "new", w.base);
		writeFileSync(join(w.path, "a.txt"), "right\n");
		jj(w.path, "describe", "-m", "right");
		jj(w.path, "new", left, "@");
		assert.equal(jj(w.path, "log", "--no-graph", "-r", "@", "-T", "conflict"), "true");
		const content = readFileSync(join(w.path, "a.txt"), "utf8");
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, recovery);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(readFileSync(join(w.path, "a.txt"), "utf8"), content);
		assert.equal(jj(w.path, "log", "--no-graph", "-r", "@", "-T", "conflict"), "true");
		assert.equal(jj(w.path, "log", "--no-graph", "-r", "@", "-T", "change_id"), recovery.changeId);
	} finally {
		f.close();
	}
});

test("jj-omitted files block cleanup but ignored files and unsafe ignored configs do not", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		for (const [name, config] of [
			["huge.txt", "snapshot.max-new-file-size=1"],
			["not-autotracked.txt", "snapshot.auto-track=none()"],
		] as const) {
			if (config) jj(w.path, "config", "set", "--repo", ...config.split("="));
			writeFileSync(join(w.path, name), "precious input\n");
			await assert.rejects(f.store.snapshot(w.path, w.shared!, f.recovery), /Unsafe .*path prevents cleanup/);
			assert.equal(existsSync(join(w.path, name)), true);
			rmSync(join(w.path, name));
		}
		jj(w.path, "config", "set", "--repo", "snapshot.auto-track", "all()");
		writeFileSync(join(w.path, ".env"), "discard ignored input\n");
		symlinkSync(join(f.root, "outside"), join(w.path, "mise.local.toml"));
		assert.deepEqual((await f.store.snapshot(w.path, w.shared!, f.recovery)).localConfigs, {});
		rmSync(join(w.path, "mise.local.toml"));
		mkdirSync(join(f.root, "outside"));
		writeFileSync(join(f.root, "outside/config.local.toml"), "secret\n");
		symlinkSync(join(f.root, "outside"), join(w.path, "mise"));
		await assert.rejects(f.store.snapshot(w.path, w.shared!, f.recovery), /Unsafe .*path/);
		writeFileSync(join(w.path, ".gitignore"), `${readFileSync(join(w.path, ".gitignore"), "utf8")}\nmise\n`);
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, recovery);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(existsSync(join(w.path, ".env")), false);
		assert.equal(existsSync(join(w.path, "mise")), false);
		assert.equal(readFileSync(join(f.root, "outside/config.local.toml"), "utf8"), "secret\n");
	} finally {
		f.close();
	}
});

test("removal validates changed state and corrupt path/repository bindings before deleting anything", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await assert.rejects(f.store.remove(f.source, w.shared!, recovery), /binding mismatch/);
		await assert.rejects(f.store.remove(w.path, { ...w.shared!, repository: f.source }, recovery), /not owned/);
		await assert.rejects(f.store.remove(w.path, w.shared!, { ...recovery, name: "default" }), /Invalid .*recovery/);
		writeFileSync(join(w.path, "a.txt"), "new edit\n");
		await assert.rejects(f.store.remove(w.path, w.shared!, recovery), /changed since recovery/);
		assert.equal(readFileSync(join(w.path, "a.txt"), "utf8"), "new edit\n");
		assert.equal(existsSync(join(f.source, ".git")), true);
	} finally {
		f.close();
	}
});

test("missing archived object fails restore without creating a child or fetching origin", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		writeFileSync(join(w.path, "a.txt"), "unique loose snapshot\n");
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, recovery);
		const object = join(
			w.shared!.repository,
			".git/objects",
			recovery.commitId.slice(0, 2),
			recovery.commitId.slice(2),
		);
		assert.equal(existsSync(object), true);
		rmSync(object);
		await assert.rejects(f.store.restore(w.path, w.shared!, recovery, f.recovery));
		assert.equal(existsSync(w.path), false);
	} finally {
		f.close();
	}
});

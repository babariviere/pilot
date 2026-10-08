import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SharedWorkspaceStore } from "./shared-workspaces.ts";
import { run, type Runner } from "./workspaces.ts";

const command = (file: string, cwd: string, args: string[]) =>
	execFileSync(file, args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	}).trim();
const git = (cwd: string, ...args: string[]) => command("git", cwd, args);
const jj = (cwd: string, ...args: string[]) =>
	command("jj", cwd, ["--config=user.name=t", "--config=user.email=t@t", ...args]);

function fixture(runner?: Runner) {
	const root = mkdtempSync(join(tmpdir(), "pilot-shared-"));
	const source = join(root, "source");
	git(root, "init", "--quiet", "-b", "main", source);
	writeFileSync(join(source, "a.txt"), "base\n");
	writeFileSync(
		join(source, ".gitignore"),
		"mise.local.toml\n.mise.local.toml\nmise/config.local.toml\n.mise/config.local.toml\nnode_modules/\ndist/\n.env\n.pi/\n",
	);
	git(source, "add", ".");
	git(source, "commit", "--quiet", "-m", "base");
	jj(source, "git", "init", "--colocate");
	return {
		root,
		source,
		store: new SharedWorkspaceStore(join(root, "home"), runner),
		path: (id = "session-a") => join(root, "sessions", id, "workspace"),
		recovery: join(root, "recovery"),
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

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

test("unknown ignored files, unsafe local configs and jj-omitted files block automatic cleanup", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		for (const [name, config] of [
			[".env", undefined],
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
		symlinkSync(join(f.root, "outside"), join(w.path, "mise.local.toml"));
		await assert.rejects(f.store.snapshot(w.path, w.shared!, f.recovery), /Unsafe ignored path/);
		rmSync(join(w.path, "mise.local.toml"));
		mkdirSync(join(f.root, "outside"));
		writeFileSync(join(f.root, "outside/config.local.toml"), "secret\n");
		symlinkSync(join(f.root, "outside"), join(w.path, "mise"));
		await assert.rejects(f.store.snapshot(w.path, w.shared!, f.recovery), /Unsafe .*path/);
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

test("partial creation and restore resume after command completion but before metadata persistence", async () => {
	let failAdd = true;
	let failEdit = false;
	const runner: Runner = async (file, args, cwd, ...rest) => {
		const result = await run(file, args, cwd, ...rest);
		if (file === "jj" && args.includes("add") && failAdd) {
			failAdd = false;
			throw new Error("crash after add");
		}
		if (file === "jj" && args.includes("edit") && failEdit) {
			failEdit = false;
			throw new Error("crash after edit");
		}
		return result;
	};
	const f = fixture(runner);
	try {
		await assert.rejects(f.store.create(f.source, f.path()), /crash after add/);
		await f.store.discardPartial(f.path(), f.source);
		await f.store.discardPartial(f.path(), f.source);
		const w = await f.store.create(f.source, f.path());
		writeFileSync(join(w.path, "a.txt"), "keep\n");
		await assert.rejects(f.store.discardPartial(w.path, f.source), /may contain edits/);
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, recovery);
		failEdit = true;
		await assert.rejects(f.store.restore(w.path, w.shared!, recovery, f.recovery), /crash after edit/);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(readFileSync(join(w.path, "a.txt"), "utf8"), "keep\n");
		await f.store.remove(w.path, w.shared!, recovery);
		failAdd = true;
		await assert.rejects(f.store.restore(w.path, w.shared!, recovery, f.recovery), /crash after add/);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(jj(w.path, "log", "--no-graph", "-r", "@", "-T", "commit_id"), recovery.commitId);
	} finally {
		f.close();
	}
});

test("old jj fails clearly; missing partials are harmless and pristine private clones are cleaned safely", async () => {
	const f = fixture();
	try {
		const old = new SharedWorkspaceStore(join(f.root, "old-home"), async () => "jj 0.45.1");
		await assert.rejects(old.create(f.source, f.path()), /require jj >= 0.46/);
		await f.store.discardPartial(f.path(), f.source);
		git(f.root, "clone", "--quiet", f.source, f.path());
		git(f.path(), "checkout", "--quiet", "--detach");
		await f.store.discardPartial(f.path(), f.source);
		assert.equal(existsSync(f.path()), false);
		git(f.root, "clone", "--quiet", f.source, f.path());
		git(f.path(), "checkout", "--quiet", "--detach");
		writeFileSync(join(f.path(), "a.txt"), "keep private edits\n");
		await assert.rejects(f.store.discardPartial(f.path(), f.source), /contains edits/);
		assert.equal(readFileSync(join(f.path(), "a.txt"), "utf8"), "keep private edits\n");
	} finally {
		f.close();
	}
});

test("repeat reclamation stores changed ignored inputs content-addressed, preserves bounded todos and skips Swift outputs", async () => {
	const f = fixture();
	try {
		writeFileSync(join(f.source, "mise.local.toml"), "first\n");
		const w = await f.store.create(f.source, f.path());
		mkdirSync(join(w.path, ".pi/todos"), { recursive: true });
		writeFileSync(join(w.path, ".pi/todos/TODO-abcd.md"), "todo first\n");
		writeFileSync(join(w.path, ".gitignore"), `${readFileSync(join(w.path, ".gitignore"), "utf8")}\n.build/\n`);
		mkdirSync(join(w.path, ".build"));
		writeFileSync(join(w.path, ".build/output"), "generated\n");
		const first = await f.store.snapshot(w.path, w.shared!, f.recovery);
		assert.equal(Object.keys(first.localConfigs).length, 2);
		assert.equal(statSync(w.shared!.repository).mode & 0o777, 0o700);
		assert.equal(statSync(dirname(w.shared!.repository)).mode & 0o777, 0o700);
		assert.equal(statSync(`${w.shared!.repository}.json`).mode & 0o777, 0o600);
		assert.equal(statSync(f.recovery).mode & 0o777, 0o700);
		assert.equal(statSync(join(f.recovery, "objects", first.localConfigs["mise.local.toml"]!)).mode & 0o777, 0o600);
		await f.store.remove(w.path, w.shared!, first);
		await f.store.restore(w.path, w.shared!, first, f.recovery);
		writeFileSync(join(w.path, "mise.local.toml"), "second\n");
		writeFileSync(join(w.path, ".pi/todos/TODO-abcd.md"), "todo second\n");
		const second = await f.store.snapshot(w.path, w.shared!, f.recovery);
		assert.equal(first.commitId, second.commitId);
		assert.notDeepEqual(first.localConfigs, second.localConfigs);
		await f.store.remove(w.path, w.shared!, second);
		await f.store.restore(w.path, w.shared!, second, f.recovery);
		assert.equal(readFileSync(join(w.path, "mise.local.toml"), "utf8"), "second\n");
		assert.equal(readFileSync(join(w.path, ".pi/todos/TODO-abcd.md"), "utf8"), "todo second\n");
		assert.equal(existsSync(join(w.path, ".build")), false);
		writeFileSync(join(w.path, ".pi/secret"), "block\n");
		await assert.rejects(f.store.snapshot(w.path, w.shared!, f.recovery), /Unsafe ignored path/);
	} finally {
		f.close();
	}
});

test("managed bootstrap retries in place after jj initialization and child removal retries after command completed", async () => {
	let failInit = true;
	let failRemove = true;
	const runner: Runner = async (file, args, cwd, ...rest) => {
		const result = await run(file, args, cwd, ...rest);
		if (file === "jj" && args.includes("init") && failInit) {
			failInit = false;
			throw new Error("crash after bootstrap init");
		}
		if (file === "jj" && args.includes("remove") && failRemove) {
			failRemove = false;
			throw new Error("crash after remove");
		}
		return result;
	};
	const f = fixture(runner);
	try {
		await assert.rejects(f.store.create(f.source, f.path()), /crash after bootstrap/);
		await f.store.discardPartial(f.path(), f.source);
		const w = await f.store.create(f.source, f.path());
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await assert.rejects(f.store.remove(w.path, w.shared!, recovery), /crash after remove/);
		await f.store.remove(w.path, w.shared!, recovery);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(jj(w.path, "log", "--no-graph", "-r", "@", "-T", "commit_id"), recovery.commitId);
	} finally {
		f.close();
	}
});

test("non-default sparse workspaces and submodules block snapshots", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		jj(w.path, "sparse", "set", "--clear", "--add", "a.txt");
		await assert.rejects(f.store.snapshot(w.path, w.shared!, f.recovery), /non-sparse/);
		jj(w.path, "sparse", "set", "--clear", "--add", ".");
		const submodule = join(f.root, "submodule");
		git(f.root, "init", "--quiet", submodule);
		git(submodule, "commit", "--quiet", "--allow-empty", "-m", "sub");
		git(w.path, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", submodule, "sub");
		git(w.path, "commit", "--quiet", "-am", "submodule");
		await assert.rejects(f.store.snapshot(w.path, w.shared!, f.recovery), /Submodule/);
		assert.equal(existsSync(join(w.path, "sub")), true);
	} finally {
		f.close();
	}
});

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
		rmSync(remote, { recursive: true, force: true });
		const offline = await f.store.create(f.source, f.path("offline"));
		assert.equal(offline.baseBranch, "release");
		assert.equal(offline.base, git(f.source, "rev-parse", "refs/remotes/origin/release"));
		await assert.rejects(
			f.store.create(f.source, f.path("selected-offline"), undefined, "release"),
			/Origin branch unavailable/,
		);
		await assert.rejects(f.store.create(f.source, f.path("invalid"), undefined, "main~1"), /valid exact/);
	} finally {
		f.close();
	}
});

test("ambient Git redirection cannot touch the source and inherited hooks do not run", async () => {
	const f = fixture();
	const names = [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_OBJECT_DIRECTORY",
		"GIT_INDEX_FILE",
		"GIT_CONFIG_COUNT",
		"GIT_CONFIG_KEY_0",
		"GIT_CONFIG_VALUE_0",
	];
	const previous = names.map((name) => process.env[name]);
	try {
		const hooks = join(f.root, "hooks");
		mkdirSync(hooks);
		writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\necho damaged > '${join(f.source, "a.txt")}'\n`, {
			mode: 0o755,
		});
		git(f.source, "config", "core.hooksPath", hooks);
		const refs = git(f.source, "show-ref");
		for (const name of ["GIT_DIR", "GIT_COMMON_DIR"]) process.env[name] = join(f.source, ".git");
		process.env.GIT_WORK_TREE = f.source;
		process.env.GIT_OBJECT_DIRECTORY = join(f.source, ".git/objects");
		process.env.GIT_INDEX_FILE = join(f.source, ".git/index");
		process.env.GIT_CONFIG_COUNT = "1";
		process.env.GIT_CONFIG_KEY_0 = "core.worktree";
		process.env.GIT_CONFIG_VALUE_0 = f.source;
		const w = await f.store.create(f.source, f.path());
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, recovery);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		for (const [index, name] of names.entries()) {
			if (previous[index] === undefined) delete process.env[name];
			else process.env[name] = previous[index];
		}
		assert.equal(git(f.source, "show-ref"), refs);
		assert.equal(readFileSync(join(f.source, "a.txt"), "utf8"), "base\n");
		assert.equal(readFileSync(join(w.path, "a.txt"), "utf8"), "base\n");
	} finally {
		for (const [index, name] of names.entries()) {
			if (previous[index] === undefined) delete process.env[name];
			else process.env[name] = previous[index];
		}
		f.close();
	}
});

test("successful jj removal with leftover directory is not falsely reported as reclaimed", async () => {
	let leaveDirectory = true;
	let path = "";
	const runner: Runner = async (file, args, cwd, ...rest) => {
		const result = await run(file, args, cwd, ...rest);
		if (file === "jj" && args.includes("remove") && leaveDirectory) {
			leaveDirectory = false;
			mkdirSync(path);
			writeFileSync(join(path, "unknown-remnant"), "do not delete\n");
		}
		return result;
	};
	const f = fixture(runner);
	try {
		const w = await f.store.create(f.source, f.path());
		path = w.path;
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await assert.rejects(f.store.remove(w.path, w.shared!, recovery), /partial removal needs review/);
		await assert.rejects(f.store.remove(w.path, w.shared!, recovery));
		assert.equal(readFileSync(join(w.path, "unknown-remnant"), "utf8"), "do not delete\n");
	} finally {
		f.close();
	}
});

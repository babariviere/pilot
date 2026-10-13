import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SharedWorkspaceStore } from "./shared-workspaces.ts";
import { fixture, git, jj } from "./testing/shared-workspace.ts";
import { type Runner, run } from "./workspaces.ts";

test("partial creation and restore resume after command completion but before metadata persistence", async () => {
	let failAdd = true;
	let failEdit = false;
	let failColocate = false;
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
		if (file === "jj" && args.includes("colocation") && args.includes("enable") && failColocate) {
			failColocate = false;
			throw new Error("crash after colocation");
		}
		return result;
	};
	const f = fixture(runner);
	try {
		await assert.rejects(f.store.create(f.source, f.path()), /crash after add/);
		await f.store.discardPartial(f.path(), f.source);
		await f.store.discardPartial(f.path(), f.source);
		failColocate = true;
		await assert.rejects(f.store.create(f.source, f.path()), /crash after colocation/);
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

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SharedWorkspaceStore } from "./shared-workspaces.ts";
import { fixture, git, jj } from "./testing/shared-workspace.ts";
import { type Runner, run } from "./workspaces.ts";

test("large tracked-directory indexing yields to daemon work before finishing the listing", async () => {
	const fields = Array.from({ length: 1100 }, (_, index) => `sources/${index}.ts\0file\0`).join("");
	const runner: Runner = async (file, args) => {
		if (file === "jj" && args.includes("sparse")) return ".";
		if (file === "git" && args.includes("--stage")) return "";
		if (file === "jj" && args.includes("file")) return `${fields}nested\0git-submodule\0`;
		throw new Error("Inspection should stop before filesystem traversal");
	};
	let serviced = false;
	const pending = setImmediate(() => {
		serviced = true;
	});
	try {
		const store = new SharedWorkspaceStore(process.cwd(), runner);
		// biome-ignore lint/complexity/useLiteralKeys: Exercise the private inspection seam without repository I/O.
		await assert.rejects(store["inspect"](process.cwd()), /Submodule prevents automatic cleanup: nested/);
		assert.equal(serviced, true, "HTTP and streaming callbacks get a turn while indexing large trees");
	} finally {
		clearImmediate(pending);
	}
});

test("cleanup discards arbitrary ignored trees and links without following them, including mixed tracked trees", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		const vendor = "apps/macos/Vendor/libghostty-spm";
		writeFileSync(
			join(w.path, ".gitignore"),
			`${readFileSync(join(w.path, ".gitignore"), "utf8")}\napps/macos/Vendor/\n`,
		);
		mkdirSync(join(w.path, vendor), { recursive: true });
		writeFileSync(join(w.path, vendor, ".gitattributes"), "generated\n");
		writeFileSync(join(w.path, vendor, ".pilot-version"), "pinned\n");
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, recovery);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(existsSync(join(w.path, vendor)), false);
		assert.deepEqual(recovery.localConfigs, {});

		for (const path of ["apps/macos/Vendor/precious", "elsewhere/libghostty-spm"]) {
			writeFileSync(join(w.path, ".gitignore"), `${readFileSync(join(w.path, ".gitignore"), "utf8")}\n${path}/\n`);
			mkdirSync(join(w.path, path), { recursive: true });
			writeFileSync(join(w.path, path, "input"), "do not lose\n");
			mkdirSync(join(w.path, path, ".git"));
		}

		// Ignored links are removed without traversing their external targets.
		const outside = join(f.root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "input"), "keep\n");
		symlinkSync(outside, join(w.path, vendor));
		const withIgnored = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, withIgnored);
		assert.equal(existsSync(w.path), false);
		await f.store.restore(w.path, w.shared!, withIgnored, f.recovery);
		for (const path of [vendor, "apps/macos/Vendor/precious", "elsewhere/libghostty-spm"])
			assert.equal(existsSync(join(w.path, path)), false);
		assert.equal(readFileSync(join(outside, "input"), "utf8"), "keep\n");

		// Inspect non-ignored omitted inputs, even next to ignored content.
		mkdirSync(join(w.path, vendor), { recursive: true });
		writeFileSync(join(w.path, ".gitignore"), "");
		jj(w.path, "config", "set", "--repo", "snapshot.auto-track", "none()");
		writeFileSync(join(w.path, vendor, "tracked.swift"), "source\n");
		await assert.rejects(f.store.snapshot(w.path, w.shared!, f.recovery), /Unsafe untracked or jj-omitted path/);
		jj(w.path, "config", "set", "--repo", "snapshot.auto-track", "all()");
		jj(w.path, "status");
		writeFileSync(join(w.path, ".gitignore"), "apps/macos/Vendor/\n");
		writeFileSync(join(w.path, vendor, ".gitattributes"), "ignored next to tracked source\n");
		const mixed = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, mixed);
		await f.store.restore(w.path, w.shared!, mixed, f.recovery);
		assert.equal(existsSync(join(w.path, vendor, ".gitattributes")), false);
		assert.equal(readFileSync(join(w.path, vendor, "tracked.swift"), "utf8"), "source\n");
	} finally {
		f.close();
	}
});

test("cleanup discards ignored build files beside tracked placeholders and restores tracked edits", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		const dist = "addons/outlook/dist";
		writeFileSync(
			join(w.path, ".gitignore"),
			readFileSync(join(w.path, ".gitignore"), "utf8").replace(/^dist\/\n/m, ""),
		);
		mkdirSync(join(w.path, dist, "assets"), { recursive: true });
		writeFileSync(join(w.path, "addons/outlook/.gitignore"), "dist/*\n!dist/.gitkeep\n!dist/tracked.txt\n");
		writeFileSync(join(w.path, dist, ".gitkeep"), "");
		writeFileSync(join(w.path, dist, "tracked.txt"), "original\n");
		jj(w.path, "status");
		assert.equal(git(w.path, "ls-files", "--", `${dist}/.gitkeep`), `${dist}/.gitkeep`);
		writeFileSync(join(w.path, dist, "tracked.txt"), "edited\n");
		writeFileSync(join(w.path, dist, "assets/icon-128.png"), Buffer.from([0, 1, 2]));
		writeFileSync(join(w.path, dist, "bundle.js"), "generated\n");
		assert.equal(git(w.path, "check-ignore", "--", `${dist}/assets/icon-128.png`), `${dist}/assets/icon-128.png`);
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		assert.deepEqual(recovery.localConfigs, {});
		// Ignored inputs introduced after the snapshot must not block removal either.
		symlinkSync(join(w.path, "a.txt"), join(w.path, dist, "unsafe-link"));
		await f.store.remove(w.path, w.shared!, recovery);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(readFileSync(join(w.path, dist, "tracked.txt"), "utf8"), "edited\n");
		assert.equal(existsSync(join(w.path, dist, ".gitkeep")), true);
		assert.equal(existsSync(join(w.path, dist, "assets/icon-128.png")), false);
		assert.equal(existsSync(join(w.path, dist, "bundle.js")), false);
		assert.equal(existsSync(join(w.path, dist, "unsafe-link")), false);
		assert.equal(readFileSync(join(w.path, "a.txt"), "utf8"), "base\n");
		assert.equal(
			jj(w.path, "--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id"),
			recovery.commitId,
		);
	} finally {
		f.close();
	}
});

test("mixed directories block non-ignored omitted inputs and nested repositories, not ignored paths", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		mkdirSync(join(w.path, "build"));
		writeFileSync(join(w.path, "build/.gitkeep"), "");
		writeFileSync(
			join(w.path, ".gitignore"),
			`${readFileSync(join(w.path, ".gitignore"), "utf8")}\nbuild/*\n!build/.gitkeep\n!build/input.txt\n`,
		);
		jj(w.path, "status");
		jj(w.path, "config", "set", "--repo", "snapshot.auto-track", "none()");
		writeFileSync(join(w.path, "build/input.txt"), "keep untracked\n");
		await assert.rejects(
			f.store.snapshot(w.path, w.shared!, f.recovery),
			/Unsafe untracked or jj-omitted path.*build\/input.txt/,
		);
		rmSync(join(w.path, "build/input.txt"));

		const outside = join(f.root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "input.txt"), "keep external\n");
		for (const target of [join(outside, "input.txt"), outside]) {
			symlinkSync(target, join(w.path, "build/link"));
			assert.deepEqual((await f.store.snapshot(w.path, w.shared!, f.recovery)).localConfigs, {});
			rmSync(join(w.path, "build/link"));
		}
		writeFileSync(join(w.path, ".gitignore"), `${readFileSync(join(w.path, ".gitignore"), "utf8")}\n!build/link\n`);
		symlinkSync(outside, join(w.path, "build/link"));
		await assert.rejects(f.store.snapshot(w.path, w.shared!, f.recovery), /Unsafe untracked or jj-omitted path/);
		rmSync(join(w.path, "build/link"));
		assert.equal(readFileSync(join(outside, "input.txt"), "utf8"), "keep external\n");

		mkdirSync(join(w.path, "build/nested/.git"), { recursive: true });
		assert.deepEqual((await f.store.snapshot(w.path, w.shared!, f.recovery)).localConfigs, {});
		writeFileSync(
			join(w.path, ".gitignore"),
			`${readFileSync(join(w.path, ".gitignore"), "utf8")}\n!build/nested/\n!build/nested/**\n`,
		);
		await assert.rejects(f.store.snapshot(w.path, w.shared!, f.recovery), /Submodule or nested git repository/);
		rmSync(join(w.path, "build/nested"), { recursive: true });
		mkdirSync(join(w.path, ".pi"), { recursive: true });
		writeFileSync(join(w.path, ".pi/archive-final-source.log"), "keep unknown log\n");
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, recovery);
		assert.equal(readFileSync(join(outside, "input.txt"), "utf8"), "keep external\n");
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(existsSync(join(w.path, ".pi/archive-final-source.log")), false);
	} finally {
		f.close();
	}
});

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

test("repeat reclamation preserves mise configs but discards ignored legacy todos and Swift outputs", async () => {
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
		assert.equal(Object.keys(first.localConfigs).length, 1);
		assert.equal(statSync(w.shared!.repository).mode & 0o777, 0o700);
		assert.equal(statSync(dirname(w.shared!.repository)).mode & 0o777, 0o700);
		assert.equal(statSync(`${w.shared!.repository}.json`).mode & 0o777, 0o600);
		assert.equal(statSync(f.recovery).mode & 0o777, 0o700);
		assert.equal(statSync(join(f.recovery, "objects", first.localConfigs["mise.local.toml"]!)).mode & 0o777, 0o600);
		await f.store.remove(w.path, w.shared!, first);
		await f.store.restore(w.path, w.shared!, first, f.recovery);
		writeFileSync(join(w.path, "mise.local.toml"), "second\n");
		mkdirSync(join(w.path, ".pi/todos"), { recursive: true });
		writeFileSync(join(w.path, ".pi/todos/TODO-abcd.md"), "todo second\n");
		const second = await f.store.snapshot(w.path, w.shared!, f.recovery);
		assert.equal(first.commitId, second.commitId);
		assert.notDeepEqual(first.localConfigs, second.localConfigs);
		await f.store.remove(w.path, w.shared!, second);
		await f.store.restore(w.path, w.shared!, second, f.recovery);
		assert.equal(readFileSync(join(w.path, "mise.local.toml"), "utf8"), "second\n");
		assert.equal(existsSync(join(w.path, ".pi/todos")), false);
		assert.equal(existsSync(join(w.path, ".build")), false);
		mkdirSync(join(w.path, ".pi"), { recursive: true });
		writeFileSync(join(w.path, ".pi/secret"), "block\n");
		const third = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await f.store.remove(w.path, w.shared!, third);
		await f.store.restore(w.path, w.shared!, third, f.recovery);
		assert.equal(existsSync(join(w.path, ".pi/secret")), false);
		assert.equal(existsSync(join(w.path, ".pi/todos")), false);
	} finally {
		f.close();
	}
});

test("oversized ignored configs and all legacy todos are skipped, and later changes do not block removal", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path());
		writeFileSync(join(w.path, "mise.local.toml"), Buffer.alloc(1024 * 1024 + 1));
		mkdirSync(join(w.path, ".pi/todos"), { recursive: true });
		for (let index = 0; index < 257; index++)
			writeFileSync(join(w.path, `.pi/todos/TODO-${index}.md`), "legacy todo\n");
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		assert.deepEqual(recovery.localConfigs, {});
		writeFileSync(join(w.path, ".pi/todos/TODO-later.md"), "later\n");
		await f.store.remove(w.path, w.shared!, recovery);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(existsSync(join(w.path, "mise.local.toml")), false);
		assert.equal(existsSync(join(w.path, ".pi/todos")), false);
	} finally {
		f.close();
	}
});

test("ignored config edits do not block partial workspace cleanup", async () => {
	const f = fixture();
	try {
		writeFileSync(join(f.source, "mise.local.toml"), "initial\n");
		const w = await f.store.create(f.source, f.path());
		writeFileSync(join(w.path, "mise.local.toml"), "changed ignored config\n");
		writeFileSync(join(w.path, ".env"), "ignored\n");
		await f.store.discardPartial(w.path, f.source);
		assert.equal(existsSync(w.path), false);
		assert.equal(readFileSync(join(f.source, "mise.local.toml"), "utf8"), "initial\n");
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

test("removal interrupted after jj unregistered the workspace finishes only an unchanged remnant", async () => {
	let interrupt = true;
	let path = "";
	const runner: Runner = async (file, args, cwd, ...rest) => {
		if (file === "jj" && args.includes("remove") && interrupt) {
			interrupt = false;
			// jj commits the unregistration first, then a timeout kills it partway through deleting files.
			await run(
				file,
				args.map((arg) => (arg === "remove" ? "forget" : arg)),
				cwd,
				...rest,
			);
			rmSync(join(path, ".gitignore"));
			rmSync(join(path, ".git"), { force: true });
			throw new Error(`Workspace command timed out: jj ${args.join(" ")}`);
		}
		return run(file, args, cwd, ...rest);
	};
	const f = fixture(runner);
	try {
		const w = await f.store.create(f.source, f.path());
		path = w.path;
		mkdirSync(join(w.path, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(w.path, "node_modules/pkg/index.js"), "generated\n");
		const recovery = await f.store.snapshot(w.path, w.shared!, f.recovery);
		await assert.rejects(f.store.remove(w.path, w.shared!, recovery), /timed out/);

		writeFileSync(join(w.path, "a.txt"), "edited after the snapshot\n");
		await assert.rejects(
			f.store.remove(w.path, w.shared!, recovery),
			/a\.txt changed since the recovery snapshot; partial removal needs review/,
		);
		assert.equal(readFileSync(join(w.path, "a.txt"), "utf8"), "edited after the snapshot\n");
		writeFileSync(join(w.path, "a.txt"), "base\n");
		writeFileSync(join(w.path, "notes.txt"), "keep\n");
		await assert.rejects(f.store.remove(w.path, w.shared!, recovery), /notes\.txt is not in the recovery snapshot/);
		assert.equal(readFileSync(join(w.path, "notes.txt"), "utf8"), "keep\n");
		rmSync(join(w.path, "notes.txt"));

		await f.store.remove(w.path, w.shared!, recovery);
		assert.equal(existsSync(w.path), false);
		await f.store.restore(w.path, w.shared!, recovery, f.recovery);
		assert.equal(readFileSync(join(w.path, "a.txt"), "utf8"), "base\n");
		assert.equal(existsSync(join(w.path, "node_modules")), false);
	} finally {
		f.close();
	}
});

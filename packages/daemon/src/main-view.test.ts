import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forkMainViewWorker, MainViewStore, mainViewSandbox } from "./main-view.ts";
import { copyGitSeed } from "./testing/git-seed.ts";
import { run } from "./workspaces.ts";

test("one non-jj main view shares fetched heads, permits reads and rejects writes", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pilot-main-view-")));
	t.after(async () => {
		await run("chmod", ["-R", "u+w", home], home);
		await rm(home, { recursive: true, force: true });
	});
	const source = join(home, "upstream");
	copyGitSeed(source, { "file.txt": "base\n" });
	let checkouts = 0;
	const store = new MainViewStore(home, async (file, args, ...rest) => {
		if (args.includes("checkout")) checkouts++;
		return run(file, args, ...rest);
	});
	const initial = (await run("git", ["rev-parse", "HEAD"], source)).trim();
	const [path, same] = await Promise.all([
		store.update("project", source, initial, source),
		store.update("project", source, initial, source),
	]);
	assert.equal(path, same);
	assert.equal(checkouts, 1, "concurrent consumers build only one checkout");
	assert.equal(existsSync(join(path, ".jj")), false);
	assert.equal((await run("git", ["branch", "--show-current"], path)).trim(), "");
	assert.equal((await run("git", ["show", "HEAD:file.txt"], path)).trim(), "base");
	await assert.rejects(writeFile(join(path, "file.txt"), "forbidden"), /EACCES|EPERM|read-only/);
	await assert.rejects(writeFile(join(path, "new.txt"), "forbidden"), /EACCES|EPERM|read-only/);
	if (process.platform === "darwin") {
		const profile = mainViewSandbox([path]);
		// Even changing modes cannot bypass the inherited kernel restriction.
		assert.throws(() =>
			execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/chmod", "u+w", join(path, "file.txt")], {
				stdio: "pipe",
			}),
		);
		assert.equal(
			execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/git", "log", "-1", "--format=%H"], {
				cwd: path,
				encoding: "utf8",
			}).trim(),
			initial,
		);
		const entry = join(home, "sandbox-child.cjs");
		await writeFile(
			entry,
			`const fs = require('node:fs'); const cp = require('node:child_process'); let denied = false; try { cp.execFileSync('/bin/chmod', ['u+w', ${JSON.stringify(join(path, "file.txt"))}], {stdio:'pipe'}); } catch { denied = true; } fs.writeFileSync(require('node:path').join(process.env.TMPDIR, 'scratch.txt'), 'persistent'); process.send({denied, tmp: process.env.TMPDIR, cwd: process.cwd()}); process.disconnect();`,
		);
		const child = await forkMainViewWorker(entry, { scratch: home, protectedPaths: [path] });
		const message = once(child, "message");
		const exit = once(child, "exit");
		assert.deepEqual((await message)[0], { denied: true, tmp: home, cwd: home });
		assert.equal((await exit)[0], 0);
		assert.equal(await readFile(join(home, "scratch.txt"), "utf8"), "persistent");
	}
	await writeFile(join(source, "file.txt"), "new main\n");
	await run("git", ["add", "file.txt"], source);
	await run(
		"git",
		["-c", "commit.gpgSign=false", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "next"],
		source,
	);
	const head = (await run("git", ["rev-parse", "HEAD"], source)).trim();
	await store.update("project", source, head, source);
	assert.equal(checkouts, 2);
	assert.equal(await readFile(join(path, "file.txt"), "utf8"), "new main\n");
	await assert.rejects(writeFile(join(path, "file.txt"), "forbidden"), /EACCES|EPERM|read-only/);
});

test("daily main-view GC covers source and bare stores, persists cadence and leaves sources sealed", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pilot-main-gc-")));
	t.after(async () => {
		await run("chmod", ["-R", "u+w", home], home);
		await rm(home, { recursive: true, force: true });
	});
	const upstream = join(home, "upstream");
	copyGitSeed(upstream, { "file.txt": "keep\n" });
	const calls: string[] = [];
	const runner: typeof run = async (file, args, cwd, ...rest) => {
		if (args.includes("gc")) {
			calls.push(cwd);
			assert.equal(args.includes("--prune=now"), false);
			if (cwd.endsWith("source")) {
				assert.equal((await lstat(join(cwd, "file.txt"))).mode & 0o222, 0);
				assert.notEqual((await lstat(join(cwd, ".git"))).mode & 0o200, 0);
			}
		}
		return run(file, args, cwd, ...rest);
	};
	const store = new MainViewStore(home, runner);
	const fetched = await store.fetch("project", upstream);
	const source = await store.update("project", fetched.repository, fetched.head, upstream);
	const now = Date.now();
	await Promise.all([store.maintain(now), store.maintain(now)]);
	assert.deepEqual(calls, [source, fetched.repository]);
	assert.equal((await lstat(join(source, ".git"))).mode & 0o222, 0);
	assert.equal((await run("git", ["rev-parse", "HEAD"], source)).trim(), fetched.head);
	await new MainViewStore(home, runner).maintain(now + 86_400_000 - 1);
	assert.equal(calls.length, 2, "cadence survives daemon restart");
	await store.maintain(now + 86_400_000);
	assert.equal(calls.length, 4, "exact daily boundary runs again");
});

test("GC failures reseal metadata, back off, and do not prevent another project's maintenance", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pilot-main-gc-fail-")));
	t.after(async () => {
		await run("chmod", ["-R", "u+w", home], home);
		await rm(home, { recursive: true, force: true });
	});
	const upstream = join(home, "upstream");
	copyGitSeed(upstream, { "file.txt": "keep\n" });
	const head = (await run("git", ["rev-parse", "HEAD"], upstream)).trim();
	let fail = true;
	let attempts = 0;
	const store = new MainViewStore(home, async (file, args, cwd, ...rest) => {
		if (args.includes("gc")) {
			attempts++;
			if (cwd.includes("broken") && fail) {
				await writeFile(join(cwd, ".git", "gc-created"), "new metadata\n");
				throw new Error("GC failed");
			}
		}
		return run(file, args, cwd, ...rest);
	});
	for (const project of ["broken", "healthy"]) await store.update(project, upstream, head, upstream);
	t.mock.method(console, "warn", () => {});
	const now = Date.now();
	await store.maintain(now);
	assert.equal(attempts, 2);
	assert.equal((await lstat(join(store.path("broken"), ".git", "gc-created"))).mode & 0o222, 0);
	assert.equal(existsSync(join(home, "main-views", "broken", "gc-at")), false);
	await store.maintain(now + 1);
	assert.equal(attempts, 2);
	fail = false;
	await store.maintain(now + 86_400_000);
	assert.equal(attempts, 4);
});

test("maintenance shares the fetch/update queue and ignores symlinked stores", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pilot-main-gc-queue-")));
	t.after(async () => {
		await run("chmod", ["-R", "u+w", home], home);
		await rm(home, { recursive: true, force: true });
	});
	const upstream = join(home, "upstream");
	copyGitSeed(upstream, { "file.txt": "keep\n" });
	const head = (await run("git", ["rev-parse", "HEAD"], upstream)).trim();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const order: string[] = [];
	const store = new MainViewStore(home, async (file, args, cwd, ...rest) => {
		if (args.includes("gc")) {
			order.push("gc");
			entered();
			await gate;
		} else if (args.includes("fetch")) order.push("fetch");
		return run(file, args, cwd, ...rest);
	});
	await store.update("project", upstream, head, upstream);
	order.length = 0;
	const maintenance = store.maintain();
	await started;
	const fetch = store.fetch("project", upstream);
	const update = store.update("project", upstream, head, upstream);
	assert.deepEqual(order, ["gc"]);
	release();
	await Promise.all([maintenance, fetch, update]);
	assert.deepEqual(order, ["gc", "fetch"]);
	await symlink(join(home, "main-views", "project"), join(home, "main-views", "linked"));
	await mkdir(join(home, "main-views", "external"));
	await symlink(upstream, store.path("external"));
	order.length = 0;
	await store.maintain();
	assert.deepEqual(order, []);
});

test("aborted maintenance reseals metadata and never records a successful GC", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pilot-main-gc-abort-")));
	t.after(async () => {
		await run("chmod", ["-R", "u+w", home], home);
		await rm(home, { recursive: true, force: true });
	});
	const upstream = join(home, "upstream");
	copyGitSeed(upstream, { "file.txt": "keep\n" });
	const head = (await run("git", ["rev-parse", "HEAD"], upstream)).trim();
	const controller = new AbortController();
	const store = new MainViewStore(home, async (file, args, cwd, timeout, signal, env) => {
		if (args.includes("gc")) {
			assert.equal(signal, controller.signal);
			controller.abort();
			throw new Error("aborted");
		}
		return run(file, args, cwd, timeout, signal, env);
	});
	await store.update("project", upstream, head, upstream);
	// Malformed on-disk cadence must not disable maintenance forever.
	await writeFile(join(home, "main-views", "project", "gc-at"), "Infinity");
	const warnings = t.mock.method(console, "warn", () => {});
	await store.maintain(Date.now(), controller.signal);
	assert.ok(controller.signal.aborted);
	assert.equal((await lstat(join(store.path("project"), ".git"))).mode & 0o222, 0);
	assert.equal(await readFile(join(home, "main-views", "project", "gc-at"), "utf8"), "Infinity");
	assert.equal(warnings.mock.callCount(), 0, "normal shutdown does not produce a maintenance failure warning");
});

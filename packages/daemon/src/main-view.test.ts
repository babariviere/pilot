import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

/** Copy an immutable Git-only seed; every test owns its objects, refs, config and working tree. */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

const seeds = new Map<string, string>();
let root: string | undefined;
after(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

export function copyGitSeed(target: string, files: Record<string, string>): void {
	const key = JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
	let seed = seeds.get(key);
	if (!seed) {
		root ??= mkdtempSync(join(tmpdir(), "pilot-git-seeds-"));
		seed = join(root, String(seeds.size));
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		const git = (...args: string[]) =>
			execFileSync(
				"git",
				["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "init.templateDir=", ...args],
				{
					cwd: root,
					stdio: "pipe",
					env: {
						...env,
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_AUTHOR_NAME: "t",
						GIT_AUTHOR_EMAIL: "t@t",
						GIT_COMMITTER_NAME: "t",
						GIT_COMMITTER_EMAIL: "t@t",
					},
				},
			);
		git("init", "--quiet", "-b", "main", seed);
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(seed, path)), { recursive: true });
			writeFileSync(join(seed, path), content);
		}
		git("-C", seed, "add", ".");
		git("-C", seed, "commit", "--quiet", "--allow-empty", "-m", "base");
		seeds.set(key, seed);
	}
	// No alternates, hard links or jj metadata containing another test's workspace paths.
	cpSync(seed, target, { recursive: true, errorOnExist: true, force: false });
}

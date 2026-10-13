import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedWorkspaceStore } from "../shared-workspaces.ts";
import type { Runner } from "../workspaces.ts";
import { copyGitSeed } from "./git-seed.ts";

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
export const git = (cwd: string, ...args: string[]) => command("git", cwd, args);
export const jj = (cwd: string, ...args: string[]) =>
	command("jj", cwd, ["--config=user.name=t", "--config=user.email=t@t", ...args]);

export function fixture(runner?: Runner) {
	const root = mkdtempSync(join(tmpdir(), "pilot-shared-"));
	const source = join(root, "source");
	copyGitSeed(source, {
		"a.txt": "base\n",
		".gitignore":
			"mise.local.toml\n.mise.local.toml\nmise/config.local.toml\n.mise/config.local.toml\nnode_modules/\ndist/\n.env\n.pi/\n",
	});
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

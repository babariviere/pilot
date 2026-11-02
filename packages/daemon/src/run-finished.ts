/** Run boundaries compare snapshots, not the accumulated diff against a chat's original base. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionOutcome } from "@pilot/protocol";
import { subprocesses } from "./subprocess.ts";
import { workspaceCommandEnvironment } from "./workspace-environment.ts";

export interface RunFinished {
	triggerId: string;
	outcome: SessionOutcome;
	changedFiles: string[] | "many";
	/** Unknown is not an empty diff and never authorizes a check. */
	filesError?: string;
	openTodos: number;
}

export interface RunBoundary {
	id: string;
	baseline?: string;
	filesError?: string;
	finished?: RunFinished;
}

/** Small host-wide admission bound, including callers waiting for a worker thread. */
let active = 0;
const waiting: (() => void)[] = [];
export async function readRunFiles<T>(read: () => Promise<T>): Promise<T> {
	if (active >= 3) {
		if (waiting.length >= 64) throw new Error("Too many run snapshots waiting");
		await new Promise<void>((resolve) => waiting.push(resolve));
	} else active++;
	try {
		return await read();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else active--;
	}
}

async function command(cwd: string, file: string, args: string[], env = process.env, paths = false) {
	const result = await subprocesses.run(file, args, {
		cwd,
		env: workspaceCommandEnvironment(env),
		timeoutMs: 30_000,
		detached: true,
		maxBytes: paths ? 256 * 1024 : 1024,
		overflow: paths ? "truncate" : "fail",
		maxStderrBytes: 4096,
	});
	if (paths && result.truncated) return "many" as const;
	if (result.code !== 0 || result.timedOut || result.aborted || result.overflowed)
		throw new Error("Could not read workspace snapshot");
	return result.stdout.toString("utf8");
}

export async function runSnapshot(cwd: string, jj: boolean): Promise<string> {
	if (jj) {
		const id = (
			await command(cwd, "jj", ["--no-pager", "--color=never", "log", "-r", "@", "--no-graph", "-T", "commit_id"])
		).trim();
		if (!/^[a-f0-9]{40,64}$/.test(id)) throw new Error("Invalid workspace snapshot");
		return id;
	}
	// A private index includes tracked edits and untracked, non-ignored files without touching the user's index.
	const temporary = await mkdtemp(join(tmpdir(), "pilot-run-index-"));
	const env = { ...process.env, GIT_INDEX_FILE: join(temporary, "index") };
	try {
		await command(cwd, "git", ["read-tree", "HEAD"], env);
		await command(cwd, "git", ["add", "--all", "--", "."], env);
		const tree = (await command(cwd, "git", ["write-tree"], env)).trim();
		if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error("Invalid workspace snapshot");
		return tree;
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

export async function runChangedFiles(cwd: string, jj: boolean, baseline: string): Promise<string[] | "many"> {
	if (!/^[a-f0-9]{40,64}$/.test(baseline)) throw new Error("Invalid run baseline");
	const head = await runSnapshot(cwd, jj);
	const output = jj
		? await command(
				cwd,
				"jj",
				[
					"--ignore-working-copy",
					"--no-pager",
					"--color=never",
					"diff",
					"--from",
					baseline,
					"--to",
					head,
					"-T",
					'path ++ "\\0"',
				],
				process.env,
				true,
			)
		: await command(
				cwd,
				"git",
				["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", baseline, head, "--"],
				process.env,
				true,
			);
	if (output === "many") return "many";
	const files = output.split("\0").filter(Boolean);
	return files.length > 1000 ? "many" : files;
}

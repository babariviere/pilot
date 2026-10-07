/**
 * Workspace benchmark: time each command of createWorkspace and dissociateWorkspace on a real project.
 *   node --import tsx scripts/bench/workspace.ts <project-dir> [--baseline]
 * --baseline also times the previous approach, a plain local \`git clone\` (hardlinked objects).
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createWorkspace, dissociateWorkspace, type Runner } from "../../packages/daemon/src/workspaces.ts";

const exec = promisify(execFile);
const [source, flag] = process.argv.slice(2);
if (!source) throw new Error("usage: workspace.ts <project-dir> [--baseline]");

const timed: Runner = async (file, args, cwd, timeoutMs = 120_000) => {
	const start = performance.now();
	try {
		const { stdout } = await exec(file, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
		return stdout.trim();
	} finally {
		console.log(`  ${(performance.now() - start).toFixed(0).padStart(7)}ms  ${file} ${args.join(" ").slice(0, 100)}`);
	}
};

const root = await mkdtemp(join(tmpdir(), "pilot-ws-bench-"));
try {
	if (flag === "--baseline") {
		const start = performance.now();
		await timed("git", ["clone", "--quiet", source, join(root, "baseline")], source, 60 * 60_000);
		console.log(`baseline git clone: ${(performance.now() - start).toFixed(0)}ms\n`);
	}
	let start = performance.now();
	const workspace = await createWorkspace(source, join(root, "workspace"), timed);
	console.log(
		`createWorkspace (session can start): ${(performance.now() - start).toFixed(0)}ms base=${workspace.base}\n`,
	);
	start = performance.now();
	await dissociateWorkspace(workspace.path, timed);
	console.log(`dissociateWorkspace (background): ${(performance.now() - start).toFixed(0)}ms`);
	await timed("git", ["fsck", "--connectivity-only", "--no-dangling"], workspace.path, 60 * 60_000);
} finally {
	if (process.env.KEEP) console.log(`kept ${root}`);
	else await rm(root, { recursive: true, force: true });
}

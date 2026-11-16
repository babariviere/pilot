/** Historical module only: sibling modules and package dependencies come from the current workspace. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function loadBaseline<T>(revision: string, original: URL, vcs: "git" | "jj" = "git") {
	if (vcs === "git" && !/^[a-f\d]{6,40}$/.test(revision)) throw new Error("Pass a baseline commit hash");
	const path = basename(fileURLToPath(original));
	const { stdout } = await exec(
		vcs,
		vcs === "git" ? ["show", `${revision}:./${path}`] : ["file", "show", "-r", revision, path],
		// Source, not workload data. Accommodates the existing 16 MiB mission-store baseline allowance.
		{ cwd: dirname(fileURLToPath(original)), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
	);
	const loaded = await loadBaselineSource<T>(stdout, original);
	console.error(`Baseline ${revision}: ${path}; current sibling modules and workspace dependencies`);
	return loaded;
}

export async function loadBaselineSource<T>(source: string, original: URL) {
	// Keep the source directory so imports, worker/resource URLs and workspace packages resolve unchanged.
	const file = new URL(`.pilot-baseline-${randomUUID()}.mjs`, original);
	await writeFile(file, stripTypeScriptTypes(source), { flag: "wx" });
	const cleanup = () => rm(file, { force: true });
	try {
		const module = (await import(file.href)) as T;
		return { module, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}

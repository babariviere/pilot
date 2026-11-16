/** Local source selection. Reads configuration, never changes the user's checkout. */
import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Runner, run } from "./workspaces.ts";

export async function sourceRemote(path: string, runner: Runner = run): Promise<string | undefined> {
	let names: string[];
	try {
		names = (await runner("git", ["remote"], path)).trim().split("\n").filter(Boolean);
	} catch {
		if (
			await lstat(join(path, ".git")).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return undefined;
			})
		)
			throw new Error("Git source is unreadable. Check the repository before selecting a source copy.");
		return undefined;
	}
	const name = names.includes("origin") ? "origin" : names.sort()[0];
	if (!name) return undefined;
	const url = (await runner("git", ["remote", "get-url", name], path)).trim();
	return url.includes(":") ? url : resolve(path, url);
}

export async function localSource(path: string, runner: Runner = run) {
	const canonical = await realpath(path);
	const info = await stat(canonical);
	if (!info.isDirectory()) throw new Error("Choose an existing local folder");
	const remote = await sourceRemote(canonical, runner);
	if (remote) {
		const root = await realpath((await runner("git", ["rev-parse", "--show-toplevel"], canonical)).trim());
		if (root !== canonical) throw new Error("Choose the repository root folder for a project with a Git remote");
	}
	const copy = remote ? ("jj" as const) : ("folder" as const);
	// The remote may contain credentials. Bind its identity without exposing it to the window.
	const digest = createHash("sha256")
		.update(JSON.stringify([canonical, info.dev, info.ino, remote ?? null]))
		.digest("hex");
	return { path: canonical, copy, digest };
}

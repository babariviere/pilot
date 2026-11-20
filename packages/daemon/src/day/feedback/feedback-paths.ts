/** Qualifies only literal paths in the saved user's feedback. No discovery of siblings or parents. */
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { AskContext } from "@pilot/kernel";
import { namedFeedbackPaths } from "@pilot/kernel/feedback-paths";

export async function resolveFeedbackPaths(text: string): Promise<NonNullable<AskContext["feedbackSources"]>> {
	const sources: NonNullable<AskContext["feedbackSources"]> = [];
	for (const name of namedFeedbackPaths(text)) {
		const path = resolve(name.startsWith("~/") ? `${homedir()}/${name.slice(2)}` : name);
		// Whole-filesystem and whole-home access are not file/folder selections.
		if (path === "/" || path === homedir()) continue;
		if (path.split("/").some((part) => [".git", ".jj"].includes(part.toLowerCase()))) continue;
		try {
			const stat = await lstat(path);
			if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
			// Canonicalize system aliases such as macOS /tmp. The root's identity is pinned below.
			const canonical = await realpath(path);
			const home = await realpath(homedir());
			const homeRelative = relative(canonical, home);
			if (!homeRelative.startsWith("..") && !isAbsolute(homeRelative)) continue;
			const current = await lstat(canonical);
			if (current.dev !== stat.dev || current.ino !== stat.ino) continue;
			if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) continue;
			sources.push({ path, kind: stat.isFile() ? "file" : "directory", dev: stat.dev, ino: stat.ino });
		} catch {
			// Non-filesystem references and missing/unreadable paths grant nothing.
		}
	}
	return sources;
}

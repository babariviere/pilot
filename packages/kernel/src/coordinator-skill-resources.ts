/** Read-only resource anchors selected by the native host loader, never by tool arguments or skill prose. */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { contained, sourceContentPath } from "./source-reader.ts";

export interface CoordinatorSkillResource {
	path: string;
	file: string;
	baseDir: string;
	root: string;
	bundle: boolean;
}

/** Capture aliases when the loader selects resources, not on the first caller-selected read. */
export function snapshotCoordinatorSkills(
	skills: readonly Pick<Skill, "filePath" | "baseDir">[],
	agentDir: string,
): readonly CoordinatorSkillResource[] {
	const protectedDirectories = [
		homedir(),
		agentDir,
		join(agentDir, "skills"),
		join(homedir(), ".agents", "skills"),
	].map((path) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	});
	return skills.flatMap((skill) => {
		if (!isAbsolute(skill.filePath) || !isAbsolute(skill.baseDir)) return [];
		try {
			const path = resolve(skill.filePath);
			const baseDir = resolve(skill.baseDir);
			const root = realpathSync(baseDir);
			const file = realpathSync(path);
			// Resource selection does not turn repository control metadata into a skill bundle.
			sourceContentPath(parse(path).root, path);
			sourceContentPath(parse(file).root, file);
			return [
				{
					path,
					file,
					baseDir,
					root,
					// Standalone Markdown and broad configuration containers grant only the entry file.
					bundle:
						basename(path) === "SKILL.md" &&
						dirname(path) === baseDir &&
						!protectedDirectories.some((directory) => contained(root, directory)),
				},
			];
		} catch {
			// Missing loader resources do not grant a fallback parent directory.
			return [];
		}
	});
}

export function coordinatorSkillRead(
	path: string,
	skills: readonly CoordinatorSkillResource[],
): { root: string; path: string } | undefined {
	for (const skill of skills) {
		let selected: { root: string; path: string } | undefined;
		if (path === skill.path || path === skill.file) selected = { root: dirname(skill.file), path: skill.file };
		else if (skill.bundle) {
			const spelling = [skill.baseDir, skill.root].find((root) => contained(root, path));
			if (spelling) selected = { root: skill.root, path: resolve(skill.root, relative(spelling, path)) };
		}
		if (!selected) continue;
		if (realpathSync(skill.baseDir) !== skill.root || realpathSync(skill.path) !== skill.file)
			throw new Error("Coordinator skill resource alias changed; reload resources before reading");
		return selected;
	}
	return undefined;
}

/** Global enabledModels CAS. Never loads credentials or writes through SettingsManager's migrations. */
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelScopeConflict, ModelScopeUpdateRequest } from "@pilot/protocol";
import { settingsPath, withModelSettingsLock } from "./model-settings.ts";

export const MAX_SCOPE_PATTERNS = 256;
export const MAX_SCOPE_PATTERN_LENGTH = 512;

export class ModelScopeConflictError extends Error {
	readonly conflict: ModelScopeConflict;
	constructor(conflict: ModelScopeConflict) {
		super("Model scope changed");
		this.conflict = conflict;
	}
}

export function scopePatterns(value: unknown): string[] | null {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value) || value.some((pattern) => typeof pattern !== "string"))
		throw new Error("Invalid enabledModels setting");
	return value;
}

export function modelScopeHash(value: string[] | null): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function modelScopeUpdate(value: unknown): ModelScopeUpdateRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model scope update");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some((key) => !["enabledModels", "expectedHash"].includes(key)) ||
		!("enabledModels" in input) ||
		typeof input.expectedHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.expectedHash) ||
		(input.enabledModels !== null && !Array.isArray(input.enabledModels))
	)
		throw new Error("Invalid model scope update");
	const patterns = scopePatterns(input.enabledModels);
	if (
		patterns &&
		(patterns.length > MAX_SCOPE_PATTERNS ||
			patterns.some(
				(pattern) =>
					!pattern.trim() || pattern.length > MAX_SCOPE_PATTERN_LENGTH || /[\x00-\x1f\x7f]/.test(pattern),
			))
	)
		throw new Error("Model scope allows at most 256 non-empty patterns of at most 512 characters");
	return { enabledModels: patterns, expectedHash: input.expectedHash };
}

/** Valid JSON has already been checked. Locate root member spans without reserializing other settings. */
function members(text: string): Array<{ key: string; start: number; end: number; comma?: number }> {
	const result: ReturnType<typeof members> = [];
	const tokens = /"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:]+/g;
	let depth = 0;
	let member: (typeof result)[number] | undefined;
	let key = true;
	for (const token of text.matchAll(tokens)) {
		const value = token[0];
		if (depth === 1 && key && value.startsWith('"')) {
			member = { key: JSON.parse(value), start: token.index, end: token.index + value.length };
			result.push(member);
			key = false;
		}
		if (depth === 1 && value === ",") {
			if (member) member.comma = token.index;
			key = true;
		} else if (member && !(depth === 1 && value === "}")) member.end = token.index + value.length;
		if (value === "{" || value === "[") depth++;
		if (value === "}" || value === "]") depth--;
	}
	return result;
}

function edit(text: string, patterns: string[] | null): string {
	const entries = members(text);
	// Work backwards so duplicate keys are handled too, without invalidating earlier offsets.
	const found = entries.filter((entry) => entry.key === "enabledModels");
	if (patterns !== null && !found.length) {
		const end = text.lastIndexOf("}");
		return `${text.slice(0, end)}${entries.length ? "," : ""}\n  "enabledModels": ${JSON.stringify(patterns)}\n${text.slice(end)}`;
	}
	if (patterns === null) {
		// Delete one at a time and re-scan: adjacent duplicate keys may share their separating comma.
		const entry = found.at(-1);
		if (!entry) return text;
		const previous = entries[entries.indexOf(entry) - 1];
		const start = entry.comma === undefined && previous?.comma !== undefined ? previous.comma : entry.start;
		const end = entry.comma === undefined ? entry.end : entry.comma + 1;
		return edit(text.slice(0, start) + text.slice(end), null);
	}
	for (const entry of found.reverse()) {
		const colon = text.indexOf(":", entry.start + JSON.stringify(entry.key).length);
		const start = colon + 1 + (text.slice(colon + 1).match(/^\s*/)?.[0].length ?? 0);
		text = text.slice(0, start) + JSON.stringify(patterns) + text.slice(entry.end);
	}
	return text;
}

export async function writeModelScope(agentDir: string, input: ModelScopeUpdateRequest): Promise<void> {
	const path = join(settingsPath(agentDir), "settings.json");
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await withModelSettingsLock(
		path,
		async (assertOwned) => {
			let text = "{}\n";
			try {
				text = await readFile(path, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			let settings: Record<string, unknown>;
			try {
				settings = JSON.parse(text.replace(/^\uFEFF/, ""));
				if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error();
			} catch {
				throw new Error("Cannot edit malformed global settings");
			}
			const current = scopePatterns(settings.enabledModels);
			const currentHash = modelScopeHash(current);
			if (input.expectedHash !== currentHash) throw new ModelScopeConflictError({ currentHash, current });
			const next = edit(text, input.enabledModels);
			if (next === text) return;
			// Follow an existing settings symlink just like the SDK, but atomically replace its target.
			let destination = path;
			try {
				destination = await realpath(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				const link = await lstat(path).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
				if (link) throw new Error("Cannot edit unresolved global settings symlink");
			}
			const mode = await stat(destination).then(
				(info) => info.mode & 0o777,
				() => 0o600,
			);
			const temporary = `${destination}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, next, { mode, flag: "wx" });
				await chmod(temporary, mode);
				assertOwned();
				await rename(temporary, destination);
			} finally {
				await rm(temporary, { force: true });
			}
		},
		undefined,
		true,
	);
}

/** Global enabledModels CAS. Never loads credentials or writes through SettingsManager's migrations. */
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelScopeConflict, ModelScopeUpdateRequest } from "@pilot/protocol";
import { settingsPath, withModelSettingsLock } from "./model-settings.ts";

export const MAX_SCOPE_PATTERNS = 256;
export const MAX_SCOPE_PATTERN_BYTES = 256;

export class ModelScopeSettingsError extends Error {
	readonly status: 422 | 503;
	constructor(status: 422 | 503) {
		super("settings unreadable");
		this.status = status;
	}
}

export class ModelScopeConflictError extends Error {
	readonly conflict: ModelScopeConflict;
	constructor(conflict: ModelScopeConflict) {
		super("Model scope changed");
		this.conflict = conflict;
	}
}

export function scopePatterns(value: unknown): string[] | null {
	if (value === undefined) return null;
	if (!Array.isArray(value) || value.some((pattern) => typeof pattern !== "string"))
		throw new Error("Invalid enabledModels setting");
	return value;
}

export function modelScopeHash(value: string[] | null): string {
	return createHash("sha256")
		.update(JSON.stringify(value === null ? "absent" : value))
		.digest("hex");
}

function parseScope(text: string | undefined): string[] | null {
	if (text === undefined) return null;
	try {
		const settings: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error();
		return scopePatterns((settings as Record<string, unknown>).enabledModels);
	} catch {
		throw new ModelScopeSettingsError(422);
	}
}

export async function readModelScopeValue(path: string): Promise<string[] | null> {
	let text: string | undefined;
	try {
		try {
			await stat(dirname(path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		// Even a missing file may have an active first-write lock. Do not turn contention into absence.
		text = await withModelSettingsLock(path, async () => {
			try {
				return await readFile(path, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await assertMissing(path);
				return undefined;
			}
		});
	} catch {
		throw new ModelScopeSettingsError(503);
	}
	return parseScope(text);
}

/** ENOENT at a dangling settings symlink is not permission to treat configured settings as absent. */
async function assertMissing(path: string): Promise<void> {
	try {
		await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new ModelScopeSettingsError(503);
}

export function modelScopeUpdate(value: unknown): ModelScopeUpdateRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model scope update");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some((key) => !["enabledModels", "expectedHash"].includes(key)) ||
		!("enabledModels" in input) ||
		typeof input.expectedHash !== "string" ||
		input.expectedHash.length > 256 ||
		(input.enabledModels !== null && !Array.isArray(input.enabledModels))
	)
		throw new Error("Invalid model scope update");
	const patterns = input.enabledModels === null ? null : scopePatterns(input.enabledModels);
	if (
		patterns &&
		(!patterns.length ||
			patterns.length > MAX_SCOPE_PATTERNS ||
			patterns.some(
				(pattern) =>
					!pattern.trim() ||
					Buffer.byteLength(pattern, "utf8") > MAX_SCOPE_PATTERN_BYTES ||
					/[\x00-\x1f\x7f]/.test(pattern),
			))
	)
		throw new Error("Model scope requires 1–256 non-empty patterns of at most 256 UTF-8 bytes, or null");
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

export async function writeModelScope(
	agentDir: string,
	input: ModelScopeUpdateRequest,
): Promise<{ changed: boolean; scopeHash: string }> {
	input = modelScopeUpdate(input);
	const path = join(settingsPath(agentDir), "settings.json");
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		return await withModelSettingsLock(
			path,
			async (assertOwned) => {
				let text = "{}\n";
				try {
					text = await readFile(path, "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					await assertMissing(path);
				}
				assertOwned();
				const current = parseScope(text);
				const scopeHash = modelScopeHash(current);
				if (JSON.stringify(current) === JSON.stringify(input.enabledModels)) return { changed: false, scopeHash };
				if (input.expectedHash !== scopeHash)
					throw new ModelScopeConflictError({ error: "scope_conflict", scopeHash, enabledModels: current });
				const next = edit(text, input.enabledModels);
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
				return { changed: true, scopeHash: modelScopeHash(input.enabledModels) };
			},
			undefined,
			true,
		);
	} catch (error) {
		if (error instanceof ModelScopeConflictError || error instanceof ModelScopeSettingsError) throw error;
		throw new ModelScopeSettingsError(503);
	}
}

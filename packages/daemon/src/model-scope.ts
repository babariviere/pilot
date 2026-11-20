/** Global enabledModels CAS. Never loads credentials or writes through SettingsManager's migrations. */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelScopeConflict, ModelScopeUpdateRequest } from "@pilot/protocol";
import {
	editAgentSettings,
	editModelSetting,
	readSettingsFile,
	SettingsMayHaveChanged,
	withModelSettingsLock,
} from "./model-settings.ts";

const MAX_SCOPE_PATTERNS = 256;
const MAX_SCOPE_PATTERN_BYTES = 256;

export class ModelScopeSettingsError extends Error {
	readonly status: 422 | 503;
	readonly mayHaveWritten: boolean;
	constructor(status: 422 | 503, mayHaveWritten = false) {
		super("settings unreadable");
		this.status = status;
		this.mayHaveWritten = mayHaveWritten;
	}
}

export class ModelScopeConflictError extends Error {
	readonly conflict: ModelScopeConflict;
	constructor(conflict: ModelScopeConflict) {
		super("Model scope changed");
		this.conflict = conflict;
	}
}

function scopePatterns(value: unknown): string[] | null {
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
		text = await withModelSettingsLock(path, () => readSettingsFile(path));
	} catch {
		throw new ModelScopeSettingsError(503);
	}
	return parseScope(text);
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

export async function writeModelScope(
	agentDir: string,
	input: ModelScopeUpdateRequest,
): Promise<{ changed: boolean; scopeHash: string }> {
	input = modelScopeUpdate(input);
	let result = { changed: false, scopeHash: "" };
	try {
		await editAgentSettings(agentDir, (text) => {
			const current = parseScope(text);
			const scopeHash = modelScopeHash(current);
			result = { changed: false, scopeHash };
			if (JSON.stringify(current) === JSON.stringify(input.enabledModels)) return undefined;
			if (input.expectedHash !== scopeHash)
				throw new ModelScopeConflictError({ error: "scope_conflict", scopeHash, enabledModels: current });
			result = { changed: true, scopeHash: modelScopeHash(input.enabledModels) };
			return editModelSetting(text, "enabledModels", input.enabledModels);
		});
	} catch (error) {
		if (error instanceof ModelScopeConflictError || error instanceof ModelScopeSettingsError) throw error;
		throw new ModelScopeSettingsError(503, error instanceof SettingsMayHaveChanged);
	}
	return result;
}

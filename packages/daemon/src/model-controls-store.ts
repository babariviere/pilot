/** Small native edits of Pi's model defaults. Unrelated advanced configuration stays byte-for-byte. */
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { editModelSetting } from "./model-scope.ts";
import { settingsPath, withModelSettingsLock } from "./model-settings.ts";

const KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "pilotTaskPriceLimit"] as const;
/** Validation/CAS/I/O refusal before the settings destination can change. Safe to try a new edit. */
export class ModelDefaultsRefused extends Error {}
export type ModelDefaults = Record<(typeof KEYS)[number], string | number | null>;
export function defaultsHash(values: ModelDefaults): string {
	return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
function values(text: string): ModelDefaults {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		throw new ModelDefaultsRefused("Model defaults could not be read");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid settings");
	const selected = Object.fromEntries(KEYS.map((key) => [key, raw[key] ?? null]));
	if (
		[selected.defaultProvider, selected.defaultModel, selected.defaultThinkingLevel].some(
			(v) => v !== null && typeof v !== "string",
		) ||
		(selected.pilotTaskPriceLimit !== null &&
			(typeof selected.pilotTaskPriceLimit !== "number" || !Number.isFinite(selected.pilotTaskPriceLimit)))
	)
		throw new ModelDefaultsRefused("Invalid model defaults");
	return selected as ModelDefaults;
}
async function contents(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		// A dangling link is unreadable, not an absent configuration.
		if (
			await lstat(path).catch((e: NodeJS.ErrnoException) => {
				if (e.code !== "ENOENT") throw e;
			})
		)
			throw new Error("Unreadable settings");
		return "{}\n";
	}
}
export async function readModelDefaults(agentDir: string) {
	const path = join(settingsPath(agentDir), "settings.json");
	let defaults: ModelDefaults;
	if (
		!(await stat(dirname(path)).catch((e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
		}))
	)
		defaults = values("{}");
	else defaults = await withModelSettingsLock(path, async () => values(await contents(path)));
	return { defaults, defaultsHash: defaultsHash(defaults) };
}
export async function writeModelDefaults(agentDir: string, expectedHash: string, next: ModelDefaults) {
	if (!next || typeof next !== "object" || Array.isArray(next))
		throw new ModelDefaultsRefused("Invalid model defaults");
	if (
		Object.keys(next).sort().join() !== [...KEYS].sort().join() ||
		[next.defaultProvider, next.defaultModel].some(
			(v) => v !== null && (typeof v !== "string" || !v.trim() || v.length > 256 || /[\x00-\x1f]/.test(v)),
		) ||
		(next.defaultThinkingLevel !== null &&
			!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(next.defaultThinkingLevel))) ||
		(next.pilotTaskPriceLimit !== null &&
			(typeof next.pilotTaskPriceLimit !== "number" ||
				!Number.isFinite(next.pilotTaskPriceLimit) ||
				next.pilotTaskPriceLimit <= 0))
	)
		throw new ModelDefaultsRefused("Invalid model defaults");
	const path = join(settingsPath(agentDir), "settings.json");
	let mayHaveWritten = false;
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await withModelSettingsLock(
			path,
			async (assertOwned) => {
				let text = await contents(path);
				if (defaultsHash(values(text)) !== expectedHash)
					throw new ModelDefaultsRefused("Model defaults changed. Read again before saving.");
				for (const key of KEYS) text = editModelSetting(text, key, next[key]);
				const destination = await realpath(path).catch((e: NodeJS.ErrnoException) => {
					if (e.code !== "ENOENT") throw e;
					return path;
				});
				const temporary = `${destination}.${randomUUID()}.tmp`;
				const mode = await stat(destination).then(
					(s) => s.mode & 0o777,
					() => 0o600,
				);
				try {
					const file = await open(temporary, "wx", mode);
					try {
						await file.writeFile(text);
						await file.sync();
					} finally {
						await file.close();
					}
					await chmod(temporary, mode);
					assertOwned();
					mayHaveWritten = true;
					await rename(temporary, destination);
					const dir = await open(dirname(destination), "r");
					try {
						await dir.sync();
					} finally {
						await dir.close();
					}
				} finally {
					await rm(temporary, { force: true });
				}
			},
			undefined,
			true,
		);
	} catch (error) {
		if (mayHaveWritten) throw error;
		if (error instanceof ModelDefaultsRefused) throw error;
		throw new ModelDefaultsRefused("Model defaults were not saved. Read again before a new edit.");
	}
}

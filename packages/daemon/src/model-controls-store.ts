/** Small native edits of Pi's model defaults. Unrelated advanced configuration stays byte-for-byte. */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ProfileModel, WorkProfile } from "@pilot/protocol";
import {
	agentSettingsFile,
	editAgentSettings,
	editModelSetting,
	readSettingsFile,
	SettingsMayHaveChanged,
	withModelSettingsLock,
} from "./model-settings.ts";

const isThinkingLevel = (level: string) => (MODEL_THINKING_LEVELS as readonly string[]).includes(level);
const PRICE_LIMIT_KEY = "pilotTaskPriceLimit";
const KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel", PRICE_LIMIT_KEY] as const;
/** Pilot-owned key for work profiles, beside Pi's own model defaults. */
const PROFILES_KEY = "pilotWorkProfiles";
/**
 * Most work profiles a list holds. It protects model tokens: the planner reads every profile's ID, name and
 * covers line (at most about 250 bytes) on each plan read. Chosen as four times the starting set of three.
 */
const MAX_PROFILES = 12;
/**
 * Most models in one size list. Settings shows every entry of an opened profile and each start counts the working
 * chats of each entry. Chosen as four times the two entries of the starting lists.
 */
const MAX_PROFILE_MODELS = 8;
const sol = (thinking = "medium"): ProfileModel => ({ model: "openai-codex/gpt-6.2-sol", thinking });
const terra = (thinking = "medium"): ProfileModel => ({ model: "openai-codex/gpt-6.1-terra", thinking });
const opus = (thinking = "high"): ProfileModel => ({ model: "anthropic/claude-opus-5-5", thinking });
const sonnet = (thinking = "high"): ProfileModel => ({ model: "anthropic/claude-sonnet-5-5", thinking });
/** The list Pilot uses until the user saves one. An empty saved list means no profiles. */
export const STARTER_PROFILES: readonly WorkProfile[] = [
	{
		id: "backend",
		name: "Backend",
		covers: "Services, APIs, data, jobs and their tests.",
		optInOnly: false,
		large: [sol(), opus()],
		small: [terra(), sonnet()],
	},
	{
		id: "ui",
		name: "UI",
		covers: "Screens, components, styling and their captures.",
		optInOnly: false,
		large: [opus(), sol()],
		small: [sonnet(), terra()],
	},
	{
		id: "cyber",
		name: "Cyber",
		covers: "Security work such as phishing simulation, attack scenarios and detection.",
		optInOnly: true,
		large: [{ model: "anthropic/claude-opus-5", thinking: "high" }],
		small: [{ model: "anthropic/claude-opus-5", thinking: "high" }],
	},
];
/** Validation/CAS/I/O refusal before the settings destination can change. Safe to try a new edit. */
export class ModelDefaultsRefused extends Error {}
export type ModelDefaults = Record<(typeof KEYS)[number], string | number | null>;
/** The saved profile list joins the hash only when present, so a settings file without one keeps its old hash. */
export function defaultsHash(values: ModelDefaults, profiles: WorkProfile[] | null = null): string {
	return createHash("sha256")
		.update(JSON.stringify(profiles === null ? values : { ...values, [PROFILES_KEY]: profiles }))
		.digest("hex");
}
/** Why a work profile list cannot be saved, or undefined when it can. */
export function workProfilesProblem(value: unknown): string | undefined {
	if (!Array.isArray(value)) return "Work profiles must be a list";
	if (value.length > MAX_PROFILES)
		return `A work profile list holds at most ${MAX_PROFILES} profiles and this save has ${value.length}. Remove one first.`;
	const ids = new Set<string>();
	for (const p of value as Record<string, unknown>[]) {
		if (!p || typeof p !== "object" || Array.isArray(p)) return "Each work profile must be an object";
		if (Object.keys(p).sort().join() !== "covers,id,large,name,optInOnly,small")
			return "A work profile has exactly id, name, covers, optInOnly, large and small";
		const line = (v: unknown, max: number) =>
			typeof v === "string" && !!v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
		if (typeof p.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(p.id))
			return "A profile ID has 1 to 32 lowercase letters, digits or dashes and starts with a letter";
		if (ids.has(p.id)) return `Two work profiles use the ID ${p.id}`;
		ids.add(p.id);
		if (!line(p.name, 40)) return `Profile ${p.id} needs a one-line name of at most 40 characters`;
		if (!line(p.covers, 200)) return `Profile ${p.id} needs a one-line covers text of at most 200 characters`;
		if (typeof p.optInOnly !== "boolean") return `Profile ${p.id} needs optInOnly as true or false`;
		for (const size of ["large", "small"] as const) {
			const list = p[size];
			if (!Array.isArray(list)) return `Profile ${p.id} needs a ${size} model list`;
			if (list.length > MAX_PROFILE_MODELS)
				return `A ${size} list holds at most ${MAX_PROFILE_MODELS} models and ${p.id} has ${list.length}. Remove one first.`;
			for (const e of list as Record<string, unknown>[]) {
				if (!e || typeof e !== "object" || Object.keys(e).sort().join() !== "model,thinking")
					return `Each ${size} entry of ${p.id} has exactly model and thinking`;
				if (typeof e.model !== "string" || e.model.length > 256 || !/^[^\s/]+\/\S+$/.test(e.model))
					return `Each ${size} entry of ${p.id} needs a model as provider/modelId`;
				if (typeof e.thinking !== "string" || !isThinkingLevel(e.thinking))
					return `Each ${size} entry of ${p.id} needs a thinking level: ${MODEL_THINKING_LEVELS.join(", ")}`;
			}
			if (new Set(list.map((e) => (e as { model: string }).model)).size !== list.length)
				return `A model appears twice in the ${size} list of ${p.id}`;
		}
	}
	return undefined;
}
function values(text: string): { defaults: ModelDefaults; profiles: WorkProfile[] | null } {
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
	const profiles = raw[PROFILES_KEY] ?? null;
	if (profiles !== null && workProfilesProblem(profiles)) throw new ModelDefaultsRefused("Invalid work profiles");
	return { defaults: selected as ModelDefaults, profiles: profiles as WorkProfile[] | null };
}
/** `profiles` is the starting set until the user saves a list. */
export async function readModelDefaults(agentDir: string) {
	const path = agentSettingsFile(agentDir);
	let read: ReturnType<typeof values>;
	if (
		!(await stat(dirname(path)).catch((e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
		}))
	)
		read = values("{}");
	else read = await withModelSettingsLock(path, async () => values((await readSettingsFile(path)) ?? "{}\n"));
	return {
		defaults: read.defaults,
		profiles: read.profiles ?? structuredClone([...STARTER_PROFILES]),
		defaultsHash: defaultsHash(read.defaults, read.profiles),
	};
}
/** Replaces the saved work profile list. The same lock and hash as the model defaults. */
export async function writeWorkProfiles(agentDir: string, expectedHash: string, profiles: WorkProfile[]) {
	const problem = workProfilesProblem(profiles);
	if (problem) throw new ModelDefaultsRefused(problem);
	await edit(agentDir, expectedHash, (text) => editModelSetting(text, PROFILES_KEY, profiles));
}
export async function writeModelDefaults(agentDir: string, expectedHash: string, next: ModelDefaults) {
	if (!next || typeof next !== "object" || Array.isArray(next))
		throw new ModelDefaultsRefused("Invalid model defaults");
	if (
		Object.keys(next).sort().join() !== [...KEYS].sort().join() ||
		[next.defaultProvider, next.defaultModel].some(
			(v) => v !== null && (typeof v !== "string" || !v.trim() || v.length > 256 || /[\x00-\x1f]/.test(v)),
		) ||
		(next.defaultThinkingLevel !== null && !isThinkingLevel(String(next.defaultThinkingLevel))) ||
		(next.pilotTaskPriceLimit !== null &&
			(typeof next.pilotTaskPriceLimit !== "number" ||
				!Number.isFinite(next.pilotTaskPriceLimit) ||
				next.pilotTaskPriceLimit <= 0))
	)
		throw new ModelDefaultsRefused("Invalid model defaults");
	await edit(agentDir, expectedHash, (text) => {
		for (const key of KEYS) text = editModelSetting(text, key, next[key]);
		return text;
	});
}
async function edit(agentDir: string, expectedHash: string, change: (text: string) => string) {
	try {
		await editAgentSettings(agentDir, (before) => {
			const current = values(before);
			if (defaultsHash(current.defaults, current.profiles) !== expectedHash)
				throw new ModelDefaultsRefused("Model defaults changed. Read again before saving.");
			return change(before);
		});
	} catch (error) {
		if (error instanceof SettingsMayHaveChanged) throw error.cause;
		if (error instanceof ModelDefaultsRefused) throw error;
		throw new ModelDefaultsRefused("Model defaults were not saved. Read again before a new edit.");
	}
}

/** The replacement task price limit, when the user saved a usable one. */
export function taskPriceLimit(settings: Record<string, unknown>): number | undefined {
	const limit = settings[PRICE_LIMIT_KEY];
	return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

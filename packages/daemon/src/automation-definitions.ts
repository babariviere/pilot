import { posix } from "node:path";
import type { Automation, AutomationConditions, AutomationTrigger, ProjectAutomations } from "@pilot/protocol";

export const AUTOMATION_FOLLOW_UP_ATTEMPT_LIMIT = 3;
const triggers = new Set(["workspace.created", "workspace.restored", "run.finished"]);

function record(value: unknown, field: string, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
	const extra = Object.keys(value).find((key) => !keys.includes(key));
	if (extra) throw new Error(`${field}: unknown field ${extra.slice(0, 80)}`);
	return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number, empty = false): string {
	if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || value.includes("\0"))
		throw new Error(
			`${field} must be ${empty ? "a" : "a non-empty"} string of at most ${max} characters, without NUL`,
		);
	return value;
}

function list(value: unknown, field: string, max: number, min = 0): unknown[] {
	if (!Array.isArray(value) || value.length < min || value.length > max || Object.keys(value).length !== value.length)
		throw new Error(`${field} must contain ${min} to ${max} items`);
	return value;
}

export function automationRevision(value: unknown): number {
	const revision = (value as { revision?: unknown } | null)?.revision;
	return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export function validateAutomationItems(value: unknown): Automation[] {
	const ids = new Set<string>();
	return list(value, "automations.items", 32).map((item, index) => {
		const hint = (item as { id?: unknown } | null)?.id;
		const name = typeof hint === "string" ? hint.slice(0, 64) : `automation ${index + 1}`;
		const hook = record(item, name, ["id", "name", "enabled", "on", "when", "action"]);
		const id = text(hook.id, `${name}: id`, 64);
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || ids.has(id))
			throw new Error(`${name}: id must be unique and use lowercase letters, digits or hyphens`);
		ids.add(id);
		const title = text(hook.name, `${name}: name`, 80);
		if (/[\r\n\x00-\x1f\x7f\u2028\u2029]/.test(title)) throw new Error(`${name}: name must be one line`);
		if (typeof hook.enabled !== "boolean") throw new Error(`${name}: enabled must be a boolean`);
		const on = list(hook.on, `${name}: on`, 3, 1);
		if (on.some((trigger) => typeof trigger !== "string" || !triggers.has(trigger)) || new Set(on).size !== on.length)
			throw new Error(`${name}: on must contain unique supported triggers`);
		const finished = on.includes("run.finished");
		if (finished && on.length !== 1) throw new Error(`${name}: run.finished must stand alone`);
		let when: AutomationConditions | undefined;
		if (hook.when !== undefined) {
			if (!finished) throw new Error(`${name}: when is only allowed for run.finished`);
			const conditions = record(hook.when, `${name}: when`, ["filesChanged", "openTodos"]);
			when = {};
			if (conditions.openTodos !== undefined) {
				if (conditions.openTodos !== true) throw new Error(`${name}: openTodos must be true`);
				when.openTodos = true;
			}
			if (conditions.filesChanged !== undefined) {
				if (conditions.filesChanged === true) when.filesChanged = true;
				else {
					const paths = record(conditions.filesChanged, `${name}: filesChanged`, ["paths"]);
					when.filesChanged = {
						paths: list(paths.paths, `${name}: filesChanged.paths`, 16, 1).map((path) => {
							const glob = text(path, `${name}: filesChanged.paths`, 256);
							if (
								glob.startsWith("/") ||
								glob.includes("\\") ||
								glob.split("/").includes("..") ||
								/[[\]{}!]/.test(glob)
							)
								throw new Error(`${name}: filesChanged.paths must be relative globs using *, ** or ?`);
							return glob;
						}),
					};
				}
			}
		}
		const action = record(hook.action, `${name}: action`, [
			"type",
			"run",
			"cwd",
			"env",
			"timeoutMs",
			"onFailure",
			"requires",
			"message",
		]);
		let parsed: Automation["action"];
		if (action.type === "followUp") {
			record(action, `${name}: action`, ["type", "message"]);
			if (!finished || !when || !Object.keys(when).length)
				throw new Error(`${name}: followUp needs a run.finished condition`);
			parsed = {
				type: "followUp",
				...(action.message !== undefined ? { message: text(action.message, `${name}: message`, 2000, true) } : {}),
			};
		} else if (action.type === "shell") {
			record(action, `${name}: action`, ["type", "run", "cwd", "env", "timeoutMs", "onFailure", "requires"]);
			const run = record(action.run, `${name}: run`, ["argv", "shell"]);
			if (Object.keys(run).length !== 1) throw new Error(`${name}: run needs exactly one of argv or shell`);
			parsed = {
				type: "shell",
				run:
					run.argv !== undefined
						? {
								argv: list(run.argv, `${name}: argv`, 64, 1).map((arg, i) =>
									text(arg, `${name}: argv[${i}]`, 4096, i > 0),
								),
							}
						: { shell: text(run.shell, `${name}: shell`, 8192) },
			};
			if (action.cwd !== undefined) {
				const cwd = text(action.cwd, `${name}: cwd`, 512);
				if (
					cwd.startsWith("/") ||
					cwd.includes("\\") ||
					cwd.split("/").includes("..") ||
					posix.normalize(cwd) !== cwd
				)
					throw new Error(`${name}: cwd must be a normalized relative path without ..`);
				parsed.cwd = cwd;
			}
			if (action.env !== undefined) {
				if (
					!action.env ||
					typeof action.env !== "object" ||
					Array.isArray(action.env) ||
					Object.keys(action.env).length > 32
				)
					throw new Error(`${name}: env must contain at most 32 keys`);
				parsed.env = Object.fromEntries(
					Object.entries(action.env).map(([key, value]) => {
						if (
							!/^[A-Z_][A-Z0-9_]*$/.test(key) ||
							/TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL/.test(key) ||
							["PATH", "HOME"].includes(key) ||
							key.startsWith("PILOT_")
						)
							throw new Error(`${name}: env key ${key.slice(0, 64)} is not allowed`);
						return [key, text(value, `${name}: env.${key}`, 4096, true)];
					}),
				);
			}
			if (action.timeoutMs !== undefined) {
				if (
					typeof action.timeoutMs !== "number" ||
					!Number.isInteger(action.timeoutMs) ||
					action.timeoutMs < 1000 ||
					action.timeoutMs > 3_600_000
				)
					throw new Error(`${name}: timeoutMs must be between 1 s and 60 min`);
				parsed.timeoutMs = action.timeoutMs;
			}
			if (action.onFailure !== undefined) {
				if (action.onFailure !== "report" && !(finished && action.onFailure === "followUp"))
					throw new Error(`${name}: onFailure must be report${finished ? " or followUp" : " for setup"}`);
				parsed.onFailure = action.onFailure;
			}
			if (action.requires !== undefined)
				throw new Error(`${name}: requires is not available until environment requirement evaluation ships`);
		} else throw new Error(`${name}: action.type must be shell or followUp`);
		return {
			id,
			name: title,
			enabled: hook.enabled,
			on: on as AutomationTrigger[],
			...(when ? { when } : {}),
			action: parsed,
		};
	});
}

export function validateProjectAutomations(value: unknown): ProjectAutomations {
	const config = record(value, "automations", ["revision", "items"]);
	const revision = automationRevision(config);
	if (revision < 1 || revision >= Number.MAX_SAFE_INTEGER)
		throw new Error("automations.revision must be a positive safe integer below MAX_SAFE_INTEGER");
	return { revision, items: validateAutomationItems(config.items) };
}

export function validateAutomationsUpdate(value: unknown): { expectedRevision: number; items: Automation[] } {
	const request = record(value, "automations", ["expectedRevision", "items"]);
	if (
		typeof request.expectedRevision !== "number" ||
		!Number.isSafeInteger(request.expectedRevision) ||
		request.expectedRevision < 0 ||
		request.expectedRevision >= Number.MAX_SAFE_INTEGER - 1
	)
		throw new Error("expectedRevision must be a non-negative safe integer below MAX_SAFE_INTEGER - 1");
	return { expectedRevision: request.expectedRevision, items: validateAutomationItems(request.items) };
}

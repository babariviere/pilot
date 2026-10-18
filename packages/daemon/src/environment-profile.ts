/** Environment profile validation. Validate before mutation; the profile is replaced, never merged. */
import { isDeepStrictEqual } from "node:util";
import type {
	EnvironmentService,
	EnvironmentSourcePin,
	EnvironmentStep,
	EnvironmentStepRun,
	EnvironmentTool,
	EnvironmentValueOrigin,
	ProjectEnvironment,
	ProjectEnvironmentOverride,
	ReviewPin,
} from "@pilot/protocol";
import { isCredentialField } from "./diagnostic-redaction.ts";

export const ENVIRONMENT_LIMITS = {
	tools: 64,
	services: 8,
	steps: 32,
	env: 64,
	confirmedSources: 64,
	reviewFiles: 64,
	stepInputs: 32,
	argv: 64,
	argBytes: 1024,
	pathBytes: 512,
	envValueBytes: 4096,
	exports: 16,
	copyFiles: 32,
	defaultStepTimeoutMs: 10 * 60_000,
	maxStepTimeoutMs: 60 * 60_000,
} as const;

/** A profile change that adds or alters an approval without the native host-action capability. */
export class EnvironmentApprovalRequired extends Error {
	constructor(message = "Reviews can only be approved in the Pilot app") {
		super(message);
	}
}

const ID = /^[a-z0-9][a-z0-9._@:/-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const EXPORT_VALUES = new Set(["url", "socketUrl", "host", "port", "database", "user"]);
const CONTROL = /[\u0000-\u001f\u007f]/;

function fail(message: string): never {
	throw new Error(message);
}

function record(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
	const extra = Object.keys(value).find((key) => !keys.includes(key));
	if (extra !== undefined) fail(`${name} has an unknown field: ${extra.slice(0, 64)}`);
	return value as Record<string, unknown>;
}

function list(value: unknown, name: string, max: number): unknown[] {
	if (!Array.isArray(value) || value.length > max) fail(`${name} must be a list of at most ${max} entries`);
	return value;
}

function text(value: unknown, name: string, max: number, pattern?: RegExp): string {
	if (typeof value !== "string" || !value || Buffer.byteLength(value) > max || value.includes("\u0000"))
		fail(`${name} must be a non-empty string of at most ${max} bytes`);
	if (pattern && !pattern.test(value)) fail(`${name} is not valid: ${value.slice(0, 64)}`);
	return value;
}

/** Checkout-relative, "/"-separated, no traversal, no absolute or hidden-parent paths. */
export function isSafeRelativePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Buffer.byteLength(value) <= ENVIRONMENT_LIMITS.pathBytes &&
		!CONTROL.test(value) &&
		!value.includes("\\") &&
		!value.startsWith("/") &&
		value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
	);
}

function path(value: unknown, name: string): string {
	if (!isSafeRelativePath(value)) fail(`${name} must be a checkout-relative path without traversal`);
	return value;
}

function argv(value: unknown, name: string, allowEmpty = false): string[] {
	const args = list(value, name, ENVIRONMENT_LIMITS.argv);
	if (!args.length && !allowEmpty) fail(`${name} must not be empty`);
	return args.map((arg) => {
		if (typeof arg !== "string" || Buffer.byteLength(arg) > ENVIRONMENT_LIMITS.argBytes || arg.includes("\u0000"))
			fail(`${name} must contain strings of at most ${ENVIRONMENT_LIMITS.argBytes} bytes`);
		return arg;
	});
}

function pins(value: unknown, name: string, max: number): EnvironmentSourcePin[] {
	const seen = new Set<string>();
	return list(value, name, max).map((entry) => {
		const pin = record(entry, name, ["path", "sha256"]);
		const result = { path: path(pin.path, `${name} path`), sha256: text(pin.sha256, `${name} sha256`, 64, SHA256) };
		if (seen.has(result.path)) fail(`${name} lists ${result.path} twice`);
		seen.add(result.path);
		return result;
	});
}

function review(value: unknown, name: string): ReviewPin {
	const pin = record(value, name, ["files", "reviewedAt"]);
	const files = pins(pin.files, `${name} files`, ENVIRONMENT_LIMITS.reviewFiles);
	if (!files.length) fail(`${name} must cover at least one file`);
	if (typeof pin.reviewedAt !== "number" || !Number.isSafeInteger(pin.reviewedAt) || pin.reviewedAt <= 0)
		fail(`${name} reviewedAt must be a timestamp`);
	return { files, reviewedAt: pin.reviewedAt };
}

function origin(value: unknown, name: string): EnvironmentValueOrigin {
	if (value === "user") return "user";
	const from = record(value, name, ["path", "line"]);
	if (typeof from.line !== "number" || !Number.isSafeInteger(from.line) || from.line < 1)
		fail(`${name} line must be a positive integer`);
	return { path: path(from.path, `${name} path`), line: from.line };
}

/** Exact versions only: no ranges, aliases or "latest". "v1.2.3" and "go1.2.3" are normalized. */
export function normalizeExactVersion(value: string): string {
	return value.replace(/^(?:go|v)(?=\d)/, "");
}

function tool(value: unknown, index: number): EnvironmentTool {
	const name = `tools[${index}]`;
	const entry = record(value, name, ["id", "version", "from"]);
	const version = normalizeExactVersion(text(entry.version, `${name} version`, 64, VERSION));
	if (!/\d/.test(version) || /^(?:latest|stable|lts)$/i.test(version))
		fail(`${name} version must be an exact version, not ${version}`);
	return {
		id: text(entry.id, `${name} id`, 64, ID),
		version,
		from: origin(entry.from, `${name} from`),
	};
}

function service(value: unknown, index: number): EnvironmentService {
	const name = `services[${index}]`;
	const entry = record(value, name, ["id", "kind", "version", "provider", "database", "dbTool", "exports", "compose"]);
	if (entry.kind !== "postgres") fail(`${name} kind must be postgres`);
	if (entry.provider !== "pilot" && entry.provider !== "compose") fail(`${name} provider must be pilot or compose`);
	const result: EnvironmentService = {
		id: text(entry.id, `${name} id`, 64, ID),
		kind: "postgres",
		version: text(entry.version, `${name} version`, 3, /^[1-9][0-9]{0,2}$/),
		provider: entry.provider,
		exports: {},
	};
	if (entry.database !== undefined) {
		if (entry.provider !== "pilot") fail(`${name} database applies to the built-in database only`);
		// <name>_<8>_<8> must stay under Postgres's 63-byte identifier limit.
		result.database = text(entry.database, `${name} database`, 32, /^[a-z_][a-z0-9_]{0,31}$/);
	}
	if (entry.dbTool !== undefined) {
		if (entry.provider !== "pilot") fail(`${name} dbTool applies to the built-in database only`);
		if (entry.dbTool === false) result.dbTool = false;
		else {
			const access = record(entry.dbTool, `${name} dbTool`, ["read", "write"]);
			const level = (value: unknown) =>
				value === "allow" || value === "ask" ? value : fail(`${name} dbTool access must be allow or ask`);
			result.dbTool = { read: level(access.read), write: level(access.write) };
		}
	}
	const exports = record(entry.exports, `${name} exports`, Object.keys(entry.exports ?? {}));
	if (Object.keys(exports).length > ENVIRONMENT_LIMITS.exports)
		fail(`${name} exports must have at most ${ENVIRONMENT_LIMITS.exports} variables`);
	for (const [key, kind] of Object.entries(exports)) {
		if (!ENV_KEY.test(key) || reservedVariable(key)) fail(`${name} exports ${key.slice(0, 64)} is not allowed`);
		if (typeof kind !== "string" || !EXPORT_VALUES.has(kind)) fail(`${name} exports ${key} has an unknown value`);
		result.exports[key] = kind as EnvironmentService["exports"][string];
	}
	if (entry.provider === "compose") {
		const compose = record(entry.compose, `${name} compose`, ["file", "service", "review"]);
		result.compose = {
			file: path(compose.file, `${name} compose file`),
			service: text(compose.service, `${name} compose service`, 128, /^[A-Za-z0-9][A-Za-z0-9._-]*$/),
			...(compose.review === undefined ? {} : { review: review(compose.review, `${name} compose review`) }),
		};
	} else if (entry.compose !== undefined) fail(`${name} compose applies to the compose provider only`);
	return result;
}

function stepRun(value: unknown, name: string): EnvironmentStepRun {
	if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "argv")) {
		const run = record(value, name, ["argv"]);
		return { argv: argv(run.argv, `${name} argv`) };
	}
	const run = record(value, name, ["script", "args"]);
	return {
		script: path(run.script, `${name} script`),
		...(run.args === undefined ? {} : { args: argv(run.args, `${name} args`, true) }),
	};
}

function step(value: unknown, index: number, known: Set<string>): EnvironmentStep {
	const name = `steps[${index}]`;
	const entry = record(value, name, ["id", "title", "run", "review", "inputs", "check", "requires", "timeoutMs"]);
	const title = text(entry.title, `${name} title`, 120);
	if (CONTROL.test(title)) fail(`${name} title must be one line`);
	const result: EnvironmentStep = {
		id: text(entry.id, `${name} id`, 64, ID),
		title,
		run: stepRun(entry.run, `${name} run`),
		inputs: list(entry.inputs, `${name} inputs`, ENVIRONMENT_LIMITS.stepInputs).map((input) =>
			path(input, `${name} inputs`),
		),
		requires: list(entry.requires, `${name} requires`, ENVIRONMENT_LIMITS.tools + ENVIRONMENT_LIMITS.services).map(
			(id) => {
				if (typeof id !== "string" || !known.has(id)) fail(`${name} requires an unknown tool or service`);
				return id;
			},
		),
	};
	if (entry.review !== undefined) result.review = review(entry.review, `${name} review`);
	if (entry.check !== undefined) result.check = argv(entry.check, `${name} check`);
	if (entry.timeoutMs !== undefined) {
		if (
			typeof entry.timeoutMs !== "number" ||
			!Number.isSafeInteger(entry.timeoutMs) ||
			entry.timeoutMs < 1000 ||
			entry.timeoutMs > ENVIRONMENT_LIMITS.maxStepTimeoutMs
		)
			fail(`${name} timeoutMs must be between 1 second and 60 minutes`);
		result.timeoutMs = entry.timeoutMs;
	}
	return result;
}

/** PATH and Pilot's own variables are set by Pilot, never by the profile. */
function reservedVariable(key: string): boolean {
	return /^(?:PATH|HOME|SHELL|USER|LOGNAME|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|PILOT_.*)$/i.test(key);
}

/** Secret-looking names or values are rejected. The profile syncs between hosts and is shown in the app. */
function secretLike(key: string, value: string): boolean {
	return (
		isCredentialField(key) ||
		/(?:^|_)(?:PAT|DSN|PASS|PWD|PRIVATE|CERT|SESSION)(?:_|$)/i.test(key) ||
		/\b(?:Bearer|Basic)\s+\S+|:\/\/[^\s/@]+:[^\s/@]+@|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]+|-----BEGIN/i.test(
			value,
		)
	);
}

function unique<T extends { id: string }>(entries: T[], name: string): T[] {
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.id)) fail(`${name} lists ${entry.id} twice`);
		seen.add(entry.id);
	}
	return entries;
}

function envVars(value: unknown, name: string): Record<string, string> {
	const env = record(value, name, Object.keys(value ?? {}));
	if (Object.keys(env).length > ENVIRONMENT_LIMITS.env)
		fail(`${name} must have at most ${ENVIRONMENT_LIMITS.env} variables`);
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!ENV_KEY.test(key) || reservedVariable(key)) fail(`${name} ${key.slice(0, 64)} is not allowed`);
		if (
			typeof value !== "string" ||
			Buffer.byteLength(value) > ENVIRONMENT_LIMITS.envValueBytes ||
			value.includes("\u0000")
		)
			fail(`${name} ${key} must be a string of at most ${ENVIRONMENT_LIMITS.envValueBytes} bytes`);
		if (secretLike(key, value))
			fail(`${name} ${key} looks like a secret. Keep secrets out of the environment profile`);
		result[key] = value;
	}
	return result;
}

/** Ignored local files to copy into workspaces: checkout-relative, never inside .git or .jj, unique. */
function copyFiles(value: unknown, name: string): string[] {
	const paths = list(value, name, ENVIRONMENT_LIMITS.copyFiles).map((entry) => {
		const file = path(entry, name);
		if (file.split("/").some((part) => part === ".git" || part === ".jj")) fail(`${name} cannot copy ${file}`);
		return file;
	});
	if (new Set(paths).size !== paths.length) fail(`${name} lists a file twice`);
	return paths;
}

/** Validate a complete profile without its revision. Returns a normalized copy; unknown fields are rejected. */
export function validateEnvironmentProfile(value: unknown): Omit<ProjectEnvironment, "revision"> {
	const entry = record(value, "environment", [
		"revision",
		"tools",
		"services",
		"steps",
		"env",
		"confirmedSources",
		"copyFiles",
	]);
	const tools = unique(
		list(entry.tools, "tools", ENVIRONMENT_LIMITS.tools).map((value, index) => tool(value, index)),
		"tools",
	);
	const services = unique(
		list(entry.services, "services", ENVIRONMENT_LIMITS.services).map((value, index) => service(value, index)),
		"services",
	);
	const ids = new Set([...tools.map((tool) => tool.id), ...services.map((service) => service.id)]);
	if (ids.size !== tools.length + services.length) fail("A tool and a service share an ID");
	const exported = services.flatMap((service) => Object.keys(service.exports));
	if (new Set(exported).size !== exported.length) fail("Two services export the same variable");
	const steps = unique(
		list(entry.steps, "steps", ENVIRONMENT_LIMITS.steps).map((value, index) => step(value, index, ids)),
		"steps",
	);
	const result: Omit<ProjectEnvironment, "revision"> = {
		tools,
		services,
		steps,
		confirmedSources: pins(entry.confirmedSources, "confirmedSources", ENVIRONMENT_LIMITS.confirmedSources),
	};
	if (entry.env !== undefined) {
		result.env = envVars(entry.env, "env");
		const clash = Object.keys(result.env).find((key) => exported.includes(key));
		if (clash) fail(`env ${clash} is already exported by a service`);
	}
	if (entry.copyFiles !== undefined) result.copyFiles = copyFiles(entry.copyFiles, "copyFiles");
	return result;
}

/** Validate a saved profile, including its revision. */
export function validateProjectEnvironment(value: unknown): ProjectEnvironment {
	return { revision: revisionOf(value, "environment"), ...validateEnvironmentProfile(value) };
}

function revisionOf(value: unknown, name: string): number {
	const revision = (value as { revision?: unknown } | null)?.revision;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
		fail(`${name} revision must be a non-negative integer`);
	return revision;
}

/**
 * Validate a host override layer without its revision. Entries are checked one by one here; references between
 * layers (a step requiring a shared tool, a removed ID) are checked on the effective profile.
 */
export function validateEnvironmentOverride(value: unknown): Omit<ProjectEnvironmentOverride, "revision"> {
	const entry = record(value, "override", ["revision", "tools", "services", "steps", "remove", "env", "copyFiles"]);
	const result: Omit<ProjectEnvironmentOverride, "revision"> = {};
	if (entry.tools !== undefined)
		result.tools = unique(
			list(entry.tools, "override tools", ENVIRONMENT_LIMITS.tools).map((value, index) => tool(value, index)),
			"override tools",
		);
	if (entry.services !== undefined)
		result.services = unique(
			list(entry.services, "override services", ENVIRONMENT_LIMITS.services).map((value, index) =>
				service(value, index),
			),
			"override services",
		);
	if (entry.steps !== undefined) {
		// Any ID is accepted here; the effective profile checks that requirements exist.
		const anyId = { has: (id: string) => typeof id === "string" && ID.test(id) } as Set<string>;
		result.steps = unique(
			list(entry.steps, "override steps", ENVIRONMENT_LIMITS.steps).map((value, index) => step(value, index, anyId)),
			"override steps",
		);
	}
	if (entry.remove !== undefined) {
		const remove = list(
			entry.remove,
			"override remove",
			ENVIRONMENT_LIMITS.tools + ENVIRONMENT_LIMITS.services + ENVIRONMENT_LIMITS.steps,
		).map((id) => text(id, "override remove", 64, ID));
		result.remove = [...new Set(remove)];
	}
	if (entry.env !== undefined) result.env = envVars(entry.env, "override env");
	if (entry.copyFiles !== undefined) result.copyFiles = copyFiles(entry.copyFiles, "override copyFiles");
	return result;
}

export function validateProjectEnvironmentOverride(value: unknown): ProjectEnvironmentOverride {
	return { revision: revisionOf(value, "override"), ...validateEnvironmentOverride(value) };
}

function layer<T extends { id: string }>(shared: T[], override: T[] | undefined, remove: Set<string>): T[] {
	const replaced = new Map((override ?? []).map((entry) => [entry.id, entry]));
	const merged = shared.filter((entry) => !remove.has(entry.id)).map((entry) => replaced.get(entry.id) ?? entry);
	for (const entry of override ?? []) if (!shared.some((existing) => existing.id === entry.id)) merged.push(entry);
	return merged;
}

/**
 * The profile a host uses: the shared layer with this host's override applied. Override entries replace shared ones
 * with the same ID, remove drops shared IDs, env merges by key (override wins) and copyFiles adds paths.
 * The result keeps the shared revision; plans record the override revision separately.
 */
export function effectiveEnvironment(
	shared: ProjectEnvironment | undefined,
	override: ProjectEnvironmentOverride | undefined,
): ProjectEnvironment | undefined {
	if (!override) return shared;
	const base: ProjectEnvironment = shared ?? { revision: 0, tools: [], services: [], steps: [], confirmedSources: [] };
	const remove = new Set(override.remove ?? []);
	const env = { ...base.env, ...override.env };
	const files = [...new Set([...(base.copyFiles ?? []), ...(override.copyFiles ?? [])])];
	const tools = layer(base.tools, override.tools, remove);
	const services = layer(base.services, override.services, remove);
	const known = new Set([...tools.map((tool) => tool.id), ...services.map((service) => service.id)]);
	return {
		revision: base.revision,
		tools,
		services,
		// A shared change can drop something a host's step required; the step keeps the requirements that still exist.
		steps: layer(base.steps, override.steps, remove).map((step) =>
			step.requires.every((id) => known.has(id))
				? step
				: { ...step, requires: step.requires.filter((id) => known.has(id)) },
		),
		confirmedSources: base.confirmedSources,
		...(Object.keys(env).length ? { env } : {}),
		...(files.length ? { copyFiles: files } : {}),
	};
}

function carrySteps(
	previous: EnvironmentStep[] | undefined,
	next: EnvironmentStep[],
	native: boolean,
): EnvironmentStep[] {
	return next.map((step) => {
		const before = previous?.find((entry) => entry.id === step.id);
		if (!step.review) return step;
		const unchanged = before !== undefined && isDeepStrictEqual(before.run, step.run);
		if (before?.review && isDeepStrictEqual(before.review, step.review)) {
			if (unchanged) return step;
			const { review: _review, ...cleared } = step;
			return cleared;
		}
		if (!native) throw new EnvironmentApprovalRequired();
		return step;
	});
}

function carryServices(
	previous: EnvironmentService[] | undefined,
	next: EnvironmentService[],
	native: boolean,
): EnvironmentService[] {
	return next.map((service) => {
		const review = service.compose?.review;
		if (!service.compose || !review) return service;
		const before = previous?.find((entry) => entry.id === service.id)?.compose;
		const unchanged =
			before !== undefined && before.file === service.compose.file && before.service === service.compose.service;
		if (before?.review && isDeepStrictEqual(before.review, review)) {
			if (unchanged) return service;
			const { review: _review, ...compose } = service.compose;
			return { ...service, compose };
		}
		if (!native) throw new EnvironmentApprovalRequired();
		return service;
	});
}

/**
 * Carry approvals across an edit. Changing a step's run or a compose service's file or service clears its review.
 * Without native approval, a review may only be kept unchanged or removed; adding or altering one throws.
 */
export function applyEnvironmentApprovals<T extends { steps?: EnvironmentStep[]; services?: EnvironmentService[] }>(
	previous: { revision?: number; steps?: EnvironmentStep[]; services?: EnvironmentService[] } | undefined,
	next: T,
	native: boolean,
): T {
	return {
		...next,
		...(next.steps ? { steps: carrySteps(previous?.steps, next.steps, native) } : {}),
		...(next.services ? { services: carryServices(previous?.services, next.services, native) } : {}),
	};
}

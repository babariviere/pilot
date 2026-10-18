/**
 * Per-host environment state: last plan, readiness and recent errors per project. Never synced, never in
 * projects.json. Written atomically with mode 0600; a damaged file is moved aside instead of trusted.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentError, EnvironmentPlan, EnvironmentReadiness } from "@pilot/protocol";

export interface ProjectEnvironmentState {
	/** Last computed plan preview. Confirmation always recomputes; this is for display and offline summaries. */
	plan?: EnvironmentPlan;
	/** Host-level readiness of tools and services. */
	readiness?: EnvironmentReadiness;
	/** Most recent errors, newest last. */
	errors?: EnvironmentError[];
	updatedAt: number;
}

interface StateFile {
	version: 1;
	projects: Record<string, ProjectEnvironmentState>;
}

export const ENVIRONMENT_STATE_LIMITS = {
	/** Serialized bytes per project. */
	projectBytes: 256 * 1024,
	planItems: 256,
	readinessItems: 256,
	errors: 16,
	errorOutputBytes: 4096,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function truncateBytes(text: string, max: number): string {
	if (Buffer.byteLength(text) <= max) return text;
	// Keep the tail: the end of command output carries the failure.
	let tail = text.slice(-max);
	while (Buffer.byteLength(tail) > max) tail = tail.slice(1);
	return tail;
}

/** Bound one entry. Returns undefined when it cannot be kept. */
export function boundEnvironmentState(value: unknown): ProjectEnvironmentState | undefined {
	if (!isRecord(value) || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
	const state: ProjectEnvironmentState = { updatedAt: value.updatedAt };
	if (
		isRecord(value.plan) &&
		Array.isArray(value.plan.items) &&
		value.plan.items.length <= ENVIRONMENT_STATE_LIMITS.planItems
	)
		state.plan = value.plan as unknown as EnvironmentPlan;
	if (
		isRecord(value.readiness) &&
		typeof value.readiness.state === "string" &&
		Array.isArray(value.readiness.items) &&
		value.readiness.items.length <= ENVIRONMENT_STATE_LIMITS.readinessItems
	)
		state.readiness = value.readiness as unknown as EnvironmentReadiness;
	if (Array.isArray(value.errors))
		state.errors = value.errors
			.filter((error): error is EnvironmentError => isRecord(error) && typeof error.output === "string")
			.slice(-ENVIRONMENT_STATE_LIMITS.errors)
			.map((error) => ({
				...error,
				output: truncateBytes(error.output, ENVIRONMENT_STATE_LIMITS.errorOutputBytes),
			}));
	if (Buffer.byteLength(JSON.stringify(state)) > ENVIRONMENT_STATE_LIMITS.projectBytes) return undefined;
	return state;
}

export class EnvironmentStateStore {
	private projects = new Map<string, ProjectEnvironmentState>();
	private saving: Promise<void> = Promise.resolve();
	private readonly directory: string;

	constructor(home: string) {
		this.directory = join(home, "environment");
	}

	private get file(): string {
		return join(this.directory, "state.json");
	}

	async load(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		let raw: string;
		try {
			raw = await readFile(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = undefined;
		}
		if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.projects)) {
			// Derived state only: start empty, but keep the damaged bytes for diagnosis.
			const aside = `${this.file}.damaged-${Date.now()}`;
			await rename(this.file, aside);
			console.warn(`pilotd: environment state was unreadable; moved to ${aside}`);
			return;
		}
		for (const [projectId, value] of Object.entries(parsed.projects)) {
			const state = boundEnvironmentState(value);
			if (state) this.projects.set(projectId, state);
		}
	}

	get(projectId: string): ProjectEnvironmentState | undefined {
		return this.projects.get(projectId);
	}

	/** Merge fields into a project's state. Fails without writing when the result exceeds its bounds. */
	async update(
		projectId: string,
		change: Partial<Omit<ProjectEnvironmentState, "updatedAt">>,
		now = Date.now(),
	): Promise<ProjectEnvironmentState> {
		const next = boundEnvironmentState({ ...this.projects.get(projectId), ...change, updatedAt: now });
		if (!next) throw new Error("Environment state is too large to keep");
		this.projects.set(projectId, next);
		await this.persist();
		return next;
	}

	/** Drop state of projects that no longer exist on this host. */
	async retain(projectIds: Iterable<string>): Promise<void> {
		const keep = new Set(projectIds);
		let changed = false;
		for (const id of this.projects.keys())
			if (!keep.has(id)) {
				this.projects.delete(id);
				changed = true;
			}
		if (changed) await this.persist();
	}

	/** Resolves after every queued write has settled. */
	flush(): Promise<void> {
		return this.saving.catch(() => undefined);
	}

	private persist(): Promise<void> {
		const snapshot: StateFile = { version: 1, projects: Object.fromEntries(this.projects) };
		const body = `${JSON.stringify(snapshot)}\n`;
		this.saving = this.saving
			.catch(() => undefined)
			.then(async () => {
				const temp = `${this.file}.${randomUUID()}.tmp`;
				await writeFile(temp, body, { mode: 0o600 });
				await rename(temp, this.file);
			});
		return this.saving;
	}
}

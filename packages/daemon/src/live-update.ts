/** Project-only proposals. Native approval owns one durable freeze across both restarts. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Conflict } from "./errors.ts";
import { durableJSON } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import type { RuntimeBlocker, RuntimeResources } from "./runtime-admission.ts";
import type { RuntimeBuild } from "./runtime-owner.ts";

interface RuntimeTarget {
	source: string;
	build: RuntimeBuild;
	runtimeRoot: string;
}
export interface LiveUpdateTarget extends RuntimeTarget {
	guiBuild: string;
}
export interface LiveUpdateIdentity extends RuntimeTarget {
	boot: string;
	guiBuild?: string;
}
export interface LiveUpdate {
	schema: 1;
	id: string;
	sessionId: string;
	projectId: string;
	directory: string;
	source: string;
	build: string;
	summary: string;
	phase:
		| "proposed"
		| "draining"
		| "gui-installing"
		| "gui-ready"
		| "daemon-installing"
		| "resuming"
		| "completed"
		| "cancelled";
	initialBoot?: string;
	target?: LiveUpdateTarget;
	guiReceipt?: LiveUpdateIdentity;
	outcome?: "completed" | "cancelled";
}
export interface LiveUpdateHooks {
	/** Server-owned, immutable process-start identity. Never taken from a request or public hello. */
	runtime?: LiveUpdateIdentity;
	pauseForUpdate(): { ready: boolean } | Promise<{ ready: boolean }>;
	save?(file: string, value: LiveUpdate): Promise<void>;
}
const idPattern = /^[a-zA-Z0-9._:-]{1,128}$/u;
const RECORD_CAP = 256 * 1024;
const HISTORY_CAP = 1024;
const sourcePattern = /^[a-f0-9]{40}$/u;
const active = (v: LiveUpdate | undefined) => !!v && !["proposed", "completed", "cancelled"].includes(v.phase);
const invalid = (): never => {
	throw new Conflict("Invalid live update record or identity");
};
const keys = (v: object) => Object.keys(v).sort().join(",");
const pathOK = (v: unknown): v is string =>
	typeof v === "string" && isAbsolute(v) && v.length <= 2048 && !/[\x00-\x1f\x7f]/u.test(v);
function targetOK(v: RuntimeTarget): boolean {
	if (!v || typeof v !== "object" || !pathOK(v.runtimeRoot) || !sourcePattern.test(v.source)) return false;
	const b = v.build;
	return (
		!!b &&
		typeof b === "object" &&
		keys(b) === "arch,node,platform,protocol,schema,source,version" &&
		b.schema === 1 &&
		b.source === v.source &&
		Number.isSafeInteger(b.protocol) &&
		b.protocol > 0 &&
		[b.version, b.platform, b.arch, b.node].every((s) => typeof s === "string" && /^[a-zA-Z0-9.+_-]{1,128}$/u.test(s))
	);
}
function identityOK(v: LiveUpdateIdentity): boolean {
	return (
		targetOK(v) &&
		typeof v.boot === "string" &&
		idPattern.test(v.boot) &&
		(keys(v) === "boot,build,runtimeRoot,source" ||
			(keys(v) === "boot,build,guiBuild,runtimeRoot,source" &&
				typeof v.guiBuild === "string" &&
				/^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){0,3}$/u.test(v.guiBuild)))
	);
}
function sameTarget(a: RuntimeTarget, b: RuntimeTarget): boolean {
	return (
		a.source === b.source &&
		a.runtimeRoot === b.runtimeRoot &&
		["schema", "source", "version", "protocol", "platform", "arch", "node"].every(
			(k) => a.build[k as keyof RuntimeBuild] === b.build[k as keyof RuntimeBuild],
		)
	);
}
function validate(value: unknown): LiveUpdate {
	const v = value as LiveUpdate;
	if (
		!v ||
		typeof v !== "object" ||
		Array.isArray(v) ||
		v.schema !== 1 ||
		Object.keys(v).some(
			(k) =>
				![
					"schema",
					"id",
					"sessionId",
					"projectId",
					"directory",
					"source",
					"build",
					"summary",
					"phase",
					"initialBoot",
					"target",
					"guiReceipt",
					"outcome",
				].includes(k),
		) ||
		![v.id, v.sessionId, v.projectId].every((s) => typeof s === "string" && idPattern.test(s)) ||
		!pathOK(v.directory) ||
		typeof v.source !== "string" ||
		!sourcePattern.test(v.source) ||
		typeof v.build !== "string" ||
		!/^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){0,3}$/u.test(v.build) ||
		typeof v.summary !== "string" ||
		!v.summary.trim() ||
		v.summary.length > 2000 ||
		/[\x00-\x08\x0b-\x1f\x7f]/u.test(v.summary) ||
		![
			"proposed",
			"draining",
			"gui-installing",
			"gui-ready",
			"daemon-installing",
			"resuming",
			"completed",
			"cancelled",
		].includes(v.phase)
	)
		invalid();
	if (v.initialBoot !== undefined && (typeof v.initialBoot !== "string" || !idPattern.test(v.initialBoot))) invalid();
	if (active(v) && !v.initialBoot) invalid();
	if (
		v.target !== undefined &&
		(!targetOK(v.target) ||
			keys(v.target) !== "build,guiBuild,runtimeRoot,source" ||
			v.target.source !== v.source ||
			v.target.guiBuild !== v.build)
	)
		invalid();
	if (
		v.guiReceipt !== undefined &&
		(!identityOK(v.guiReceipt) ||
			!v.target ||
			!sameTarget(v.target, v.guiReceipt) ||
			v.guiReceipt.guiBuild !== v.build)
	)
		invalid();
	if (["gui-installing", "gui-ready", "daemon-installing", "completed"].includes(v.phase) && !v.target) invalid();
	if (["gui-ready", "daemon-installing", "completed"].includes(v.phase) && !v.guiReceipt) invalid();
	if (v.outcome !== undefined && !["completed", "cancelled"].includes(v.outcome)) invalid();
	if (v.phase === "resuming" && (!v.outcome || (v.outcome === "completed" && (!v.target || !v.guiReceipt)))) invalid();
	if (["completed", "cancelled"].includes(v.phase) && v.outcome !== v.phase) invalid();
	if (v.phase === "proposed" && (v.initialBoot || v.target || v.guiReceipt || v.outcome)) invalid();
	if (["draining", "gui-installing", "gui-ready", "daemon-installing"].includes(v.phase) && v.outcome) invalid();
	if (v.phase === "draining" && (v.target || v.guiReceipt)) invalid();
	if (v.phase === "gui-installing" && v.guiReceipt) invalid();
	if (v.outcome === "cancelled" && (v.target || v.guiReceipt)) invalid();
	if (v.phase === "completed" && !v.initialBoot) invalid();
	return structuredClone(v);
}

/** No lifecycle commands. Native authorization and full staged-bundle validation belong to routes. */
export class LiveUpdateService {
	private current?: LiveUpdate;
	private history: string[] = [];
	private loading?: Promise<void>;
	private loaded = false;
	private failed = false;
	private closing = false;
	private pending: Promise<unknown> = Promise.resolve();
	private queued = 0;
	private releaseSessions?: () => void;
	private releaseResources?: () => void;
	private resources?: RuntimeResources;
	private readonly listeners = new Set<() => void>();
	private readonly hooks: LiveUpdateHooks;
	private readonly home: string;
	private readonly projects: Pick<ProjectStore, "origin">;
	private readonly freezeSessions: () => () => void;
	private readonly resume: () => Promise<void>;
	constructor(
		home: string,
		projects: Pick<ProjectStore, "origin">,
		freezeSessions: () => () => void,
		resume: () => Promise<void>,
		hooks: LiveUpdateHooks,
	) {
		if (hooks.runtime !== undefined && !identityOK(hooks.runtime)) invalid();
		this.home = home;
		this.projects = projects;
		this.freezeSessions = freezeSessions;
		this.resume = resume;
		this.hooks = { ...hooks, runtime: structuredClone(hooks.runtime) };
	}
	/** Attach exactly once before load and before any session/resource startup. */
	attach(resources: RuntimeResources): void {
		if (this.resources || this.loading) throw new Conflict("Attach resources once before loading live updates");
		this.resources = resources;
	}
	load(): Promise<void> {
		this.loading ??= this.readRecord();
		return this.loading;
	}
	private async readRecord(): Promise<void> {
		try {
			if (!this.resources) throw new Conflict("Live update resources must be attached before load");
			this.freeze();
			try {
				const file = await open(
					join(this.home, "live-update.json"),
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				try {
					const before = await file.stat({ bigint: true });
					if (
						!before.isFile() ||
						before.size > BigInt(RECORD_CAP) ||
						before.nlink !== 1n ||
						before.uid !== BigInt(process.getuid?.() ?? -1) ||
						before.mode & 0o077n
					)
						throw new Error("Unsafe update record");
					const bytes = Buffer.alloc(RECORD_CAP + 1);
					let count = 0;
					while (count < bytes.length) {
						const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
						if (!bytesRead) break;
						count += bytesRead;
					}
					const after = await file.stat({ bigint: true });
					if (
						count > RECORD_CAP ||
						BigInt(count) !== before.size ||
						["dev", "ino", "size", "mode", "nlink", "uid", "mtimeNs", "ctimeNs"].some(
							(k) => before[k as keyof typeof before] !== after[k as keyof typeof after],
						)
					)
						throw new Error("Unstable update record");
					const { history = [], ...entry } = JSON.parse(bytes.subarray(0, count).toString("utf8"));
					if (!Array.isArray(history) || history.length > HISTORY_CAP) invalid();
					this.current = validate(entry);
					this.history = history;
					const ids = new Set([this.current.id]);
					for (const previous of this.history) {
						if (typeof previous !== "string" || !idPattern.test(previous) || ids.has(previous)) invalid();
						ids.add(previous);
					}
				} finally {
					await file.close();
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (!active(this.current)) this.release();
			this.loaded = true;
		} catch (error) {
			this.fail();
			throw error;
		}
	}
	get frozen(): boolean {
		return !this.loaded || active(this.current) || this.failed;
	}
	snapshot(): LiveUpdate | null {
		return this.current ? structuredClone(this.current) : null;
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private freeze(): void {
		this.releaseSessions ??= this.freezeSessions();
		this.releaseResources ??= this.resources?.freezeAdmissions();
	}
	private release(): void {
		const resources = this.releaseResources,
			sessions = this.releaseSessions;
		this.releaseResources = undefined;
		this.releaseSessions = undefined;
		resources?.();
		sessions?.();
	}
	private fail(): void {
		this.failed = true;
		try {
			this.freeze();
		} catch {
			/* Remain unavailable even if a contributor fails. */
		}
	}
	private exclusive<T>(work: () => Promise<T>): Promise<T> {
		if (!this.loaded || this.failed || this.closing || this.queued >= 16)
			return Promise.reject(new Conflict("Live update is unavailable; inspect its retained record"));
		this.queued++;
		const result = this.pending
			.then(() => {
				if (this.failed) throw new Conflict("Live update requires recovery");
				return work();
			})
			.finally(() => {
				this.queued--;
			});
		this.pending = result.catch(() => undefined);
		return result;
	}
	private async save(next: LiveUpdate, history = this.history): Promise<LiveUpdate> {
		next = validate(next);
		const record = { ...next, history };
		if (history.length > HISTORY_CAP || Buffer.byteLength(JSON.stringify(record)) > RECORD_CAP)
			throw new Conflict("Live update history capacity reached; retain the record for inspection");
		try {
			await (this.hooks.save ?? durableJSON)(join(this.home, "live-update.json"), record);
		} catch (error) {
			this.fail();
			throw error;
		}
		this.current = next;
		this.history = structuredClone(history);
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* Observers cannot change committed outcomes. */
			}
		}
		return structuredClone(next);
	}
	async eligible(projectId: string): Promise<boolean> {
		return (await this.projects.origin(projectId)).identity === '["github.com","babariviere/pilot"]';
	}
	propose(
		sessionId: string,
		projectId: string,
		id: string,
		args: Record<string, unknown> | { directory: string; source: string; build: string; summary: string },
		authorize?: () => void,
	): Promise<LiveUpdate> {
		return this.exclusive(async () => {
			authorize?.();
			if (!(await this.eligible(projectId)))
				throw new Conflict("Live updates are available only in the Pilot source project");
			authorize?.();
			if (keys(args) !== "build,directory,source,summary") invalid();
			const next = validate({ ...args, schema: 1, id, sessionId, projectId, phase: "proposed" });
			if (this.history.includes(id)) throw new Conflict("Proposal operation was superseded; cannot replay it");
			const previous = this.current?.id === id ? this.current : undefined;
			if (previous) {
				for (const field of ["sessionId", "projectId", "directory", "source", "build", "summary"] as const)
					if (previous[field] !== next[field])
						throw new Conflict("Proposal identity was reused with different content");
				return structuredClone(previous);
			}
			if (this.current && !["completed", "cancelled"].includes(this.current.phase))
				throw new Conflict("Another live update requires recovery");
			return this.save(next, this.current ? [...this.history, this.current.id] : this.history);
		});
	}
	private require(id: string, ...phases: LiveUpdate["phase"][]): LiveUpdate {
		if (!this.current || this.current.id !== id || !phases.includes(this.current.phase))
			throw new Conflict("Live update changed or requires inspection");
		return this.current;
	}
	accept(id: string): Promise<LiveUpdate> {
		return this.exclusive(async () => {
			const v = this.require(id, "proposed");
			if (!this.hooks.runtime) throw new Conflict("Packaged runtime identity is unavailable");
			if (!(await this.eligible(v.projectId))) throw new Conflict("Pilot project origin changed");
			try {
				this.freeze();
			} catch (error) {
				this.fail();
				throw error;
			}
			// Hold admissions across the write. No pause starts before the freeze is durable.
			return this.save({ ...v, phase: "draining", initialBoot: this.hooks.runtime.boot });
		});
	}
	private async readiness(): Promise<{ ready: boolean; blockers: RuntimeBlocker[] }> {
		const paused = await this.hooks.pauseForUpdate();
		const blockers = await this.resources!.blockers();
		return { ready: paused.ready && blockers.length === 0, blockers };
	}
	progress(id: string): Promise<{ update: LiveUpdate; ready: boolean; blockers: RuntimeBlocker[] }> {
		return this.exclusive(async () => {
			const v = this.require(
				id,
				"draining",
				"gui-installing",
				"gui-ready",
				"daemon-installing",
				"resuming",
				"completed",
				"cancelled",
			);
			if (v.phase === "resuming") return { update: await this.finish(v), ready: false, blockers: [] };
			if (["completed", "cancelled"].includes(v.phase)) throw new Conflict("Live update is already resumed");
			return { update: structuredClone(v), ...(await this.readiness()) };
		});
	}
	armGui(id: string, target: LiveUpdateTarget): Promise<LiveUpdate> {
		const pinned = structuredClone(target);
		return this.exclusive(async () => {
			const v = this.require(id, "draining");
			if (!targetOK(pinned) || pinned.source !== v.source || pinned.guiBuild !== v.build) invalid();
			if (!(await this.readiness()).ready) throw new Conflict("Active or unknown resources still block the update");
			return this.save({ ...v, phase: "gui-installing", target: pinned });
		});
	}
	/** Caller must verify this exact identity through trusted native GUI restart evidence. */
	guiReady(id: string, receipt: LiveUpdateIdentity): Promise<LiveUpdate> {
		const pinned = structuredClone(receipt);
		return this.exclusive(async () => {
			const v = this.require(id, "gui-installing");
			if (!identityOK(pinned) || !sameTarget(v.target!, pinned) || pinned.guiBuild !== v.build)
				throw new Conflict("GUI restart identity mismatch");
			return this.save({ ...v, phase: "gui-ready", guiReceipt: pinned });
		});
	}
	armDaemon(id: string): Promise<LiveUpdate> {
		return this.exclusive(async () => {
			const v = this.require(id, "gui-ready");
			if (!(await this.readiness()).ready) throw new Conflict("Resources still block daemon installation");
			return this.save({ ...v, phase: "daemon-installing" });
		});
	}
	complete(id: string): Promise<LiveUpdate> {
		return this.exclusive(async () => {
			const v = this.require(id, "daemon-installing");
			if (
				!this.hooks.runtime ||
				!v.guiReceipt ||
				this.hooks.runtime.boot === v.initialBoot ||
				!sameTarget(this.hooks.runtime, v.target!)
			)
				throw new Conflict("New daemon runtime identity is not confirmed");
			return this.finish(await this.save({ ...v, phase: "resuming", outcome: "completed" }));
		});
	}
	cancel(id: string): Promise<LiveUpdate> {
		return this.exclusive(async () => {
			const v = this.require(id, "proposed", "draining");
			if (v.phase === "proposed") return this.save({ ...v, phase: "cancelled", outcome: "cancelled" });
			return this.finish(await this.save({ ...v, phase: "resuming", outcome: "cancelled" }));
		});
	}
	private async finish(v: LiveUpdate): Promise<LiveUpdate> {
		try {
			// A crash during resumption must not authorize a different runtime on recovery.
			if (v.outcome === "completed") {
				if (
					!this.hooks.runtime ||
					!v.guiReceipt ||
					this.hooks.runtime.boot === v.initialBoot ||
					!sameTarget(this.hooks.runtime, v.target!)
				)
					throw new Conflict("New daemon runtime identity is not confirmed");
				if (!(await this.readiness()).ready) throw new Conflict("Resources still block completion");
			}
			// Terminal means durable authorization to release, not proof that in-process
			// resumption finished. Commit before any tool resumes, and never write after
			// release. Future boots follow ordinary recovery without old-runtime pinning.
			const terminal = await this.save({ ...v, phase: v.outcome! });
			this.release();
			await this.resume();
			return terminal;
		} catch (error) {
			this.fail();
			throw error;
		}
	}
	async close(): Promise<void> {
		this.closing = true;
		await this.pending;
	}
}

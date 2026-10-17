/** Bounded, content-free session lifecycle evidence. This store never opens or contacts a kernel. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import type { SessionState } from "@pilot/protocol";
import release from "../../../package.json" with { type: "json" };

export const LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const LIFECYCLE_FILE = "lifecycle.jsonl";
export const MAX_LIFECYCLE_EVENT_BYTES = 1024;
export const MAX_LIFECYCLE_FILE_BYTES = 256 * 1024;
export const MAX_LIFECYCLE_PENDING_PER_SESSION = 64;
const MAX_PENDING_TOTAL = 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;

export type LifecycleKind =
	| "worker.start.requested"
	| "worker.started"
	| "worker.start.failed"
	| "worker.parked"
	| "worker.recovery.started"
	| "worker.recovery.completed"
	| "worker.recovery.failed"
	| "execution.started"
	| "execution.completed"
	| "pause.changed"
	| "quota.changed"
	| "connectivity.changed";

export type LifecycleReason =
	| "user"
	| "sleep"
	| "update"
	| "quota"
	| "connectivity"
	| "startup"
	| "startup_failure"
	| "process_exit"
	| "recovery_backoff"
	| "parked_idle"
	| "work"
	| "unknown";

export type LifecycleEventState = SessionState | "paused" | "resumed" | "completed";

export interface LifecycleEvent {
	v: typeof LIFECYCLE_SCHEMA_VERSION;
	id: string;
	at: string;
	source: "daemon";
	release: string;
	hostKind: "local" | "devbox";
	kind: LifecycleKind;
	reason: LifecycleReason;
	state: LifecycleEventState;
	traceId?: string;
	durationMs?: number;
	count?: number;
	droppedBefore?: number;
}

export interface LifecycleObservation {
	state: SessionState;
	working: boolean;
	sleepPaused: boolean;
	offlinePaused: boolean;
	quotaPaused: boolean;
	updatePaused: boolean;
	recoveryPending: boolean;
	recoveryStopped: boolean;
	startupFailed: boolean;
}

const KINDS = new Set<LifecycleKind>([
	"worker.start.requested",
	"worker.started",
	"worker.start.failed",
	"worker.parked",
	"worker.recovery.started",
	"worker.recovery.completed",
	"worker.recovery.failed",
	"execution.started",
	"execution.completed",
	"pause.changed",
	"quota.changed",
	"connectivity.changed",
]);
const REASONS = new Set<LifecycleReason>([
	"user",
	"sleep",
	"update",
	"quota",
	"connectivity",
	"startup",
	"startup_failure",
	"process_exit",
	"recovery_backoff",
	"parked_idle",
	"work",
	"unknown",
]);
const STATES = new Set<LifecycleEventState>([
	"parked",
	"starting",
	"idle",
	"working",
	"failed",
	"paused",
	"resumed",
	"completed",
]);

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Strictly copy allowlisted fields. Runtime callers cannot smuggle arbitrary attributes into the log. */
export function lifecycleLine(event: LifecycleEvent): string | undefined {
	if (
		event.v !== LIFECYCLE_SCHEMA_VERSION ||
		!/^[-0-9a-f]{1,80}$/.test(event.id) ||
		Number.isNaN(Date.parse(event.at)) ||
		event.source !== "daemon" ||
		!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(event.release) ||
		(event.hostKind !== "local" && event.hostKind !== "devbox") ||
		!KINDS.has(event.kind) ||
		!REASONS.has(event.reason) ||
		!STATES.has(event.state) ||
		(event.traceId !== undefined && !TRACE_ID.test(event.traceId))
	)
		return;
	const safe: LifecycleEvent = {
		v: LIFECYCLE_SCHEMA_VERSION,
		id: event.id,
		at: new Date(event.at).toISOString(),
		source: "daemon",
		release: event.release,
		hostKind: event.hostKind,
		kind: event.kind,
		reason: event.reason,
		state: event.state,
		...(event.traceId ? { traceId: event.traceId } : {}),
		...(finite(event.durationMs) ? { durationMs: Math.round(event.durationMs * 100) / 100 } : {}),
		...(finite(event.count) ? { count: Math.floor(event.count) } : {}),
		...(finite(event.droppedBefore) ? { droppedBefore: Math.floor(event.droppedBefore) } : {}),
	};
	const line = `${JSON.stringify(safe)}\n`;
	return Buffer.byteLength(line) <= MAX_LIFECYCLE_EVENT_BYTES ? line : undefined;
}

/** Parse one retained line through the writer's closed schema. */
export function parseLifecycleDiagnostic(value: unknown): LifecycleEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const line = lifecycleLine(value as LifecycleEvent);
	if (!line) return;
	return JSON.parse(line) as LifecycleEvent;
}

function pauseReason(observation: LifecycleObservation): LifecycleReason {
	if (observation.sleepPaused) return "sleep";
	if (observation.updatePaused) return "update";
	if (observation.offlinePaused) return "connectivity";
	if (observation.quotaPaused) return "quota";
	if (observation.recoveryStopped) return "user";
	if (observation.recoveryPending) return "recovery_backoff";
	return "parked_idle";
}

interface PendingLine {
	sessionId: string;
	line: string;
}

export interface LifecycleDiagnosticsOptions {
	maxBytes?: number;
	maxPendingPerSession?: number;
	hostKind?: LifecycleEvent["hostKind"];
	release?: string;
	now?: () => Date;
}

/**
 * A single asynchronous writer for all sessions. Observations are synchronous and never wait on disk. Per-session
 * queues and files are bounded; one broken session path does not disable evidence for other sessions.
 */
export class LifecycleDiagnostics {
	private readonly previous = new Map<string, LifecycleObservation>();
	private readonly pending: PendingLine[] = [];
	private readonly pendingBySession = new Map<string, number>();
	private readonly droppedBySession = new Map<string, number>();
	private readonly disabled = new Set<string>();
	private readonly boot = randomUUID();
	private sequence = 0;
	private writing?: Promise<void>;
	private closed = false;
	private readonly maxBytes: number;
	private readonly maxPendingPerSession: number;
	private readonly hostKind: LifecycleEvent["hostKind"];
	private readonly release: string;
	private readonly now: () => Date;
	private readonly home: string;

	constructor(home: string, options: LifecycleDiagnosticsOptions = {}) {
		this.home = home;
		this.maxBytes = Math.max(
			MAX_LIFECYCLE_EVENT_BYTES,
			Math.min(MAX_LIFECYCLE_FILE_BYTES, options.maxBytes ?? MAX_LIFECYCLE_FILE_BYTES),
		);
		this.maxPendingPerSession = Math.max(
			1,
			Math.min(MAX_LIFECYCLE_PENDING_PER_SESSION, options.maxPendingPerSession ?? MAX_LIFECYCLE_PENDING_PER_SESSION),
		);
		this.hostKind = options.hostKind ?? (process.platform === "linux" ? "devbox" : "local");
		this.release = options.release ?? release.version;
		this.now = options.now ?? (() => new Date());
	}

	/** Observe a content-free projection. The first parked/idle snapshot is a baseline, not a fabricated transition. */
	observe(sessionId: string, current: LifecycleObservation): void {
		if (this.closed || !SESSION_ID.test(sessionId)) return;
		const previous = this.previous.get(sessionId);
		this.previous.set(sessionId, { ...current });
		if (!previous) {
			if (current.state === "starting") this.record(sessionId, "worker.start.requested", "startup", "starting");
			else if (current.startupFailed) this.record(sessionId, "worker.start.failed", "startup_failure", "failed");
			if (current.recoveryPending) this.record(sessionId, "worker.recovery.started", "process_exit", current.state);
			this.recordActivePauses(sessionId, current);
			return;
		}

		if (!previous.recoveryPending && current.recoveryPending)
			this.record(sessionId, "worker.recovery.started", "process_exit", current.state);
		else if (previous.recoveryPending && !current.recoveryPending)
			this.record(
				sessionId,
				current.state === "failed" ? "worker.recovery.failed" : "worker.recovery.completed",
				current.state === "failed" ? "process_exit" : "recovery_backoff",
				current.state === "failed" ? "failed" : "completed",
			);

		if (previous.state !== current.state) {
			if (current.state === "starting") this.record(sessionId, "worker.start.requested", "startup", "starting");
			else if (previous.state === "starting")
				this.record(
					sessionId,
					current.state === "failed" ? "worker.start.failed" : "worker.started",
					current.state === "failed" ? "startup_failure" : "startup",
					current.state,
				);
			else if (current.state === "parked") this.record(sessionId, "worker.parked", pauseReason(current), "parked");
		}

		if (!previous.working && current.working) this.record(sessionId, "execution.started", "work", "working");
		else if (previous.working && !current.working && current.state !== "failed")
			this.record(sessionId, "execution.completed", pauseReason(current), "completed");

		this.recordPauseChange(sessionId, previous.sleepPaused, current.sleepPaused, "sleep");
		this.recordPauseChange(sessionId, previous.updatePaused, current.updatePaused, "update");
		this.recordPauseChange(sessionId, previous.recoveryStopped, current.recoveryStopped, "user");
		if (previous.quotaPaused !== current.quotaPaused)
			this.record(sessionId, "quota.changed", "quota", current.quotaPaused ? "paused" : "resumed");
		if (previous.offlinePaused !== current.offlinePaused)
			this.record(sessionId, "connectivity.changed", "connectivity", current.offlinePaused ? "paused" : "resumed");
	}

	private recordActivePauses(sessionId: string, current: LifecycleObservation): void {
		if (current.sleepPaused) this.record(sessionId, "pause.changed", "sleep", "paused");
		if (current.updatePaused) this.record(sessionId, "pause.changed", "update", "paused");
		if (current.recoveryStopped) this.record(sessionId, "pause.changed", "user", "paused");
		if (current.quotaPaused) this.record(sessionId, "quota.changed", "quota", "paused");
		if (current.offlinePaused) this.record(sessionId, "connectivity.changed", "connectivity", "paused");
	}

	private recordPauseChange(
		sessionId: string,
		previous: boolean,
		current: boolean,
		reason: "sleep" | "update" | "user",
	): void {
		if (previous !== current) this.record(sessionId, "pause.changed", reason, current ? "paused" : "resumed");
	}

	private record(sessionId: string, kind: LifecycleKind, reason: LifecycleReason, state: LifecycleEventState): void {
		if (this.disabled.has(sessionId)) return;
		const pending = this.pendingBySession.get(sessionId) ?? 0;
		if (pending >= this.maxPendingPerSession || this.pending.length >= MAX_PENDING_TOTAL) {
			this.droppedBySession.set(sessionId, (this.droppedBySession.get(sessionId) ?? 0) + 1);
			return;
		}
		const droppedBefore = this.droppedBySession.get(sessionId) ?? 0;
		const line = lifecycleLine({
			v: LIFECYCLE_SCHEMA_VERSION,
			id: `${this.boot}-${this.sequence++}`,
			at: this.now().toISOString(),
			source: "daemon",
			release: this.release,
			hostKind: this.hostKind,
			kind,
			reason,
			state,
			...(droppedBefore ? { droppedBefore } : {}),
		});
		if (!line) return;
		this.droppedBySession.delete(sessionId);
		this.pending.push({ sessionId, line });
		this.pendingBySession.set(sessionId, pending + 1);
		this.schedule();
	}

	private schedule(): void {
		if (this.writing) return;
		this.writing = Promise.resolve()
			.then(async () => {
				while (this.pending.length) {
					const entry = this.pending.shift()!;
					this.pendingBySession.set(entry.sessionId, (this.pendingBySession.get(entry.sessionId) ?? 1) - 1);
					if (this.disabled.has(entry.sessionId)) continue;
					try {
						await this.write(entry);
					} catch {
						this.disabled.add(entry.sessionId);
						for (let index = this.pending.length - 1; index >= 0; index--) {
							if (this.pending[index]!.sessionId !== entry.sessionId) continue;
							this.pending.splice(index, 1);
						}
						this.pendingBySession.delete(entry.sessionId);
					}
				}
			})
			.finally(() => {
				this.writing = undefined;
				if (this.pending.length) this.schedule();
			});
	}

	private async write(entry: PendingLine): Promise<void> {
		const file = join(this.home, "sessions", entry.sessionId, LIFECYCLE_FILE);
		let handle = await open(
			file,
			constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			0o600,
		);
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) throw new Error("Invalid lifecycle log");
			await handle.chmod(0o600);
			if (stat.size + Buffer.byteLength(entry.line) > this.maxBytes) {
				await handle.close();
				await rename(file, `${file}.1`);
				handle = await open(
					file,
					constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
					0o600,
				);
			}
			await handle.writeFile(entry.line);
		} finally {
			await handle.close().catch(() => undefined);
		}
	}

	async flush(): Promise<void> {
		while (this.writing) await this.writing;
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.flush();
	}
}

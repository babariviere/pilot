/** Bounded, content-free tool lifecycle evidence. Raw tool names, IDs, arguments and results never leave this file. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
	ToolActivityCall,
	ToolActivityOutcome,
	ToolActivitySnapshot,
	ToolDiagnosticCategory,
	ToolWaitKind,
} from "@pilot/protocol";
import { nodeTelemetry, type TraceCarrier } from "@pilot/telemetry";
import { SHELL_STATUS_DETAIL } from "./shell-deadline.ts";

export const TOOL_ACTIVITY_FILE = "tool-activity.jsonl";
export const MAX_TOOL_ACTIVITY_FILE_BYTES = 256 * 1024;
export const MAX_ACTIVE_TOOL_CALLS = 32;
const MAX_LINE_BYTES = 1024;
const MAX_PENDING = 64;
const HEARTBEAT_MS = 15_000;
const PUBLISH_INTERVAL_MS = 250;
const PERSIST_PROGRESS_MS = 5_000;
const MAX_DURATION_MS = 604_800_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const REF = /^[0-9a-f]{12}-[1-9][0-9]{0,8}$/;

export type ToolActivityRecord =
	| {
			v: 1;
			kind: "started";
			ref: string;
			at: number;
			category: ToolDiagnosticCategory;
			nested: boolean;
			droppedBefore?: number;
	  }
	| {
			v: 1;
			kind: "progress";
			ref: string;
			at: number;
			droppedBefore?: number;
	  }
	| {
			v: 1;
			kind: "cancel_requested";
			ref: string;
			at: number;
			cancelOutcome: "cancelled" | "timeout";
			droppedBefore?: number;
	  }
	| {
			v: 1;
			kind: "finished";
			ref: string;
			at: number;
			startedAt: number;
			category: ToolDiagnosticCategory;
			nested: boolean;
			outcome: ToolActivityOutcome;
			durationMs: number;
			dispatchMs?: number;
			executionMs?: number;
			cancellationWaitMs?: number;
			droppedBefore?: number;
	  };

const CATEGORIES = new Set<ToolDiagnosticCategory>([
	"shell",
	"filesystem",
	"network",
	"background",
	"codemode",
	"mcp",
	"orchestration",
	"other",
]);
const OUTCOMES = new Set<ToolActivityOutcome>(["success", "failure", "timeout", "cancelled", "interrupted"]);

function finite(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

/** A closed mapping. Extension and remote MCP names collapse to `other` or `mcp`. */
export function toolCategory(name: string): ToolDiagnosticCategory {
	if (/^mcp__[A-Za-z0-9_]+__/.test(name)) return "mcp";
	if (name === "bash" || name === "powershell") return "shell";
	if (["read", "write", "edit", "grep", "find", "ls", "apply_patch"].includes(name)) return "filesystem";
	if (["web", "browser"].includes(name)) return "network";
	if (name === "jobs") return "background";
	if (name === "codemode") return "codemode";
	if (["artifact", "subagent", "mission", "memory", "question", "todo", "db", "slack_status"].includes(name))
		return "orchestration";
	return "other";
}

/** Only explicit host-owned wait tools get a wait classification. Unknown names stay unclassified. */
export function toolWaitKind(name: string): ToolWaitKind | undefined {
	if (name === "jobs") return "background";
	if (name === "question" || name === "ask_user") return "user";
	if (name === "subagent") return "child";
	return undefined;
}

/** Strictly copy the reviewed fields. Unknown runtime fields can never reach disk. */
export function toolActivityLine(value: ToolActivityRecord): string | undefined {
	if (
		value?.v !== 1 ||
		!REF.test(value.ref) ||
		!finite(value.at, MAX_DATE_MS) ||
		(value.droppedBefore !== undefined && !finite(value.droppedBefore))
	)
		return;
	let safe: ToolActivityRecord;
	if (value.kind === "started") {
		if (!CATEGORIES.has(value.category) || typeof value.nested !== "boolean") return;
		safe = {
			v: 1,
			kind: "started",
			ref: value.ref,
			at: Math.floor(value.at),
			category: value.category,
			nested: value.nested,
			...(value.droppedBefore ? { droppedBefore: Math.floor(value.droppedBefore) } : {}),
		};
	} else if (value.kind === "progress") {
		safe = {
			v: 1,
			kind: "progress",
			ref: value.ref,
			at: Math.floor(value.at),
			...(value.droppedBefore ? { droppedBefore: Math.floor(value.droppedBefore) } : {}),
		};
	} else if (value.kind === "cancel_requested") {
		if (value.cancelOutcome !== "cancelled" && value.cancelOutcome !== "timeout") return;
		safe = {
			v: 1,
			kind: "cancel_requested",
			ref: value.ref,
			at: Math.floor(value.at),
			cancelOutcome: value.cancelOutcome,
			...(value.droppedBefore ? { droppedBefore: Math.floor(value.droppedBefore) } : {}),
		};
	} else if (value.kind === "finished") {
		if (
			!finite(value.startedAt, MAX_DATE_MS) ||
			!CATEGORIES.has(value.category) ||
			typeof value.nested !== "boolean" ||
			!OUTCOMES.has(value.outcome) ||
			!finite(value.durationMs, MAX_DURATION_MS) ||
			(value.dispatchMs !== undefined && !finite(value.dispatchMs, MAX_DURATION_MS)) ||
			(value.executionMs !== undefined && !finite(value.executionMs, MAX_DURATION_MS)) ||
			(value.cancellationWaitMs !== undefined && !finite(value.cancellationWaitMs, MAX_DURATION_MS))
		)
			return;
		safe = {
			v: 1,
			kind: "finished",
			ref: value.ref,
			at: Math.floor(value.at),
			startedAt: Math.floor(value.startedAt),
			category: value.category,
			nested: value.nested,
			outcome: value.outcome,
			durationMs: Math.round(value.durationMs * 100) / 100,
			...(value.dispatchMs === undefined ? {} : { dispatchMs: Math.round(value.dispatchMs * 100) / 100 }),
			...(value.executionMs === undefined ? {} : { executionMs: Math.round(value.executionMs * 100) / 100 }),
			...(value.cancellationWaitMs === undefined
				? {}
				: { cancellationWaitMs: Math.round(value.cancellationWaitMs * 100) / 100 }),
			...(value.droppedBefore ? { droppedBefore: Math.floor(value.droppedBefore) } : {}),
		};
	} else {
		return;
	}
	const line = `${JSON.stringify(safe)}\n`;
	return Buffer.byteLength(line) <= MAX_LINE_BYTES ? line : undefined;
}

export function parseToolActivityRecord(value: unknown): ToolActivityRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const line = toolActivityLine(value as ToolActivityRecord);
	return line ? (JSON.parse(line) as ToolActivityRecord) : undefined;
}

class ToolActivityLog {
	private readonly queue: string[] = [];
	private writing?: Promise<void>;
	private closed = false;
	private disabled = false;
	private dropped = 0;
	private readonly file: string;
	private readonly maxBytes: number;
	private readonly maxPending: number;

	constructor(file: string, maxBytes = MAX_TOOL_ACTIVITY_FILE_BYTES, maxPending = MAX_PENDING) {
		this.file = file;
		this.maxBytes = maxBytes;
		this.maxPending = maxPending;
	}

	record(record: ToolActivityRecord): void {
		if (this.closed || this.disabled) return;
		if (this.queue.length >= this.maxPending) {
			this.dropped++;
			return;
		}
		try {
			const withDropped = this.dropped ? { ...record, droppedBefore: this.dropped } : record;
			const line = toolActivityLine(withDropped as ToolActivityRecord);
			if (!line) return;
			this.dropped = 0;
			this.queue.push(line);
			this.schedule();
		} catch {
			// Evidence cannot change the observed tool.
		}
	}

	private schedule(): void {
		if (this.writing) return;
		this.writing = Promise.resolve()
			.then(async () => {
				while (this.queue.length) {
					const line = this.queue.shift()!;
					let handle = await open(
						this.file,
						constants.O_CREAT |
							constants.O_APPEND |
							constants.O_WRONLY |
							constants.O_NOFOLLOW |
							constants.O_NONBLOCK,
						0o600,
					);
					try {
						const stat = await handle.stat();
						if (!stat.isFile()) throw new Error("Invalid tool activity log");
						await handle.chmod(0o600);
						if (stat.size + Buffer.byteLength(line) > this.maxBytes) {
							await handle.close();
							await rename(this.file, `${this.file}.1`);
							handle = await open(
								this.file,
								constants.O_CREAT |
									constants.O_EXCL |
									constants.O_WRONLY |
									constants.O_NOFOLLOW |
									constants.O_NONBLOCK,
								0o600,
							);
						}
						await handle.writeFile(line);
					} finally {
						await handle.close();
					}
				}
			})
			.catch(() => {
				this.disabled = true;
				this.queue.length = 0;
			})
			.finally(() => {
				this.writing = undefined;
				if (this.queue.length) this.schedule();
			});
	}

	async flush(): Promise<void> {
		while (this.writing) await this.writing;
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.flush();
	}
}

interface ActiveCall extends ToolActivityCall {
	rawId: string;
	startedMonotonic: number;
	lastPersistedProgress: number;
	cancelOutcome?: "cancelled" | "timeout";
	parent?: TraceCarrier;
	signal?: AbortSignal;
	abort?: () => void;
}

export interface ToolActivityTrackerOptions {
	file: string;
	publish(snapshot: ToolActivitySnapshot): void;
	parent?(): TraceCarrier | undefined;
	wallNow?: () => number;
	monotonicNow?: () => number;
	heartbeatMs?: number;
	maxActive?: number;
	maxBytes?: number;
	maxPending?: number;
}

let collectionEnabled = true;
const trackers = new Set<ToolActivityTracker>();

export function setToolActivityCollectionEnabled(enabled: boolean): void {
	collectionEnabled = enabled;
	for (const tracker of trackers) tracker.collectionChanged();
}

export async function prepareToolActivityClear(): Promise<void> {
	collectionEnabled = false;
	for (const tracker of trackers) tracker.collectionChanged();
	await Promise.all([...trackers].map((tracker) => tracker.flush()));
}

export class ToolActivityTracker {
	private readonly calls = new Map<string, ActiveCall>();
	private readonly log: ToolActivityLog;
	private readonly boot = randomUUID().replaceAll("-", "").slice(0, 12);
	private sequence = 0;
	private dropped = 0;
	private heartbeat?: ReturnType<typeof setInterval>;
	private publishTimer?: ReturnType<typeof setTimeout>;
	private closed = false;
	private readonly wallNow: () => number;
	private readonly monotonicNow: () => number;
	private readonly heartbeatMs: number;
	private readonly maxActive: number;
	private readonly options: ToolActivityTrackerOptions;

	constructor(options: ToolActivityTrackerOptions) {
		this.options = options;
		this.wallNow = options.wallNow ?? Date.now;
		this.monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
		this.heartbeatMs = Math.max(1_000, options.heartbeatMs ?? HEARTBEAT_MS);
		this.maxActive = Math.max(1, Math.min(MAX_ACTIVE_TOOL_CALLS, options.maxActive ?? MAX_ACTIVE_TOOL_CALLS));
		this.log = new ToolActivityLog(options.file, options.maxBytes, options.maxPending);
		trackers.add(this);
	}

	start(rawId: string, name: string, nested: boolean, signal?: AbortSignal): void {
		if (this.closed || this.calls.has(rawId)) return;
		if (this.calls.size >= this.maxActive) {
			this.dropped++;
			this.publish(true);
			return;
		}
		const now = this.wallNow();
		const parent = this.options.parent?.();
		const waitKind = toolWaitKind(name);
		const call: ActiveCall = {
			rawId,
			ref: `${this.boot}-${++this.sequence}`,
			category: toolCategory(name),
			nested,
			...(waitKind ? { waitKind } : {}),
			state: "dispatching",
			startedAt: now,
			progressAt: now,
			livenessAt: now,
			startedMonotonic: this.monotonicNow(),
			lastPersistedProgress: now,
			...(parent ? { parent } : {}),
			...(signal ? { signal } : {}),
		};
		if (signal) {
			call.abort = () => this.cancel(rawId, abortOutcome(signal));
			signal.addEventListener("abort", call.abort, { once: true });
		}
		this.calls.set(rawId, call);
		this.record({ v: 1, kind: "started", ref: call.ref, at: now, category: call.category, nested });
		if (signal?.aborted) call.abort?.();
		this.ensureHeartbeat();
		this.publish(true);
	}

	running(rawId: string): void {
		const call = this.calls.get(rawId);
		if (!call || call.state === "cancelling") return;
		call.state = "running";
		call.livenessAt = this.wallNow();
		this.publish(true);
	}

	progress(rawId: string): void {
		const call = this.calls.get(rawId);
		if (!call) return;
		const now = this.wallNow();
		call.progressAt = now;
		call.livenessAt = now;
		if (call.state === "dispatching") call.state = "running";
		if (collectionEnabled && now - call.lastPersistedProgress >= PERSIST_PROGRESS_MS) {
			call.lastPersistedProgress = now;
			this.log.record({ v: 1, kind: "progress", ref: call.ref, at: now });
		}
		this.publish(false);
	}

	cancel(rawId: string, outcome: "cancelled" | "timeout" = "cancelled"): void {
		const call = this.calls.get(rawId);
		if (!call || call.cancelRequestedAt !== undefined) return;
		const now = this.wallNow();
		call.cancelRequestedAt = now;
		call.cancelOutcome = outcome;
		call.state = "cancelling";
		call.livenessAt = now;
		this.record({ v: 1, kind: "cancel_requested", ref: call.ref, at: now, cancelOutcome: outcome });
		this.publish(true);
	}

	finish(rawId: string, isError: boolean, executionMs?: number): void {
		const call = this.calls.get(rawId);
		if (!call) return;
		const outcome: ToolActivityOutcome = isError ? (call.cancelOutcome ?? "failure") : "success";
		this.complete(call, outcome, executionMs);
	}

	snapshot(): ToolActivitySnapshot {
		if (!collectionEnabled)
			return { enabled: false, observedAt: this.wallNow(), calls: [], dropped: this.dropped + this.calls.size };
		return {
			enabled: true,
			observedAt: this.wallNow(),
			calls: [...this.calls.values()].map(
				({
					rawId: _rawId,
					startedMonotonic: _started,
					lastPersistedProgress: _last,
					cancelOutcome: _cancel,
					parent: _parent,
					signal: _signal,
					abort: _abort,
					...call
				}) => ({ ...call }),
			),
			dropped: this.dropped,
		};
	}

	collectionChanged(): void {
		this.publish(true);
	}

	private complete(call: ActiveCall, outcome: ToolActivityOutcome, executionMs?: number): void {
		const at = this.wallNow();
		const durationMs = Math.min(MAX_DURATION_MS, Math.max(0, this.monotonicNow() - call.startedMonotonic));
		const reportedExecution = finite(executionMs, MAX_DURATION_MS) ? Math.min(durationMs, executionMs) : undefined;
		// Pi omits execution time when validation or an earlier tool_call handler ends a call before dispatch.
		const safeExecution = reportedExecution ?? (call.state === "dispatching" ? 0 : undefined);
		const dispatchMs = safeExecution === undefined ? undefined : Math.max(0, durationMs - safeExecution);
		const cancellationWaitMs =
			call.cancelRequestedAt === undefined
				? undefined
				: Math.min(MAX_DURATION_MS, Math.max(0, at - call.cancelRequestedAt));
		const record: ToolActivityRecord = {
			v: 1,
			kind: "finished",
			ref: call.ref,
			at,
			startedAt: call.startedAt,
			category: call.category,
			nested: call.nested,
			outcome,
			durationMs,
			...(dispatchMs === undefined ? {} : { dispatchMs }),
			...(safeExecution === undefined ? {} : { executionMs: safeExecution }),
			...(cancellationWaitMs === undefined ? {} : { cancellationWaitMs }),
		};
		this.record(record);
		const exportedOutcome = outcome === "success" ? "success" : outcome;
		nodeTelemetry().recordSpan(
			"pilot.tool.call",
			durationMs,
			{
				"pilot.operation": "tool.call",
				"pilot.outcome": exportedOutcome,
				"pilot.tool.category": call.category,
				"pilot.tool.nested": call.nested,
				...(dispatchMs === undefined ? {} : { "pilot.tool.dispatch_ms": dispatchMs }),
				...(safeExecution === undefined ? {} : { "pilot.tool.execution_ms": safeExecution }),
			},
			{ ...(call.parent ? { parent: call.parent } : {}), endTime: new Date(at) },
		);
		if (cancellationWaitMs !== undefined)
			nodeTelemetry().recordSpan(
				"pilot.tool.cancel_wait",
				cancellationWaitMs,
				{
					"pilot.operation": "tool.cancel_wait",
					"pilot.outcome": call.cancelOutcome ?? "cancelled",
					"pilot.tool.category": call.category,
					"pilot.tool.nested": call.nested,
				},
				{ ...(call.parent ? { parent: call.parent } : {}), endTime: new Date(at) },
			);
		if (call.signal && call.abort) call.signal.removeEventListener("abort", call.abort);
		this.calls.delete(call.rawId);
		if (!this.calls.size) this.stopTimers();
		this.publish(true);
	}

	private record(record: ToolActivityRecord): void {
		if (collectionEnabled) this.log.record(record);
	}

	private publish(immediate: boolean): void {
		if (this.closed) return;
		if (immediate) {
			clearTimeout(this.publishTimer);
			this.publishTimer = undefined;
			this.emitSnapshot();
			return;
		}
		if (this.publishTimer) return;
		this.publishTimer = setTimeout(() => {
			this.publishTimer = undefined;
			this.emitSnapshot();
		}, PUBLISH_INTERVAL_MS);
		this.publishTimer.unref();
	}

	private emitSnapshot(): void {
		try {
			this.options.publish(this.snapshot());
		} catch {
			// Observation cannot affect tool execution.
		}
	}

	private ensureHeartbeat(): void {
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => {
			const now = this.wallNow();
			for (const call of this.calls.values()) call.livenessAt = now;
			this.publish(true);
		}, this.heartbeatMs);
		this.heartbeat.unref();
	}

	private stopTimers(): void {
		clearInterval(this.heartbeat);
		clearTimeout(this.publishTimer);
		this.heartbeat = undefined;
		this.publishTimer = undefined;
	}

	async flush(): Promise<void> {
		await this.log.flush();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		for (const call of [...this.calls.values()]) this.complete(call, "interrupted");
		this.closed = true;
		this.stopTimers();
		try {
			this.options.publish({
				enabled: collectionEnabled,
				observedAt: this.wallNow(),
				calls: [],
				dropped: this.dropped,
			});
		} catch {
			// Best effort only.
		}
		await this.log.close();
		trackers.delete(this);
	}
}

function abortOutcome(signal: AbortSignal): "cancelled" | "timeout" {
	const reason = signal.reason;
	return reason instanceof Error && reason.name === "TimeoutError" ? "timeout" : "cancelled";
}

/** Uses Pi's public lifecycle events, including nested codemode calls. */
export function toolActivityExtension(tracker: ToolActivityTracker): ExtensionFactory {
	return (pi) => {
		pi.on("tool_execution_start", (event, context) => {
			tracker.start(event.toolCallId, event.toolName, event.parentToolCallId !== undefined, context.signal);
		});
		pi.on("tool_call", (event) => {
			tracker.running(event.toolCallId);
		});
		pi.on("tool_execution_update", (event) => {
			// A scheduled elapsed-time notice is liveness, not evidence of command output/progress.
			if ((event.partialResult?.details as Record<string, unknown> | undefined)?.[SHELL_STATUS_DETAIL] === true)
				return;
			tracker.progress(event.toolCallId);
		});
		pi.on("tool_execution_end", (event) => {
			tracker.finish(event.toolCallId, event.isError, event.durationMs);
		});
	};
}

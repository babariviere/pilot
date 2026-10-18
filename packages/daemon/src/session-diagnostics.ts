/** Bounded, read-only diagnostic projection. Files are tailed without opening session databases or workers. */
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import {
	MAX_TOOL_ACTIVITY_FILE_BYTES,
	parseControlPreparationRecord,
	parseToolActivityRecord,
	TOOL_ACTIVITY_FILE,
	type ToolActivityRecord,
} from "@pilot/kernel";
import type {
	ControlPreparationDiagnosticEvidence,
	DiagnosticEvidence,
	DiagnosticFreshness,
	DiagnosticSourceStatus,
	NativeDiagnosticsBatch,
	OperationHost,
	RequestTimingDiagnosticEvidence,
	SessionDiagnosticCurrent,
	SessionDiagnostics,
	ToolActivitySnapshot,
	ToolCallDiagnosticEvidence,
	ToolDiagnosticCategory,
	ToolInFlightDiagnosticEvidence,
} from "@pilot/protocol";
import release from "../../../package.json" with { type: "json" };
import type { DaemonPerformance } from "./event-loop-watchdog.ts";
import { LIFECYCLE_FILE, MAX_LIFECYCLE_FILE_BYTES, parseLifecycleDiagnostic } from "./lifecycle-diagnostics.ts";
import { MAX_NATIVE_DIAGNOSTIC_BYTES, parseNativeDiagnostics } from "./native-diagnostics.ts";
import { assessToolCall } from "./tool-stalls.ts";

export const MAX_DIAGNOSTIC_ITEMS = 128;
export const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_TIMING_ITEMS = 32;
const MAX_LIFECYCLE_ITEMS = 96;
const MAX_TOOL_ITEMS = 64;
const SOURCE_STALE_MS = 30_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const PERFORMANCE_FILE = "performance.jsonl";
const MAX_PERFORMANCE_FILE_BYTES = 256 * 1024;

interface TailResult {
	lines: string[];
	truncated: boolean;
	available: boolean;
}

interface SourceRead<T> {
	items: T[];
	available: number;
	invalid: number;
	dropped: number;
	truncated: boolean;
	newestAt?: string;
}

export interface SessionDiagnosticInput {
	host: OperationHost;
	sessionId: string;
	storageDir: string;
	current: SessionDiagnosticCurrent;
	connectivity: SessionDiagnostics["connectivity"];
	performance?: DaemonPerformance;
	ai?: SessionDiagnostics["ai"];
	aiBudget?: SessionDiagnostics["aiBudget"];
	toolActivity?: ToolActivitySnapshot;
	nativeDiagnosticsPath?: string;
	limit?: number;
	now?: number;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function timestamp(value: unknown): value is number {
	return finite(value) && value <= MAX_DATE_MS;
}

/** Read at most maxBytes from a regular, non-symlink file. Oversized files expose only their tail. */
async function tail(path: string, maxBytes: number): Promise<TailResult> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = await handle.stat();
		if (!stat.isFile()) return { lines: [], truncated: false, available: false };
		const length = Math.min(stat.size, maxBytes);
		const start = Math.max(0, stat.size - length);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		let text = buffer.subarray(0, bytesRead).toString("utf8");
		if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
		return { lines: text.split("\n").filter(Boolean), truncated: start > 0, available: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], truncated: false, available: false };
		return { lines: [], truncated: false, available: false };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function segments(path: string, maxBytes: number): Promise<TailResult> {
	const [rotated, current] = await Promise.all([tail(`${path}.1`, maxBytes), tail(path, maxBytes)]);
	return {
		lines: [...rotated.lines, ...current.lines],
		truncated: rotated.truncated || current.truncated,
		available: rotated.available || current.available,
	};
}

function sourceStatus(
	source: DiagnosticSourceStatus["source"],
	read: SourceRead<unknown>,
	now: number,
): DiagnosticSourceStatus {
	let freshness: DiagnosticFreshness = "unavailable";
	if (read.newestAt) freshness = now - Date.parse(read.newestAt) <= SOURCE_STALE_MS ? "fresh" : "stale";
	return {
		source,
		freshness,
		...(read.newestAt ? { observedAt: read.newestAt } : {}),
		available: read.available,
		invalid: read.invalid,
		truncated: read.truncated,
	};
}

async function lifecycle(storageDir: string): Promise<SourceRead<DiagnosticEvidence>> {
	const data = await segments(join(storageDir, LIFECYCLE_FILE), MAX_LIFECYCLE_FILE_BYTES);
	const items: DiagnosticEvidence[] = [];
	let invalid = 0;
	let dropped = 0;
	for (const line of data.lines) {
		try {
			const event = parseLifecycleDiagnostic(JSON.parse(line));
			if (!event) {
				invalid++;
				continue;
			}
			dropped += event.droppedBefore ?? 0;
			items.push({
				ref: `diagnostic:v1:lifecycle:${event.id}`,
				source: "lifecycle",
				at: event.at,
				kind: event.kind,
				reason: event.reason,
				state: event.state,
				...(event.droppedBefore ? { droppedBefore: event.droppedBefore } : {}),
			});
		} catch {
			invalid++;
		}
	}
	const available = items.length;
	const newestAt = items.at(-1)?.at;
	if (items.length > MAX_LIFECYCLE_ITEMS) items.splice(0, items.length - MAX_LIFECYCLE_ITEMS);
	return {
		items,
		available,
		invalid,
		dropped,
		truncated: data.truncated || items.length < available,
		...(newestAt ? { newestAt } : {}),
	};
}

const TIMING_OPTIONALS = [
	"toolToPreparationMs",
	"payloadReadyMs",
	"httpDispatchMs",
	"responseHeadersMs",
	"firstProviderEventMs",
	"firstContentMs",
	"firstThinkingMs",
	"firstTextMs",
	"firstToolCallMs",
] as const;

function timing(value: unknown): RequestTimingDiagnosticEvidence | ControlPreparationDiagnosticEvidence | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	if (record.source === "control_preparation") {
		const event = parseControlPreparationRecord(record);
		if (!event) return;
		return {
			ref: event.attemptRef,
			source: "request_timing",
			at: new Date(event.at).toISOString(),
			kind: "control.request.preparation",
			attemptRef: event.attemptRef,
			stage: event.stage,
			outcome: event.outcome,
			durationMs: event.durationMs,
			...(event.reason ? { reason: event.reason } : {}),
			...(event.droppedBefore ? { droppedBefore: event.droppedBefore } : {}),
		};
	}
	if (
		record.v !== 1 ||
		(record.source !== "generation" && record.source !== "stream") ||
		(record.outcome !== "completed" && record.outcome !== "error" && record.outcome !== "aborted") ||
		!finite(record.request) ||
		!finite(record.at) ||
		!finite(record.preparationMs) ||
		!finite(record.providerMs) ||
		!finite(record.totalMs) ||
		!finite(record.httpAttempts) ||
		!TIMING_OPTIONALS.every((key) => record[key] === undefined || finite(record[key])) ||
		(record.droppedBefore !== undefined && !finite(record.droppedBefore))
	)
		return;
	const at = new Date(record.at).toISOString();
	const optional = Object.fromEntries(
		TIMING_OPTIONALS.filter((key) => record[key] !== undefined).map((key) => [key, record[key] as number]),
	) as Pick<RequestTimingDiagnosticEvidence, (typeof TIMING_OPTIONALS)[number]>;
	return {
		ref: `diagnostic:v1:request:${record.at}:${record.request}`,
		source: "request_timing",
		at,
		kind: "model.request",
		outcome: record.outcome,
		requestSource: record.source,
		preparationMs: record.preparationMs,
		providerMs: record.providerMs,
		totalMs: record.totalMs,
		httpAttempts: record.httpAttempts,
		...optional,
		...(finite(record.droppedBefore) && record.droppedBefore > 0
			? { droppedBefore: Math.floor(record.droppedBefore) }
			: {}),
	};
}

async function timings(storageDir: string): Promise<SourceRead<DiagnosticEvidence>> {
	const data = await segments(join(storageDir, PERFORMANCE_FILE), MAX_PERFORMANCE_FILE_BYTES);
	const items: DiagnosticEvidence[] = [];
	let invalid = 0;
	let dropped = 0;
	for (const line of data.lines) {
		try {
			const item = timing(JSON.parse(line));
			if (!item) {
				invalid++;
				continue;
			}
			dropped += item.droppedBefore ?? 0;
			items.push(item);
		} catch {
			invalid++;
		}
	}
	const available = items.length;
	const newestAt = items.at(-1)?.at;
	if (items.length > MAX_TIMING_ITEMS) items.splice(0, items.length - MAX_TIMING_ITEMS);
	return {
		items,
		available,
		invalid,
		dropped,
		truncated: data.truncated || items.length < available,
		...(newestAt ? { newestAt } : {}),
	};
}

const TOOL_CATEGORIES = new Set<ToolDiagnosticCategory>([
	"shell",
	"filesystem",
	"network",
	"background",
	"codemode",
	"mcp",
	"orchestration",
	"other",
]);
const TOOL_STATES = new Set(["dispatching", "running", "cancelling"]);
const TOOL_WAIT_KINDS = new Set(["user", "background", "child"]);
const TOOL_REF = /^[0-9a-f]{12}-[1-9][0-9]{0,8}$/;

interface OpenToolRecord {
	start: Extract<ToolActivityRecord, { kind: "started" }>;
	lastAt: number;
	cancelAt?: number;
}

function completedTool(record: Extract<ToolActivityRecord, { kind: "finished" }>): ToolCallDiagnosticEvidence {
	return {
		ref: `diagnostic:v1:tool:${record.ref}`,
		source: "tool",
		at: new Date(record.at).toISOString(),
		kind: "tool.call",
		category: record.category,
		nested: record.nested,
		outcome: record.outcome,
		durationMs: record.durationMs,
		...(record.dispatchMs === undefined ? {} : { dispatchMs: record.dispatchMs }),
		...(record.executionMs === undefined ? {} : { executionMs: record.executionMs }),
		...(record.cancellationWaitMs === undefined ? {} : { cancellationWaitMs: record.cancellationWaitMs }),
		...(record.droppedBefore ? { droppedBefore: record.droppedBefore } : {}),
	};
}

function liveTools(
	snapshot: ToolActivitySnapshot | undefined,
	current: SessionDiagnosticCurrent,
	now: number,
): SourceRead<DiagnosticEvidence> {
	if (
		!snapshot ||
		typeof snapshot.enabled !== "boolean" ||
		!timestamp(snapshot.observedAt) ||
		!Array.isArray(snapshot.calls) ||
		!finite(snapshot.dropped)
	)
		return { items: [], available: 0, invalid: snapshot ? 1 : 0, dropped: 0, truncated: false };
	if (!snapshot.enabled) return { items: [], available: 0, invalid: 0, dropped: 0, truncated: false };
	const items: ToolInFlightDiagnosticEvidence[] = [];
	let invalid = 0;
	for (const call of snapshot.calls.slice(0, 32)) {
		if (
			!call ||
			!TOOL_REF.test(call.ref) ||
			!TOOL_CATEGORIES.has(call.category) ||
			typeof call.nested !== "boolean" ||
			(call.waitKind !== undefined && !TOOL_WAIT_KINDS.has(call.waitKind)) ||
			!TOOL_STATES.has(call.state) ||
			!timestamp(call.startedAt) ||
			!timestamp(call.progressAt) ||
			!timestamp(call.livenessAt) ||
			(call.cancelRequestedAt !== undefined && !timestamp(call.cancelRequestedAt))
		) {
			invalid++;
			continue;
		}
		const assessment = assessToolCall(
			call,
			snapshot.observedAt,
			{ pauses: current.pauses, runningJobs: current.queue.runningJobs },
			now,
		);
		items.push({
			ref: `diagnostic:v1:tool:${call.ref}`,
			source: "tool",
			at: new Date(snapshot.observedAt).toISOString(),
			kind: "tool.in_flight",
			category: call.category,
			nested: call.nested,
			...(call.waitKind ? { waitKind: call.waitKind } : {}),
			state: call.state,
			assessment: assessment.assessment,
			...(assessment.thresholdMs === undefined ? {} : { thresholdMs: assessment.thresholdMs }),
			durationMs: Math.max(0, now - call.startedAt),
			progressAgeMs: Math.max(0, now - call.progressAt),
			livenessAgeMs: Math.max(0, now - call.livenessAt),
			...(call.cancelRequestedAt === undefined
				? {}
				: { cancellationWaitMs: Math.max(0, now - call.cancelRequestedAt) }),
		});
	}
	return {
		items,
		available: snapshot.calls.length,
		invalid: invalid + Math.max(0, snapshot.calls.length - 32),
		dropped: Math.floor(snapshot.dropped),
		truncated: snapshot.calls.length > 32 || snapshot.dropped > 0,
		newestAt: new Date(snapshot.observedAt).toISOString(),
	};
}

async function tools(
	storageDir: string,
	snapshot: ToolActivitySnapshot | undefined,
	current: SessionDiagnosticCurrent,
	now: number,
): Promise<SourceRead<DiagnosticEvidence>> {
	const data = await segments(join(storageDir, TOOL_ACTIVITY_FILE), MAX_TOOL_ACTIVITY_FILE_BYTES);
	const activeRefs = new Set(snapshot?.enabled ? snapshot.calls.map((call) => call.ref) : []);
	const liveObservationDisabled = snapshot?.enabled === false;
	const openCalls = new Map<string, OpenToolRecord>();
	const items: ToolCallDiagnosticEvidence[] = [];
	let invalid = 0;
	let dropped = 0;
	for (const line of data.lines) {
		try {
			const record = parseToolActivityRecord(JSON.parse(line));
			if (!record) {
				invalid++;
				continue;
			}
			dropped += record.droppedBefore ?? 0;
			if (record.kind === "started") {
				openCalls.set(record.ref, { start: record, lastAt: record.at });
			} else if (record.kind === "progress" || record.kind === "cancel_requested") {
				const active = openCalls.get(record.ref);
				if (active) {
					active.lastAt = Math.max(active.lastAt, record.at);
					if (record.kind === "cancel_requested") active.cancelAt = record.at;
				}
			} else {
				openCalls.delete(record.ref);
				items.push(completedTool(record));
			}
		} catch {
			invalid++;
		}
	}
	for (const [ref, active] of openCalls) {
		if (activeRefs.has(ref) || liveObservationDisabled) continue;
		items.push({
			ref: `diagnostic:v1:tool:${ref}`,
			source: "tool",
			at: new Date(active.lastAt).toISOString(),
			kind: "tool.call",
			category: active.start.category,
			nested: active.start.nested,
			outcome: "interrupted",
			durationMs: Math.max(0, active.lastAt - active.start.at),
			...(active.cancelAt === undefined ? {} : { cancellationWaitMs: Math.max(0, active.lastAt - active.cancelAt) }),
		});
	}
	const persistedAvailable = items.length;
	if (items.length > MAX_TOOL_ITEMS) items.splice(0, items.length - MAX_TOOL_ITEMS);
	const live = liveTools(snapshot, current, now);
	const combined = [...items, ...live.items];
	const newestAt = combined
		.map((item) => item.at)
		.sort()
		.at(-1);
	return {
		items: combined,
		available: persistedAvailable + live.available,
		invalid: invalid + live.invalid,
		dropped: dropped + live.dropped,
		truncated: data.truncated || items.length < persistedAvailable || live.truncated,
		...(newestAt ? { newestAt } : {}),
	};
}

function daemonEvidence(performance: DaemonPerformance | undefined, now: number): SourceRead<DiagnosticEvidence> {
	if (!performance) return { items: [], available: 0, invalid: 0, dropped: 0, truncated: false };
	const items: DiagnosticEvidence[] = performance.stalls.recent.map((stall, index) => ({
		ref: `diagnostic:v1:stall:${stall.at}:${index}`,
		source: "daemon",
		at: new Date(stall.at).toISOString(),
		kind: "event_loop.stall",
		reason:
			stall.ms >= 60_000 && (stall.cpuMs ?? 0) < 1_000
				? "sleep"
				: (stall.cpuMs ?? 0) >= stall.ms / 2
					? "synchronous_work"
					: "waiting",
		durationMs: stall.ms,
		...(stall.cpuMs === undefined ? {} : { cpuMs: stall.cpuMs }),
	}));
	return {
		items,
		available: items.length,
		invalid: 0,
		dropped: 0,
		truncated: false,
		newestAt: new Date(now).toISOString(),
	};
}

async function native(path: string | undefined): Promise<SourceRead<DiagnosticEvidence>> {
	if (!path) return { items: [], available: 0, invalid: 0, dropped: 0, truncated: false };
	const data = await tail(path, MAX_NATIVE_DIAGNOSTIC_BYTES);
	if (!data.available) return { items: [], available: 0, invalid: 0, dropped: 0, truncated: false };
	try {
		const batch = parseNativeDiagnostics(JSON.parse(data.lines.join("\n"))) as NativeDiagnosticsBatch;
		const items: DiagnosticEvidence[] = batch.evidence;
		return {
			items,
			available: items.length,
			invalid: 0,
			dropped: batch.dropped,
			truncated: data.truncated || batch.dropped > 0,
			...(items[0]?.at
				? {
						newestAt: items
							.map((item) => item.at)
							.sort()
							.at(-1),
					}
				: {}),
		};
	} catch {
		return { items: [], available: 0, invalid: 1, dropped: 0, truncated: data.truncated };
	}
}

function nativeSource(read: SourceRead<DiagnosticEvidence>, source: "app" | "os"): SourceRead<DiagnosticEvidence> {
	const items = read.items.filter((item) => item.source === source);
	return {
		items,
		available: items.length,
		invalid: read.invalid,
		dropped: read.dropped,
		truncated: read.truncated,
		...(items.length
			? {
					newestAt: items
						.map((item) => item.at)
						.sort()
						.at(-1),
				}
			: {}),
	};
}

/** Build a content-free snapshot. Evidence is newest-first and bounded by both item count and encoded size. */
export async function readSessionDiagnostics(input: SessionDiagnosticInput): Promise<SessionDiagnostics> {
	const now = input.now ?? Date.now();
	const requestedLimit =
		typeof input.limit === "number" && Number.isSafeInteger(input.limit) ? input.limit : MAX_DIAGNOSTIC_ITEMS;
	const limit = Math.max(1, Math.min(MAX_DIAGNOSTIC_ITEMS, requestedLimit));
	const [lifecycleRead, timingRead, toolRead, nativeRead] = await Promise.all([
		lifecycle(input.storageDir),
		timings(join(input.storageDir, "durable")),
		tools(join(input.storageDir, "durable"), input.toolActivity, input.current, now),
		native(input.nativeDiagnosticsPath),
	]);
	const daemonRead = daemonEvidence(input.performance, now);
	const appRead = nativeSource(nativeRead, "app");
	const osRead = nativeSource(nativeRead, "os");
	const reads = [lifecycleRead, timingRead, toolRead, daemonRead, nativeRead];
	const available = reads.reduce((sum, read) => sum + read.available, 0);
	const dropped = reads.reduce((sum, read) => sum + read.dropped, 0);
	const invalid = reads.reduce((sum, read) => sum + read.invalid, 0);
	const evidence = reads
		.flatMap((read) => read.items)
		.sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
		.slice(0, limit);
	const sources = [
		sourceStatus("lifecycle", lifecycleRead, now),
		sourceStatus("request_timing", timingRead, now),
		sourceStatus("tool", toolRead, now),
		sourceStatus("daemon", daemonRead, now),
		sourceStatus("app", appRead, now),
		sourceStatus("os", osRead, now),
	];
	const resources = input.performance
		? {
				daemonUptimeMs: input.performance.uptimeMs,
				eventLoopUtilization: input.performance.eventLoop.utilization,
				...(input.performance.eventLoop.delayMs
					? { eventLoopDelayP99Ms: input.performance.eventLoop.delayMs.p99 }
					: {}),
				inFlightRequests: input.performance.operations.inFlight.length,
				rssBytes: input.performance.process.rssBytes,
				heapUsedBytes: input.performance.process.heapUsedBytes,
			}
		: {};
	const base = {
		schemaVersion: 1 as const,
		host: input.host,
		sessionId: input.sessionId,
		release: release.version,
		collectedAt: new Date(now).toISOString(),
		freshness: "fresh" as const,
		connectivity: input.connectivity,
		current: input.current,
		resources,
		...(input.ai ? { ai: input.ai } : {}),
		...(input.aiBudget ? { aiBudget: input.aiBudget } : {}),
		sources,
	};
	const truncation = {
		truncated: evidence.length < available || reads.some((read) => read.truncated),
		returned: evidence.length,
		available,
		dropped,
		invalid,
		encodedBytes: 0,
		maxItems: limit,
		maxBytes: MAX_DIAGNOSTIC_BYTES,
	};
	const result: SessionDiagnostics = {
		...base,
		evidence,
		truncation,
	};
	for (;;) {
		// Settle the byte count because writing its digits can itself change the encoded size.
		for (let pass = 0; pass < 3; pass++) truncation.encodedBytes = Buffer.byteLength(JSON.stringify(result));
		if (truncation.encodedBytes <= MAX_DIAGNOSTIC_BYTES || evidence.length === 0) break;
		evidence.pop();
		truncation.returned = evidence.length;
		truncation.truncated = true;
	}
	return result;
}

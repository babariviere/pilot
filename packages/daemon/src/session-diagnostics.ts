/** Bounded, read-only diagnostic projection. Files are tailed without opening session databases or workers. */
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import type {
	DiagnosticEvidence,
	DiagnosticFreshness,
	DiagnosticSourceStatus,
	OperationHost,
	RequestTimingDiagnosticEvidence,
	SessionDiagnosticCurrent,
	SessionDiagnostics,
} from "@pilot/protocol";
import release from "../../../package.json" with { type: "json" };
import type { DaemonPerformance } from "./event-loop-watchdog.ts";
import { LIFECYCLE_FILE, MAX_LIFECYCLE_FILE_BYTES, parseLifecycleDiagnostic } from "./lifecycle-diagnostics.ts";

export const MAX_DIAGNOSTIC_ITEMS = 128;
export const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_TIMING_ITEMS = 32;
const MAX_LIFECYCLE_ITEMS = 96;
const SOURCE_STALE_MS = 30_000;
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
	limit?: number;
	now?: number;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
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

function timing(value: unknown): RequestTimingDiagnosticEvidence | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
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

/** Build a content-free snapshot. Evidence is newest-first and bounded by both item count and encoded size. */
export async function readSessionDiagnostics(input: SessionDiagnosticInput): Promise<SessionDiagnostics> {
	const now = input.now ?? Date.now();
	const requestedLimit =
		typeof input.limit === "number" && Number.isSafeInteger(input.limit) ? input.limit : MAX_DIAGNOSTIC_ITEMS;
	const limit = Math.max(1, Math.min(MAX_DIAGNOSTIC_ITEMS, requestedLimit));
	const [lifecycleRead, timingRead] = await Promise.all([
		lifecycle(input.storageDir),
		timings(join(input.storageDir, "durable")),
	]);
	const daemonRead = daemonEvidence(input.performance, now);
	const reads = [lifecycleRead, timingRead, daemonRead];
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
		sourceStatus("daemon", daemonRead, now),
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

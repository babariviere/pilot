/** Content-free, local request timings. Never accept payloads, labels, errors or credentials. */
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { nodeTelemetry, type TraceCarrier } from "@pilot/telemetry";
import { type ControlPreparationRecord, parseControlPreparationRecord } from "./control-preparation.ts";

export interface PerformanceRecord {
	v: 1;
	request: number;
	at: number;
	source: "generation" | "stream";
	outcome: "completed" | "error" | "aborted";
	preparationMs: number;
	providerMs: number;
	totalMs: number;
	toolToPreparationMs?: number;
	payloadReadyMs?: number;
	httpDispatchMs?: number;
	responseHeadersMs?: number;
	firstProviderEventMs?: number;
	firstContentMs?: number;
	firstThinkingMs?: number;
	firstTextMs?: number;
	firstToolCallMs?: number;
	httpAttempts: number;
}

export interface PerformanceSink {
	record(record: PerformanceRecord): void;
	close?(): Promise<void>;
}

export interface PreparationMark {
	started: number;
	at: number;
	toolFinished?: number;
	/** Ephemeral interaction context. It is never serialized with the local timing record. */
	trace?: TraceCarrier;
}

type Milestone =
	| "payloadReadyMs"
	| "httpDispatchMs"
	| "responseHeadersMs"
	| "firstProviderEventMs"
	| "firstContentMs"
	| "firstThinkingMs"
	| "firstTextMs"
	| "firstToolCallMs";

/** One physical stream invocation, including its internal retries. No input values are retained. */
export class RequestTiming {
	private readonly start: PreparationMark;
	private providerStarted?: number;
	private readonly milestones: Partial<Record<Milestone, number>> = {};
	private httpAttempts = 0;
	private finished = false;
	private readonly sink: PerformanceSink;
	private readonly request: number;
	private readonly source: PerformanceRecord["source"];
	private readonly now: () => number;

	constructor(
		sink: PerformanceSink,
		request: number,
		source: PerformanceRecord["source"],
		start?: PreparationMark,
		now: () => number = () => performance.now(),
	) {
		this.sink = sink;
		this.request = request;
		this.source = source;
		this.now = now;
		this.start = start ?? { started: now(), at: Date.now() };
	}

	providerStart(): void {
		this.providerStarted ??= this.now();
	}

	mark(name: Milestone): void {
		if (this.finished || this.providerStarted === undefined) return;
		this.milestones[name] ??= Math.max(0, this.now() - this.providerStarted);
		if (name === "httpDispatchMs") this.httpAttempts++;
	}

	finish(outcome: PerformanceRecord["outcome"]): void {
		if (this.finished) return;
		this.finished = true;
		const end = this.now();
		const reachedProvider = this.providerStarted !== undefined;
		const providerStart = this.providerStarted ?? end;
		try {
			const record: PerformanceRecord = {
				v: 1,
				request: this.request,
				at: this.start.at,
				source: this.source,
				outcome,
				preparationMs: Math.max(0, providerStart - this.start.started),
				providerMs: Math.max(0, end - providerStart),
				totalMs: Math.max(0, end - this.start.started),
				...(this.start.toolFinished === undefined
					? {}
					: {
							toolToPreparationMs: Math.max(0, this.start.started - this.start.toolFinished),
						}),
				...this.milestones,
				httpAttempts: this.httpAttempts,
			};
			this.sink.record(record);
			nodeTelemetry().recordSpan("pilot.kernel.request", record.totalMs, {
				"pilot.operation": "kernel.request",
				"pilot.outcome": outcome === "completed" ? "success" : outcome === "aborted" ? "cancelled" : "failure",
			});
			if (this.start.trace) {
				const exportedOutcome =
					outcome === "completed" ? "success" : outcome === "aborted" ? "cancelled" : "failure";
				nodeTelemetry().recordSpan(
					"pilot.message.send",
					record.preparationMs,
					{
						"pilot.operation": "message.send",
						"pilot.phase": "preparation",
						"pilot.outcome": reachedProvider ? "success" : exportedOutcome,
						"pilot.progress_kind": "none",
					},
					{ parent: this.start.trace, endTime: new Date(record.at + record.preparationMs) },
				);
				if (reachedProvider) {
					const progress = (
						[
							[record.firstThinkingMs, "thinking"],
							[record.firstTextMs, "text"],
							[record.firstToolCallMs, "tool"],
						] as const
					)
						.filter((value): value is readonly [number, "thinking" | "text" | "tool"] => value[0] !== undefined)
						.sort((left, right) => left[0] - right[0])[0]?.[1];
					nodeTelemetry().recordSpan(
						"pilot.message.send",
						record.providerMs,
						{
							"pilot.operation": "message.send",
							"pilot.phase": "provider",
							"pilot.outcome": exportedOutcome,
							"pilot.progress_kind": progress ?? "none",
							"pilot.retry_count": Math.max(0, Math.min(8, record.httpAttempts - 1)),
						},
						{ parent: this.start.trace, endTime: new Date(record.at + record.totalMs) },
					);
				}
			}
		} catch {
			// Diagnostics cannot change success, abort, replay or retry behavior.
		}
	}
}

const NUMBERS = [
	"request",
	"at",
	"preparationMs",
	"providerMs",
	"totalMs",
	"toolToPreparationMs",
	"payloadReadyMs",
	"httpDispatchMs",
	"responseHeadersMs",
	"firstProviderEventMs",
	"firstContentMs",
	"firstThinkingMs",
	"firstTextMs",
	"firstToolCallMs",
	"httpAttempts",
] as const;
const MAX_LINE_BYTES = 2048;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PENDING = 64;
let collectionEnabled = true;
const activeLogs = new Set<PerformanceLog>();

export function setPerformanceCollectionEnabled(enabled: boolean): void {
	collectionEnabled = enabled;
}

export async function preparePerformanceClear(): Promise<void> {
	collectionEnabled = false;
	await Promise.all([...activeLogs].map((log) => log.flush()));
}

/** A strict whitelist, even if a caller passes extra fields at runtime. */
export function performanceLine(record: PerformanceRecord | ControlPreparationRecord): string | undefined {
	if (record.source === "control_preparation") {
		const safe = parseControlPreparationRecord(record);
		return safe ? `${JSON.stringify(safe)}\n` : undefined;
	}
	if (
		record.v !== 1 ||
		!["generation", "stream"].includes(record.source) ||
		!["completed", "error", "aborted"].includes(record.outcome)
	)
		return;
	const safe: Record<string, number | string> = { v: 1, source: record.source, outcome: record.outcome };
	for (const key of NUMBERS) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0)
			safe[key] = Math.round(Math.min(value, Number.MAX_SAFE_INTEGER) * 100) / 100;
	}
	return `${JSON.stringify(safe)}\n`;
}

/** Two private, capped JSONL segments. One async writer, bounded queue, no network or durable transcript writes. */
export class PerformanceLog implements PerformanceSink {
	private readonly queue: string[] = [];
	private writing?: Promise<void>;
	private closed = false;
	private disabled = false;
	private dropped = 0;
	private readonly maxBytes: number;
	private readonly maxPending: number;
	private readonly file: string;

	constructor(file: string, options: { maxBytes?: number; maxPending?: number } = {}) {
		this.file = file;
		this.maxBytes = Math.max(MAX_LINE_BYTES, Math.min(MAX_FILE_BYTES, options.maxBytes ?? MAX_FILE_BYTES));
		this.maxPending = Math.max(1, Math.min(MAX_PENDING, options.maxPending ?? MAX_PENDING));
		activeLogs.add(this);
	}

	record(record: PerformanceRecord | ControlPreparationRecord): void {
		if (!collectionEnabled || this.closed || this.disabled) return;
		if (this.queue.length >= this.maxPending) {
			this.dropped++;
			return;
		}
		try {
			let line = performanceLine(record);
			if (!line) return;
			if (this.dropped) line = `${line.trimEnd().slice(0, -1)},"droppedBefore":${this.dropped}}\n`;
			if (Buffer.byteLength(line) > MAX_LINE_BYTES) return;
			this.dropped = 0;
			this.queue.push(line);
			this.schedule();
		} catch {
			// Invalid diagnostics are dropped without inspecting or logging the bad value.
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
						if (!stat.isFile()) throw new Error("Invalid performance log");
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
		activeLogs.delete(this);
	}
}

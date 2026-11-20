/** Strict, content-free OpenTelemetry foundation shared by pilotd and kernel workers. */
import { randomBytes, randomUUID } from "node:crypto";
import { platform } from "node:os";
import {
	type Attributes,
	type Context,
	ROOT_CONTEXT,
	type Span,
	type SpanOptions,
	SpanStatusCode,
	type TextMapGetter,
	type TextMapSetter,
	TraceFlags,
	trace,
} from "@opentelemetry/api";
import { type ExportResult, ExportResultCode, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	AlwaysOnSampler,
	BatchSpanProcessor,
	type ReadableSpan,
	type Span as SdkSpan,
	type SpanExporter,
	type SpanProcessor,
	TracerProvider,
} from "@opentelemetry/sdk-trace";

export const TELEMETRY_SCHEMA_VERSION = 3 as const;
export const NODE_SPAN_QUEUE_LIMIT = 512;
export const NODE_SPAN_BATCH_LIMIT = 128;
export const NODE_SPAN_SCHEDULE_MS = 5_000;
export const NODE_SPAN_EXPORT_TIMEOUT_MS = 3_000;
const OTLP_SINGLE_ATTEMPT_TIMEOUT_MS = 750;
const ATTRIBUTE_LIMIT = 24;
const ATTRIBUTE_VALUE_BYTES = 64;

const SPAN_NAMES = [
	"pilot.message.send",
	"pilot.chat.open",
	"pilot.daemon.request",
	"pilot.kernel.request",
	"pilot.event_loop.stall",
	"pilot.ai.usage",
	"pilot.tool.call",
	"pilot.tool.cancel_wait",
	"pilot.feature",
] as const;

const OPERATIONS = [
	"message.send",
	"chat.open",
	"daemon.request",
	"kernel.request",
	"event_loop.stall",
	"ai.usage",
	"tool.call",
	"tool.cancel_wait",
] as const;

const PHASES = [
	"api",
	"admission",
	"startup_wait",
	"preparation",
	"provider",
	"publication",
	"first_visible",
	"history_read",
	"reduction",
	"first_transcript",
] as const;

const OUTCOMES = ["success", "failure", "cancelled", "timeout", "interrupted", "unavailable"] as const;

const REASONS = [
	"none",
	"user",
	"sleep",
	"update",
	"quota",
	"usage_limit",
	"connectivity",
	"startup_timeout",
	"process_exit",
	"recovery_backoff",
	"parked_idle",
	"synchronous_work",
	"waiting",
	"unknown",
] as const;

const HISTORY_BUCKETS = ["0", "1-100", "101-1000", "1001+"] as const;

const PROGRESS_KINDS = ["thinking", "text", "tool", "none"] as const;

const FRAME_OBSERVATIONS = ["available", "occluded", "asleep", "unsupported"] as const;

const TOOL_CATEGORIES = [
	"shell",
	"filesystem",
	"network",
	"background",
	"codemode",
	"mcp",
	"orchestration",
	"other",
] as const;

const AI_SCOPES = ["direct", "child", "session"] as const;

const AI_REASONING_STATUS = ["reported", "partial", "unavailable"] as const;

const AI_ESTIMATE_STATUS = ["catalog_estimate", "partial_catalog_estimate", "unavailable"] as const;

const AI_BILLED_STATUS = ["known", "unavailable"] as const;

const AI_SUBSCRIPTION_COVERAGE = ["covered", "not_covered", "unknown"] as const;

const AI_LAUNCH_REASONS = [
	"initial",
	"parked_wake",
	"user_resume",
	"crash_recovery",
	"startup_retry",
	"replacement",
	"unknown",
] as const;

export type TelemetryServiceName = "pilot.daemon" | "pilot.kernel";
export type TelemetryEnvironment = "release" | "development" | "test";
export type TelemetryHostKind = "local" | "devbox";

export function telemetryEnvironment(nodeEnv = process.env.NODE_ENV): TelemetryEnvironment {
	return nodeEnv === "test" ? "test" : nodeEnv === "production" ? "release" : "development";
}

/** Pilot devboxes run Linux; local hosts run macOS. */
export function localHostKind(): TelemetryHostKind {
	return process.platform === "linux" ? "devbox" : "local";
}
export type TelemetrySpanName = (typeof SPAN_NAMES)[number];

export type TelemetryToolCategory = (typeof TOOL_CATEGORIES)[number];

export type TelemetryPhase = (typeof PHASES)[number];
export type TelemetryOutcome = (typeof OUTCOMES)[number];
export type TelemetryReason = (typeof REASONS)[number];

export interface TelemetryAttributes {
	"pilot.operation"?: (typeof OPERATIONS)[number];
	"pilot.phase"?: TelemetryPhase;
	"pilot.outcome"?: TelemetryOutcome;
	"pilot.reason"?: TelemetryReason;
	"pilot.cold"?: boolean;
	"pilot.recovered"?: boolean;
	"pilot.retry_count"?: number;
	"pilot.queue_depth"?: number;
	"pilot.history_bucket"?: (typeof HISTORY_BUCKETS)[number];
	"pilot.progress_kind"?: (typeof PROGRESS_KINDS)[number];
	"pilot.frame_observation"?: (typeof FRAME_OBSERVATIONS)[number];
	"pilot.tool.category"?: TelemetryToolCategory;
	"pilot.tool.nested"?: boolean;
	"pilot.tool.dispatch_ms"?: number;
	"pilot.tool.execution_ms"?: number;
	"pilot.ai.scope"?: (typeof AI_SCOPES)[number];
	"pilot.ai.input_tokens"?: number;
	"pilot.ai.output_tokens"?: number;
	"pilot.ai.cache_read_tokens"?: number;
	"pilot.ai.cache_write_tokens"?: number;
	"pilot.ai.reasoning_tokens"?: number;
	"pilot.ai.reasoning_status"?: (typeof AI_REASONING_STATUS)[number];
	"pilot.ai.activity_count"?: number;
	"pilot.ai.success_count"?: number;
	"pilot.ai.failure_count"?: number;
	"pilot.ai.cancelled_count"?: number;
	"pilot.ai.usage_report_count"?: number;
	"pilot.ai.provider_attempt_count"?: number;
	"pilot.ai.request_retry_count"?: number;
	"pilot.ai.input_growth_observation_count"?: number;
	"pilot.ai.context_tokens"?: number;
	"pilot.ai.context_window_tokens"?: number;
	"pilot.ai.context_headroom_tokens"?: number;
	"pilot.ai.context_percent_millis"?: number;
	"pilot.ai.compaction_count"?: number;
	"pilot.ai.compaction_paired_count"?: number;
	"pilot.ai.compaction_before_tokens"?: number;
	"pilot.ai.compaction_after_tokens"?: number;
	"pilot.ai.compaction_removed_tokens"?: number;
	"pilot.ai.launch_count"?: number;
	"pilot.ai.launch_reason"?: (typeof AI_LAUNCH_REASONS)[number];
	"pilot.ai.prepared_context_count"?: number;
	"pilot.ai.prepared_context_tokens"?: number;
	"pilot.ai.elapsed_ms"?: number;
	"pilot.ai.active_ms"?: number;
	"pilot.ai.paused_ms"?: number;
	"pilot.ai.idle_ms"?: number;
	"pilot.ai.estimate_status"?: (typeof AI_ESTIMATE_STATUS)[number];
	"pilot.ai.estimated_usd_micros"?: number;
	"pilot.ai.pricing_source"?: "pi_catalog";
	"pilot.ai.billed_status"?: (typeof AI_BILLED_STATUS)[number];
	"pilot.ai.billed_usd_micros"?: number;
	"pilot.ai.subscription_coverage"?: (typeof AI_SUBSCRIPTION_COVERAGE)[number];
}

/** The only daemon/kernel propagation format. Baggage and tracestate are deliberately absent. */
export interface TraceCarrier {
	traceparent: string;
}

export interface NodeTelemetryOptions {
	enabled: boolean;
	serviceName: TelemetryServiceName;
	serviceVersion: string;
	environment: TelemetryEnvironment;
	hostKind: TelemetryHostKind;
	/** Pseudonymous, locally keyed identifier from the reviewed contract. Never pass a raw HostRef field. */
	hostId?: string;
	/** Injectable for tests or an embedding host. */
	exporter?: SpanExporter;
	/** OTLP/HTTP protobuf endpoint. No headers, userinfo, query or non-loopback cleartext are accepted. */
	endpoint?: string;
	/** Local-only lifecycle hook for bounded in-flight diagnostics. It must not retain arbitrary attributes. */
	observeInFlight?: (event: TelemetryInFlightEvent) => void;
}

export interface TelemetryStats {
	started: number;
	invalid: number;
	queued: number;
	dropped: number;
	exportFailures: number;
}

export interface TelemetrySpan {
	readonly recording: boolean;
	readonly traceId?: string;
	carrier(): TraceCarrier | undefined;
	/** Useful work advanced. Heartbeats deliberately do not call this. */
	progress(): void;
	/** The owner is alive, but useful work may still be stalled. */
	heartbeat(): void;
	end(at?: Date): void;
	finish(outcome: TelemetryLifecycleOutcome, at?: Date): void;
}

export type TelemetryLifecycleOutcome =
	| "completed"
	| "failed"
	| "timeout"
	| "cancelled"
	| "interrupted"
	| "unavailable";
export type TelemetryInFlightEvent =
	| {
			kind: "started" | "progress" | "heartbeat";
			service: TelemetryServiceName;
			name: TelemetrySpanName;
			traceId: string;
			spanId: string;
			at: number;
			monotonicMs: number;
	  }
	| {
			kind: "finished";
			service: TelemetryServiceName;
			name: TelemetrySpanName;
			traceId: string;
			spanId: string;
			at: number;
			monotonicMs: number;
			outcome: TelemetryLifecycleOutcome;
	  };

const SPAN_NAMES_SET = new Set<string>(SPAN_NAMES);
const OPERATIONS_SET = new Set<string>(OPERATIONS);
const PHASES_SET = new Set<string>(PHASES);
const OUTCOMES_SET = new Set<string>(OUTCOMES);
const REASONS_SET = new Set<string>(REASONS);
const HISTORY_BUCKETS_SET = new Set<string>(HISTORY_BUCKETS);
const PROGRESS_KINDS_SET = new Set<string>(PROGRESS_KINDS);
const FRAME_OBSERVATIONS_SET = new Set<string>(FRAME_OBSERVATIONS);
const TOOL_CATEGORIES_SET = new Set<string>(TOOL_CATEGORIES);
const AI_SCOPES_SET = new Set<string>(AI_SCOPES);
const AI_REASONING_STATUS_SET = new Set<string>(AI_REASONING_STATUS);
const AI_ESTIMATE_STATUS_SET = new Set<string>(AI_ESTIMATE_STATUS);
const AI_BILLED_STATUS_SET = new Set<string>(AI_BILLED_STATUS);
const AI_SUBSCRIPTION_COVERAGE_SET = new Set<string>(AI_SUBSCRIPTION_COVERAGE);
const AI_LAUNCH_REASONS_SET = new Set<string>(AI_LAUNCH_REASONS);
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;
const setter: TextMapSetter<TraceCarrier> = {
	set(carrier, key, value) {
		if (key === "traceparent" && TRACEPARENT.test(value)) carrier.traceparent = value;
	},
};
const getter: TextMapGetter<TraceCarrier> = {
	keys: () => ["traceparent"],
	get: (carrier, key) => (key === "traceparent" ? carrier.traceparent : undefined),
};
const propagator = new W3CTraceContextPropagator();

function bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function closedString(value: unknown, values: Set<string>): value is string {
	return typeof value === "string" && bytes(value) <= ATTRIBUTE_VALUE_BYTES && values.has(value);
}

/** Copy the reviewed keys only. Any unknown or malformed field rejects the entire observation. */
export function telemetryAttributes(value: TelemetryAttributes): TelemetryAttributes | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > ATTRIBUTE_LIMIT) return;
	for (const [key, field] of entries) {
		if (key === "pilot.operation" && closedString(field, OPERATIONS_SET)) continue;
		if (key === "pilot.phase" && closedString(field, PHASES_SET)) continue;
		if (key === "pilot.outcome" && closedString(field, OUTCOMES_SET)) continue;
		if (key === "pilot.reason" && closedString(field, REASONS_SET)) continue;
		if ((key === "pilot.cold" || key === "pilot.recovered") && typeof field === "boolean") continue;
		if (key === "pilot.retry_count" && Number.isInteger(field) && (field as number) >= 0 && (field as number) <= 8)
			continue;
		if (key === "pilot.queue_depth" && Number.isInteger(field) && (field as number) >= 0 && (field as number) <= 512)
			continue;
		if (key === "pilot.history_bucket" && closedString(field, HISTORY_BUCKETS_SET)) continue;
		if (key === "pilot.progress_kind" && closedString(field, PROGRESS_KINDS_SET)) continue;
		if (key === "pilot.frame_observation" && closedString(field, FRAME_OBSERVATIONS_SET)) continue;
		if (key === "pilot.tool.category" && closedString(field, TOOL_CATEGORIES_SET)) continue;
		if (key === "pilot.tool.nested" && typeof field === "boolean") continue;
		if (key === "pilot.ai.scope" && closedString(field, AI_SCOPES_SET)) continue;
		if (key === "pilot.ai.reasoning_status" && closedString(field, AI_REASONING_STATUS_SET)) continue;
		if (key === "pilot.ai.estimate_status" && closedString(field, AI_ESTIMATE_STATUS_SET)) continue;
		if (key === "pilot.ai.pricing_source" && field === "pi_catalog") continue;
		if (key === "pilot.ai.billed_status" && closedString(field, AI_BILLED_STATUS_SET)) continue;
		if (key === "pilot.ai.subscription_coverage" && closedString(field, AI_SUBSCRIPTION_COVERAGE_SET)) continue;
		if (key === "pilot.ai.launch_reason" && closedString(field, AI_LAUNCH_REASONS_SET)) continue;
		if (
			[
				"pilot.ai.input_tokens",
				"pilot.ai.output_tokens",
				"pilot.ai.cache_read_tokens",
				"pilot.ai.cache_write_tokens",
				"pilot.ai.reasoning_tokens",
				"pilot.ai.activity_count",
				"pilot.ai.success_count",
				"pilot.ai.failure_count",
				"pilot.ai.cancelled_count",
				"pilot.ai.usage_report_count",
				"pilot.ai.provider_attempt_count",
				"pilot.ai.request_retry_count",
				"pilot.ai.input_growth_observation_count",
				"pilot.ai.context_tokens",
				"pilot.ai.context_window_tokens",
				"pilot.ai.context_headroom_tokens",
				"pilot.ai.context_percent_millis",
				"pilot.ai.compaction_count",
				"pilot.ai.compaction_paired_count",
				"pilot.ai.compaction_before_tokens",
				"pilot.ai.compaction_after_tokens",
				"pilot.ai.compaction_removed_tokens",
				"pilot.ai.launch_count",
				"pilot.ai.prepared_context_count",
				"pilot.ai.prepared_context_tokens",
				"pilot.ai.elapsed_ms",
				"pilot.ai.active_ms",
				"pilot.ai.paused_ms",
				"pilot.ai.idle_ms",
				"pilot.ai.estimated_usd_micros",
				"pilot.ai.billed_usd_micros",
			].includes(key) &&
			Number.isSafeInteger(field) &&
			(field as number) >= 0
		)
			continue;
		if (
			(key === "pilot.tool.dispatch_ms" || key === "pilot.tool.execution_ms") &&
			typeof field === "number" &&
			Number.isFinite(field) &&
			field >= 0 &&
			field <= 604_800_000
		)
			continue;
		return;
	}
	if (
		value["pilot.ai.estimate_status"] !== undefined &&
		value["pilot.ai.estimate_status"] !== "unavailable" &&
		(value["pilot.ai.estimated_usd_micros"] === undefined || value["pilot.ai.pricing_source"] !== "pi_catalog")
	)
		return;
	if (
		value["pilot.ai.estimated_usd_micros"] !== undefined &&
		(value["pilot.ai.estimate_status"] === undefined || value["pilot.ai.estimate_status"] === "unavailable")
	)
		return;
	if (value["pilot.ai.pricing_source"] !== undefined && value["pilot.ai.estimated_usd_micros"] === undefined) return;
	if (value["pilot.ai.billed_status"] === "known" && value["pilot.ai.billed_usd_micros"] === undefined) return;
	if (value["pilot.ai.billed_usd_micros"] !== undefined && value["pilot.ai.billed_status"] !== "known") return;
	if ((value["pilot.ai.launch_reason"] === undefined) !== (value["pilot.ai.launch_count"] === undefined)) return;
	return Object.fromEntries(entries) as TelemetryAttributes;
}

export function traceCarrier(value: unknown): TraceCarrier | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 1 ||
		typeof record.traceparent !== "string" ||
		!TRACEPARENT.test(record.traceparent)
	)
		return;
	return { traceparent: record.traceparent };
}

export function validateOtlpEndpoint(value: string): string {
	const url = new URL(value);
	if (url.username || url.password || url.search || url.hash)
		throw new Error("OTLP endpoint cannot include credentials, query or fragment");
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
		throw new Error("OTLP endpoint must use HTTPS or loopback HTTP");
	if (!url.pathname || url.pathname === "/") url.pathname = "/v1/traces";
	return url.toString();
}

class WrappedSpan implements TelemetrySpan {
	readonly recording = true;
	readonly traceId: string;
	private readonly spanId: string;
	private ended = false;
	private readonly span: Span | undefined;
	private readonly spanContext: Context;
	private readonly service: TelemetryServiceName;
	private readonly name: TelemetrySpanName;
	private readonly observe?: (event: TelemetryInFlightEvent) => void;
	private readonly defaultOutcome: TelemetryLifecycleOutcome;
	constructor(
		span: Span | undefined,
		spanContext: Context,
		service: TelemetryServiceName,
		name: TelemetrySpanName,
		observe?: (event: TelemetryInFlightEvent) => void,
		defaultOutcome: TelemetryLifecycleOutcome = "completed",
	) {
		this.span = span;
		this.spanContext = spanContext;
		this.service = service;
		this.name = name;
		this.observe = observe;
		this.defaultOutcome = defaultOutcome;
		const context = trace.getSpanContext(spanContext);
		this.traceId = context?.traceId ?? "";
		this.spanId = context?.spanId ?? "";
		this.emit("started");
	}
	carrier(): TraceCarrier | undefined {
		const carrier = {} as TraceCarrier;
		propagator.inject(this.spanContext, carrier, setter);
		return traceCarrier(carrier);
	}
	progress(): void {
		if (!this.ended) this.emit("progress");
	}
	heartbeat(): void {
		if (!this.ended) this.emit("heartbeat");
	}
	end(at?: Date): void {
		this.finish(this.defaultOutcome, at);
	}
	finish(outcome: TelemetryLifecycleOutcome, at?: Date): void {
		if (this.ended) return;
		this.ended = true;
		this.span?.setAttribute(
			"pilot.outcome",
			outcome === "completed"
				? "success"
				: outcome === "cancelled"
					? "cancelled"
					: outcome === "timeout"
						? "timeout"
						: outcome === "interrupted"
							? "interrupted"
							: outcome === "unavailable"
								? "unavailable"
								: "failure",
		);
		if (outcome === "failed" || outcome === "interrupted" || outcome === "timeout")
			this.span?.setStatus({ code: SpanStatusCode.ERROR });
		this.span?.end(at);
		this.emit("finished", outcome);
	}
	private emit(kind: "started" | "progress" | "heartbeat", outcome?: never): void;
	private emit(kind: "finished", outcome: TelemetryLifecycleOutcome): void;
	private emit(kind: TelemetryInFlightEvent["kind"], outcome?: TelemetryLifecycleOutcome): void {
		if (!this.observe) return;
		try {
			this.observe({
				kind,
				service: this.service,
				name: this.name,
				traceId: this.traceId,
				spanId: this.spanId,
				at: Date.now(),
				monotonicMs: Number(process.hrtime.bigint() / 1_000_000n),
				...(kind === "finished" ? { outcome: outcome! } : {}),
			} as TelemetryInFlightEvent);
		} catch {
			// Local observation cannot change the operation it observes.
		}
	}
}

const NOOP_SPAN: TelemetrySpan = {
	recording: false,
	carrier: () => undefined,
	progress: () => undefined,
	heartbeat: () => undefined,
	end: () => undefined,
	finish: () => undefined,
};

function randomHex(bytes: number): string {
	let value = randomBytes(bytes).toString("hex");
	if (/^0+$/.test(value)) value = `${"0".repeat(value.length - 1)}1`;
	return value;
}

function nodeOs(): "darwin" | "linux" {
	return platform() === "linux" ? "linux" : "darwin";
}

function numericVersion(value: string): string {
	const match = /^\d+(?:\.\d+){0,3}/.exec(value);
	return match?.[0] ?? "0";
}

function exporter(options: NodeTelemetryOptions): SpanExporter | undefined {
	if (options.exporter) return options.exporter;
	if (!options.endpoint) return;
	return withoutOtelEnvironment(
		() =>
			new OTLPTraceExporter({
				url: validateOtlpEndpoint(options.endpoint!),
				// The SDK's first retry waits at least 800ms. Ending before that guarantees one network attempt per batch.
				timeoutMillis: OTLP_SINGLE_ATTEMPT_TIMEOUT_MS,
				concurrencyLimit: 1,
			}),
	);
}

/** OTel's constructors otherwise merge generic OTEL_* environment settings into Pilot's reviewed configuration. */
function withoutOtelEnvironment<T>(run: () => T): T {
	const saved = new Map<string, string>();
	for (const key of Object.keys(process.env)) {
		if (!key.startsWith("OTEL_")) continue;
		const value = process.env[key];
		if (value !== undefined) saved.set(key, value);
		delete process.env[key];
	}
	try {
		return run();
	} finally {
		for (const [key, value] of saved) process.env[key] = value;
	}
}

class CountedExporter implements SpanExporter {
	private readonly sink: SpanExporter;
	private readonly stats: TelemetryStats;
	private revoked = false;
	constructor(sink: SpanExporter, stats: TelemetryStats) {
		this.sink = sink;
		this.stats = stats;
	}
	export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
		if (this.revoked) {
			this.stats.queued = Math.max(0, this.stats.queued - spans.length);
			callback({ code: ExportResultCode.SUCCESS });
			return;
		}
		let settled = false;
		const finish = (result: ExportResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.stats.queued = Math.max(0, this.stats.queued - spans.length);
			if (result.code !== ExportResultCode.SUCCESS && !this.revoked) {
				this.stats.dropped += spans.length;
				this.stats.exportFailures++;
			}
			callback(result);
		};
		const timer = setTimeout(() => finish({ code: ExportResultCode.FAILED }), NODE_SPAN_EXPORT_TIMEOUT_MS);
		timer.unref();
		try {
			this.sink.export(spans, finish);
		} catch {
			finish({ code: ExportResultCode.FAILED });
		}
	}
	forceFlush(): Promise<void> {
		return this.sink.forceFlush?.() ?? Promise.resolve();
	}
	shutdown(): Promise<void> {
		return this.sink.shutdown();
	}
	revoke(): void {
		if (this.revoked) return;
		this.revoked = true;
		this.stats.dropped += this.stats.queued;
		this.stats.queued = 0;
	}
}

class BoundedSpanProcessor implements SpanProcessor {
	private readonly processor: BatchSpanProcessor;
	private readonly stats: TelemetryStats;
	constructor(processor: BatchSpanProcessor, stats: TelemetryStats) {
		this.processor = processor;
		this.stats = stats;
	}
	onStart(span: SdkSpan, parentContext: Context): void {
		this.processor.onStart(span, parentContext);
	}
	onEnd(span: ReadableSpan): void {
		if (this.stats.queued >= NODE_SPAN_QUEUE_LIMIT) {
			this.stats.dropped++;
			return;
		}
		this.stats.queued++;
		this.processor.onEnd(span);
	}
	forceFlush(): Promise<void> {
		return this.processor.forceFlush();
	}
	shutdown(): Promise<void> {
		return this.processor.shutdown();
	}
}

export class NodeTelemetry {
	readonly stats: TelemetryStats = { started: 0, invalid: 0, queued: 0, dropped: 0, exportFailures: 0 };
	private readonly provider?: TracerProvider;
	private readonly tracer?: ReturnType<TracerProvider["getTracer"]>;
	private readonly exportEnabled: boolean;
	private readonly service: TelemetryServiceName;
	private readonly observe?: (event: TelemetryInFlightEvent) => void;
	private readonly counted?: CountedExporter;

	constructor(options: NodeTelemetryOptions) {
		this.service = options.serviceName;
		this.observe = options.observeInFlight;
		const sink = options.enabled ? exporter(options) : undefined;
		this.exportEnabled = sink !== undefined;
		if (!sink) return;
		if (!/^\d+(?:\.\d+){1,3}$/.test(options.serviceVersion)) throw new Error("Invalid telemetry service version");
		if (options.hostId !== undefined && !/^[a-z0-9_-]{22}$/.test(options.hostId))
			throw new Error("Invalid pseudonymous telemetry host id");
		this.counted = new CountedExporter(sink, this.stats);
		const processor = new BatchSpanProcessor({
			exporter: this.counted,
			maxQueueSize: NODE_SPAN_QUEUE_LIMIT,
			maxExportBatchSize: NODE_SPAN_BATCH_LIMIT,
			scheduledDelayMillis: NODE_SPAN_SCHEDULE_MS,
			exportTimeoutMillis: NODE_SPAN_EXPORT_TIMEOUT_MS,
		});
		this.provider = withoutOtelEnvironment(
			() =>
				new TracerProvider({
					resource: resourceFromAttributes({
						"service.namespace": "com.babariviere.pilot",
						"service.name": options.serviceName,
						"service.version": options.serviceVersion,
						"service.instance.id": randomUUID(),
						"deployment.environment.name": options.environment,
						"os.type": nodeOs(),
						"process.runtime.name": "nodejs",
						"process.runtime.version": numericVersion(process.versions.node),
						"pilot.schema.version": TELEMETRY_SCHEMA_VERSION,
						"pilot.host.kind": options.hostKind,
						...(options.hostId ? { "pilot.host.id": options.hostId } : {}),
					}),
					sampler: new AlwaysOnSampler(),
					spanProcessors: [new BoundedSpanProcessor(processor, this.stats)],
					spanLimits: {
						attributeCountLimit: ATTRIBUTE_LIMIT,
						attributeValueLengthLimit: ATTRIBUTE_VALUE_BYTES,
						eventCountLimit: 16,
						attributePerEventCountLimit: 0,
						linkCountLimit: 0,
						attributePerLinkCountLimit: 0,
					},
				}),
		);
		this.tracer = this.provider.getTracer(options.serviceName, options.serviceVersion);
	}

	startSpan(
		name: TelemetrySpanName,
		attributes: TelemetryAttributes = {},
		options: { parent?: TraceCarrier; startTime?: Date } = {},
	): TelemetrySpan {
		if (!this.exportEnabled && !this.observe) return NOOP_SPAN;
		if (!SPAN_NAMES_SET.has(name)) {
			this.stats.invalid++;
			return NOOP_SPAN;
		}
		const safe = telemetryAttributes(attributes);
		if (!safe) {
			this.stats.invalid++;
			return NOOP_SPAN;
		}
		let parent = ROOT_CONTEXT;
		if (options.parent) {
			const carrier = traceCarrier(options.parent);
			if (!carrier) {
				this.stats.invalid++;
				return NOOP_SPAN;
			}
			parent = propagator.extract(ROOT_CONTEXT, carrier, getter);
		}
		const spanOptions: SpanOptions = {
			attributes: safe as Attributes,
			...(options.startTime ? { startTime: options.startTime } : {}),
		};
		const span = this.tracer?.startSpan(name, spanOptions, parent);
		const spanContext = span
			? trace.setSpan(ROOT_CONTEXT, span)
			: trace.setSpanContext(ROOT_CONTEXT, {
					traceId: trace.getSpanContext(parent)?.traceId ?? randomHex(16),
					spanId: randomHex(8),
					traceFlags: TraceFlags.SAMPLED,
					isRemote: false,
				});
		this.stats.started++;
		const defaultOutcome =
			safe["pilot.outcome"] === "failure"
				? "failed"
				: safe["pilot.outcome"] === "interrupted"
					? "interrupted"
					: safe["pilot.outcome"] === "cancelled" ||
							safe["pilot.outcome"] === "timeout" ||
							safe["pilot.outcome"] === "unavailable"
						? safe["pilot.outcome"]
						: "completed";
		return new WrappedSpan(span, spanContext, this.service, name, this.observe, defaultOutcome);
	}

	recordSpan(
		name: TelemetrySpanName,
		durationMs: number,
		attributes: TelemetryAttributes = {},
		options: { parent?: TraceCarrier; endTime?: Date } = {},
	): void {
		if ((!this.exportEnabled && !this.observe) || !Number.isFinite(durationMs) || durationMs < 0) return;
		const endedAt = options.endTime?.getTime() ?? Date.now();
		const span = this.startSpan(name, attributes, {
			...(options.parent ? { parent: options.parent } : {}),
			startTime: new Date(endedAt - durationMs),
		});
		span.end(new Date(endedAt));
	}

	async forceFlush(timeoutMs = NODE_SPAN_EXPORT_TIMEOUT_MS): Promise<boolean> {
		if (!this.provider) return true;
		try {
			await this.provider.forceFlush({
				timeoutMillis: Math.max(1, Math.min(timeoutMs, NODE_SPAN_EXPORT_TIMEOUT_MS)),
			});
			return true;
		} catch {
			return false;
		}
	}

	async shutdown(timeoutMs = 1_000): Promise<void> {
		if (!this.provider) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			this.provider.shutdown().catch(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, Math.max(1, Math.min(timeoutMs, 1_000)));
				timer.unref();
			}),
		]);
		clearTimeout(timer);
	}

	/** Stop new export and discard every batch not already inside an SDK network attempt. */
	async revoke(timeoutMs = 1_000): Promise<void> {
		this.counted?.revoke();
		await this.shutdown(timeoutMs);
	}
}

let current = new NodeTelemetry({
	enabled: false,
	serviceName: "pilot.daemon",
	serviceVersion: "0.0.0",
	environment: "development",
	hostKind: "local",
});

/** Process-local installation, configured by the host's explicit telemetry consent. */
export function configureNodeTelemetry(options: NodeTelemetryOptions): NodeTelemetry {
	const previous = current;
	current = new NodeTelemetry(options);
	void previous.revoke();
	return current;
}

export function nodeTelemetry(): NodeTelemetry {
	return current;
}

export { ExportResultCode } from "@opentelemetry/core";
export type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";

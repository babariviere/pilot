/** The contract between the source scheduler (sources.ts) and the Slack and Linear adapters. */
import type {
	LinearSourceSummary,
	Project,
	ProjectTrackingConfig,
	RefreshObservation,
	TrackedKind,
	TrackingJson,
	TrackingLookup,
} from "@pilot/protocol";
import type { BackgroundJobDiagnostics } from "./background-job-diagnostics.ts";
import type { ProjectStore } from "./projects.ts";
import { SlackFormatChanged } from "./slack-format.ts";
import type { TrackedInput, TrackedItemStore } from "./tracked-items.ts";

export const SOURCE_REFRESH_CADENCE_MS = 300_000;
export const SOURCE_REFRESH_TIMEOUT_MS = 90_000;
export const TRACKING_STOPPED = "Tracking is stopped or paused for maintenance";
export const TRACKING_BUSY = "Tracking is busy, retry shortly";

export interface SourcePollContext {
	/** Closed process-local observation only. Never carries source content or model/tool arguments. */
	observe?(event: RefreshObservation): void;
	project: Project;
	config: ProjectTrackingConfig;
	cursor?: TrackingJson;
	signal: AbortSignal;
	/** Logical capability: dedicated source tools only. No model here. */
	call(tool: string, args: Record<string, unknown>): Promise<TrackingJson>;
}
export interface SourcePollResult {
	items: TrackedInput[];
	cursor?: TrackingJson;
	linear?: LinearSourceSummary;
	/** Full scoped membership, for removing stale rows without losing local links. */
	activeIds?: string[];
	issue?: "slack_classification" | "slack_channel";
}
export type SourcePoller = (context: SourcePollContext) => Promise<SourcePollResult>;

export type SourceHealth = {
	key: string;
	status: "ok" | "sign_in_required" | "error";
	error?: string;
	/** The provider asked Pilot to wait (rate limit). Manual syncs respect it; ordinary error backoff they skip. */
	limited?: boolean;
	failures: number;
	nextPollAt: number;
};

/** Work that holds one of the shared source slots. */
export interface SourceSlot {
	controller: AbortController;
	promise: Promise<unknown>;
	startedAt: number;
	/** Set for work tied to one source configuration: a change of its key, or allowed() turning false, cancels it. */
	sourceId?: string;
	key?: string;
	allowed?: () => boolean;
}

/** What the scheduler gives the Slack and Linear adapters. */
export interface SourceScheduler {
	readonly items: TrackedItemStore;
	readonly projects: Pick<ProjectStore, "list" | "require" | "onChange">;
	readonly jobDiagnostics: BackgroundJobDiagnostics;
	/** Tracking is neither stopped nor paused for maintenance. */
	open(): boolean;
	/** A shared slot is free. */
	free(): boolean;
	slot(name: string): SourceSlot | undefined;
	/** Runs work in a new slot with a timeout. The slot frees itself when the work settles. */
	admit<T>(
		name: string,
		timeout: { ms: number; message: string },
		work: (signal: AbortSignal, slot: SourceSlot) => Promise<T>,
		guard?: Pick<SourceSlot, "sourceId" | "key" | "allowed">,
	): Promise<T>;
	currentKey(sourceId: string): string | undefined;
	health(sourceId: string): SourceHealth | undefined;
	failed(sourceId: string, key: string, error: unknown): void;
	/** A dedicated read tool. Write tools are refused. */
	read(kind: TrackedKind, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<TrackingJson>;
	write(kind: TrackedKind, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<TrackingJson>;
	sourcesChanged(projectId: string): void;
	jobConfigKey(projectId: string): string | undefined;
	/** A settings lookup. The latest one per kind wins, so typing in a search field never queues MCP work. */
	lookup<T>(
		kind: TrackedKind,
		work: (call: (tool: string, args: Record<string, unknown>) => Promise<TrackingJson>) => Promise<{
			items: T[];
			more: boolean;
		}>,
	): Promise<TrackingLookup<T>>;
}

/** Even a buggy adapter ignoring cancellation cannot keep a registry slot or commit stale results. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		// Observe failures even if work started on an already-cancelled signal.
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** One bounded line for the daemon log. Never message content: JSON syntax errors quote their input. */
export function logCause(error: unknown): string {
	if (error instanceof SlackFormatChanged) return `Slack response format changed (${error.reason})`;
	if (error instanceof SyntaxError) return "SyntaxError: invalid JSON";
	const text = error instanceof Error ? `${error.name}: ${error.message}` : `non-error ${typeof error}`;
	return text.replace(/\s+/g, " ").slice(0, 200);
}

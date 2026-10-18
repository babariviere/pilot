/** Disabled host-only session-to-vault adapter. Not constructed by SessionManager or any endpoint/tool. */
import { Worker } from "node:worker_threads";
import type { ReviewHistoryExport, ReviewHistoryPin } from "@pilot/kernel/review-history";
import { REVIEW_HISTORY_LIMITS } from "@pilot/kernel/review-history";
import type { CriticalReviewEvidence } from "@pilot/protocol";
import type { CriticalReviewVault, ReviewCapture, ReviewSelection } from "./critical-review-vault.ts";

export interface SessionHistorySelection {
	sourceId: string;
	sessionId: string;
	/** Canonical host-selected durable directory, never an agent argument. */
	directory: string;
	pin: ReviewHistoryPin;
	/** Resolved accepted host lineage only. Text, summaries and continuation request IDs cannot authorize it. */
	lineage:
		| { kind: "root" }
		| { kind: "unavailable" }
		| { kind: "continuation"; parentSourceId: string; hostAuthorizationId: string };
}
export interface SessionHistoryCapture extends Omit<ReviewCapture, "selections" | "sourceIds"> {
	/** Current checkpoint first, then explicitly authorized predecessors. Never followed from transcript text. */
	sources: SessionHistorySelection[];
}
export type SessionHistoryReport = Omit<ReviewHistoryExport, "chunks"> & {
	sourceId: string;
	sessionId: string;
	lineage: SessionHistorySelection["lineage"];
};
const opaque = /^[A-Za-z0-9_-]{1,128}$/;
const budget = {
	bytes: REVIEW_HISTORY_LIMITS.bytes - 256 * 1024,
	records: REVIEW_HISTORY_LIMITS.records,
	reads: REVIEW_HISTORY_LIMITS.reads,
	durationMs: REVIEW_HISTORY_LIMITS.durationMs,
};
let active = 0;

function validate(input: SessionHistoryCapture): void {
	if (
		!input.sources.length ||
		input.sources.length > 16 ||
		![input.id, input.projectId, input.hostId].every((id) => opaque.test(id))
	)
		throw new Error("Invalid session capture scope");
	const ids = new Set(input.sources.map((source) => source.sourceId));
	const sessions = new Set(input.sources.map((source) => source.sessionId));
	if (ids.size !== input.sources.length || sessions.size !== input.sources.length)
		throw new Error("Duplicate history source");
	for (const [index, source] of input.sources.entries()) {
		if (
			![source.sourceId, source.sessionId].every((id) => opaque.test(id)) ||
			typeof source.directory !== "string" ||
			source.directory.length > 4096 ||
			!Number.isSafeInteger(source.pin.attemptId) ||
			source.pin.attemptId < 1 ||
			!Number.isSafeInteger(source.pin.boundary) ||
			source.pin.boundary < 0
		)
			throw new Error("Invalid session checkpoint");
		const lineage = source.lineage;
		if (!lineage || !["root", "unavailable", "continuation"].includes(lineage.kind))
			throw new Error("Missing host lineage assertion");
		if (
			lineage.kind === "continuation" &&
			(!opaque.test(lineage.hostAuthorizationId) || input.sources[index + 1]?.sourceId !== lineage.parentSourceId)
		)
			throw new Error("Continuation source not explicitly selected in order");
		if (lineage.kind !== "continuation" && index !== input.sources.length - 1)
			throw new Error("Unlinked history selection");
	}
}

/** Synthetic/temporary callers only until authenticated capture integration is authorized. */
export async function captureSessionHistory(
	vault: CriticalReviewVault,
	request: SessionHistoryCapture,
	signal?: AbortSignal,
): Promise<CriticalReviewEvidence> {
	// Pin host assertions too: caller mutation during asynchronous acquisition cannot retarget a capture.
	const input = structuredClone(request);
	validate(input);
	signal?.throwIfAborted();
	if (active >= 2) throw new Error("Session capture busy");
	active++;
	const controller = new AbortController();
	const invalidate = () => controller.abort(new Error("Private capture invalidated"));
	const unsubscribe = vault.store.onPrivateInvalidation(invalidate);
	const abort = () => controller.abort(signal?.reason ?? new Error("Session capture cancelled"));
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("Session capture deadline")), budget.durationMs);
	let worker: Worker | undefined;
	try {
		worker = new Worker(new URL("./critical-review-session-worker.ts", import.meta.url), {
			workerData: { sources: input.sources, budget },
			resourceLimits: { maxOldGenerationSizeMb: 192 },
		});
		const exports = await new Promise<ReviewHistoryExport[]>((resolve, reject) => {
			const cancel = () => reject(new Error("Session capture cancelled or invalidated"));
			controller.signal.addEventListener("abort", cancel, { once: true });
			worker!.once("message", (value) => {
				controller.signal.removeEventListener("abort", cancel);
				resolve(value);
			});
			worker!.once("error", () => reject(new Error("History capture worker failed")));
			worker!.once("exit", () => reject(new Error("History capture worker exited before result")));
			if (controller.signal.aborted) cancel();
		});
		await worker.terminate();
		worker = undefined;
		controller.signal.throwIfAborted();
		const selections: ReviewSelection[] = [];
		const reports = exports.map(({ chunks, ...result }, index): SessionHistoryReport => {
			const source = input.sources[index]!;
			for (const [page, bytes] of chunks.entries())
				selections.push({
					selectionId: `history-${index}-${page}`,
					sourceId: source.sourceId,
					selected: true,
					label: `history/${index}/records-${page}.ndjson`,
					category: "transcript",
					bytes,
				});
			return { ...result, sourceId: source.sourceId, sessionId: source.sessionId, lineage: source.lineage };
		});
		// Reports are themselves immutable evidence. They explicitly prevent a clean/complete interpretation.
		for (const [index, report] of reports.entries()) {
			const bytes = Buffer.from(
				JSON.stringify({
					version: 1,
					...report,
					coverage: {
						retainedEntriesOnly: true,
						childHistory: "not_acquired",
						artifactContent: "not_acquired",
						originalInput: "recorded_evidence_or_unavailable",
						authorState: "not_mutated",
						crossStoreAtomic: false,
						submissions: "capture_revision_not_historical_checkpoint",
						authorizationFromText: false,
					},
				}),
			);
			if (bytes.length > 16 * 1024) throw new Error("History report limit");
			selections.push({
				selectionId: `history-report-${index}`,
				sourceId: report.sourceId,
				selected: true,
				label: `history/${index}/capture.json`,
				category: "transcript",
				bytes,
			});
			// This transcript-only slice deliberately does not acquire child/artifact contents or authenticate legacy origins.
			selections.push({
				selectionId: `history-gaps-${index}`,
				sourceId: report.sourceId,
				selected: false,
				label: `history/${index}/uncaptured-scope`,
				category: "transcript",
			});
		}
		controller.signal.throwIfAborted();
		const manifest = await vault.capture(
			{
				id: input.id,
				projectId: input.projectId,
				hostId: input.hostId,
				createdAt: input.createdAt,
				sourceIds: input.sources.map((source) => source.sourceId),
				knownSecrets: input.knownSecrets,
				selections,
			},
			controller.signal,
		);
		// Only the vault's redacted, revocation-aware reader releases report text.
		return manifest;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		unsubscribe();
		if (worker) await worker.terminate();
		active--;
	}
}

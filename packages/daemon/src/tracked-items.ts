/** SQLite lives on one worker. Dashboard reads use only five lightweight rows and counts per source. */
import { Worker } from "node:worker_threads";
import type {
	DashboardTrackedSource,
	LinearSizeCorrection,
	SlackCorrection,
	TrackedItem,
	TrackedItemList,
	TrackedItemPatch,
	TrackedKind,
	TriageCorrection,
	TriageGuide,
} from "@pilot/protocol";
import { NotFound, ServiceUnavailable } from "./errors.ts";
import type { SizeReservation } from "./linear-size.ts";
import type { CaseGroup, CaseInput } from "./slack-cases.ts";
import type { SlackClassification } from "./slack-classifier.ts";
import type {
	InboxQuery,
	InboxTracked,
	SlackAgentStatusResult,
	SlackCache,
	SlackGroupId,
	SlackPullRequestObservation,
	SlackReactionBatch,
	SlackReservation,
	SlackSearchQuery,
	SlackWaitingBatch,
	SourceCheckpoint,
	TrackedInput,
	TrackedQuery,
} from "./tracked-items-disk.ts";

export type { InboxQuery, InboxTracked, SourceCheckpoint, TrackedInput, TrackedQuery } from "./tracked-items-disk.ts";
export { validatePatch } from "./tracked-items-disk.ts";

type Snapshot = {
	projectId: string;
	kind: TrackedKind;
	preview: DashboardTrackedSource;
	checkpoint?: SourceCheckpoint;
	/** Inbox counts by effective label, kept with the preview so sidebar counts need no disk read. */
	inbox?: Record<string, number>;
};
export class TrackedItemStore {
	private readonly worker: Worker;
	private serial = 0;
	private stopped = false;
	private broken?: Error;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly snapshots = new Map<string, Snapshot>();
	private readonly listeners = new Set<(projectId: string) => void>();
	constructor(path: string) {
		this.worker = new Worker(new URL("./tracked-items-worker.ts", import.meta.url), { workerData: { path } });
		this.worker.on(
			"message",
			(reply: {
				id: number;
				value?: unknown;
				error?: string;
				notFound?: boolean;
				projectId?: string;
				/** Several projects changed by one request. */
				projectIds?: string[];
				snapshots?: Snapshot[];
			}) => {
				const pending = this.pending.get(reply.id);
				if (!pending) return;
				this.pending.delete(reply.id);
				for (const snapshot of reply.snapshots ?? [])
					this.snapshots.set(`${snapshot.projectId}:${snapshot.kind}`, snapshot);
				if (reply.error) pending.reject(reply.notFound ? new NotFound(reply.error) : new Error(reply.error));
				else pending.resolve(reply.value);
				if (!this.pending.size) this.worker.unref();
				if (reply.projectId) for (const listener of this.listeners) listener(reply.projectId);
				for (const projectId of reply.projectIds ?? []) for (const listener of this.listeners) listener(projectId);
			},
		);
		const fail = (error: Error) => {
			this.broken = error;
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", (code) => fail(new Error(`Tracking store exited (${code})`)));
		this.worker.unref();
	}
	async load(projectIds: string[]): Promise<void> {
		const snapshots = await this.rpc<Snapshot[]>("load", { projectIds });
		for (const snapshot of snapshots) this.snapshots.set(`${snapshot.projectId}:${snapshot.kind}`, snapshot);
	}
	/** Drop caches for removed projects; durable records remain recoverable on disk. */
	unload(projectId: string): void {
		this.snapshots.delete(`${projectId}:linear`);
		this.snapshots.delete(`${projectId}:slack`);
	}
	checkpoint(id: string): SourceCheckpoint | undefined {
		return structuredClone(this.snapshots.get(id)?.checkpoint);
	}
	preview(projectId: string, kind: TrackedKind): DashboardTrackedSource {
		return structuredClone(
			this.snapshots.get(`${projectId}:${kind}`)?.preview ?? {
				source: kind,
				label: kind === "linear" ? "Linear" : "Slack",
				status: "idle",
				total: 0,
				items: [],
			},
		);
	}
	list(query: TrackedQuery): Promise<TrackedItemList> {
		return this.rpc("list", query);
	}
	inbox(query: InboxQuery): Promise<InboxTracked> {
		return this.rpc("inbox", query);
	}
	/** Cached Inbox counts of a source by effective label ("" for none). */
	inboxCounts(projectId: string, kind: TrackedKind): Record<string, number> {
		return { ...this.snapshots.get(`${projectId}:${kind}`)?.inbox };
	}
	slackCached(channel: string, ts: string, projectId: string): Promise<SlackCache | undefined> {
		return this.rpc("slackCached", { channel, ts, projectId });
	}
	/** retry reclassifies a cached failure, for a message the user added by hand. */
	reserveSlack(channel: string, ts: string, now: number, projectId: string, retry = false): Promise<SlackReservation> {
		return this.rpc("reserveSlack", { channel, ts, now, projectId, retry });
	}
	finishSlack(channel: string, ts: string, result: SlackClassification | undefined, projectId: string): Promise<void> {
		return this.rpc("finishSlack", { channel, ts, result, projectId });
	}
	/** One read against the shared daily Slack budget. */
	reserveSlackRead(now: number): Promise<boolean> {
		return this.rpc("reserveSlackRead", { now });
	}
	/** Learned IDs of Slack group handles, shared by all projects. */
	slackGroups(handles: string[]): Promise<Record<string, SlackGroupId>> {
		return this.rpc("slackGroups", { handles });
	}
	saveSlackGroup(handle: string, id: string | null, now: number): Promise<void> {
		return this.rpc("saveSlackGroup", { handle, id, now });
	}
	corrections(projectId: string): Promise<SlackCorrection[]> {
		return this.rpc("corrections", { projectId });
	}
	/** The project's Linear size corrections, newest first (at most 500). */
	linearSizeCorrections(projectId: string): Promise<LinearSizeCorrection[]> {
		return this.rpc("corrections", { projectId, kind: "linear" });
	}
	triageContext(
		projectId: string,
		kind: TrackedKind,
	): Promise<{ guide: TriageGuide; corrections: TriageCorrection[] }> {
		return this.rpc("triageContext", { projectId, kind });
	}
	reserveGrooming(projectId: string, kind: TrackedKind, now: number): Promise<number> {
		return this.rpc("reserveGrooming", { projectId, kind, now });
	}
	caseInput(projectId: string, now: number): Promise<CaseInput> {
		return this.rpc("caseInput", { projectId, now });
	}
	commonCases(projectId: string, now = Date.now()): Promise<import("@pilot/protocol").SlackCommonCaseList> {
		return this.rpc("commonCases", { projectId, now });
	}
	saveCases(projectId: string, input: CaseInput, groups: CaseGroup[], now: number): Promise<void> {
		return this.rpc("saveCases", { projectId, input, groups, now });
	}
	editCase(
		projectId: string,
		caseId: string,
		edit: import("@pilot/protocol").SlackCaseEdit,
		now = Date.now(),
	): Promise<void> {
		return this.rpc("editCase", { projectId, caseId, edit, now });
	}
	reserveLinearSize(projectId: string, externalId: string, version: number, now: number): Promise<SizeReservation> {
		return this.rpc("reserveLinearSize", { projectId, externalId, version, now });
	}
	finishLinearSize(
		projectId: string,
		externalId: string,
		version: number,
		size: import("@pilot/protocol").LinearSize,
	): Promise<void> {
		return this.rpc("finishLinearSize", { projectId, externalId, version, size });
	}
	triageInput(
		projectId: string,
		kind: TrackedKind,
	): Promise<{ guide: TriageGuide; corrections: TriageCorrection[]; throughSeq: number }> {
		return this.rpc("triageInput", { projectId, kind });
	}
	saveGuide(
		projectId: string,
		kind: TrackedKind,
		text: string,
		throughSeq: number,
		expectedSeq: number,
		now: number,
	): Promise<void> {
		return this.rpc("saveGuide", { projectId, kind, text, throughSeq, expectedSeq, now });
	}
	/** Sets each project's close labels and applies them to its stored Slack messages: label-closed ones reopen when
	 * their label no longer closes, open ones without a user status close. Snapshots and listeners follow. */
	async slackLabelEffects(entries: Array<{ projectId: string; close: string[] }>): Promise<void> {
		const result = await this.rpc<{ error: string } | undefined>("slackLabelEffects", { entries });
		if (result?.error) throw new Error(result.error);
	}
	require(id: string): Promise<TrackedItem> {
		return this.rpc("require", { id });
	}
	requireExternal(projectId: string, kind: TrackedKind, externalId: string): Promise<TrackedItem> {
		return this.rpc("requireExternal", { projectId, kind, externalId });
	}
	searchSlack(query: SlackSearchQuery): Promise<TrackedItemList> {
		return this.rpc("searchSlack", query);
	}
	commit(
		projectId: string,
		kind: TrackedKind,
		items: TrackedInput[],
		checkpoint?: SourceCheckpoint,
		activeIds?: string[],
	): Promise<void> {
		return this.rpc("commit", { projectId, kind, items, checkpoint, activeIds });
	}
	linearStartResult(id: string, outcome: "moved" | "skipped" | "error"): Promise<void> {
		return this.rpc("linearStartResult", { id, outcome });
	}
	reserveSlackStart(id: string): Promise<boolean> {
		return this.rpc("reserveSlackStart", { id });
	}
	slackStartResult(id: string, outcome: "reacted" | "skipped" | "error"): Promise<void> {
		return this.rpc("slackStartResult", { id, outcome });
	}
	reserveSlackReactions(projectId: string, now: number, recheckMs?: number): Promise<SlackReactionBatch> {
		return this.rpc("reserveSlackReactions", { projectId, now, recheckMs });
	}
	recordSlackReaction(id: string, present: boolean, version: number): Promise<void> {
		return this.rpc("recordSlackReaction", { id, present, version });
	}
	reserveSlackWaiting(projectId: string, now: number): Promise<SlackWaitingBatch> {
		return this.rpc("reserveSlackWaiting", { projectId, now });
	}
	slackWaitingResult(
		id: string,
		since: number,
		result: { status?: "in_progress" | "open"; afterTs?: string },
	): Promise<boolean> {
		return this.rpc("slackWaitingResult", { id, since, result });
	}
	/** Which of these chats are the latest chat of one of the project's Slack messages. */
	slackLinkedSessions(projectId: string, sessionIds: string[]): Promise<string[]> {
		return this.rpc("slackLinkedSessions", { projectId, sessionIds });
	}
	/** A chat's slack_status tool call. Applies only to Slack messages whose latest chat it is. */
	agentSlackStatus(
		sessionId: string,
		status: "waiting" | "in_progress",
		reason?: string,
	): Promise<SlackAgentStatusResult> {
		return this.rpc("agentSlackStatus", { sessionId, status, reason });
	}
	reserveSlackDone(projectId: string): Promise<TrackedItem | undefined> {
		return this.rpc("reserveSlackDone", { projectId });
	}
	slackDoneResult(id: string, outcome: "reacted" | "skipped" | "error"): Promise<void> {
		return this.rpc("slackDoneResult", { id, outcome });
	}
	patch(id: string, patch: TrackedItemPatch): Promise<TrackedItem> {
		return this.rpc("patch", { id, patch });
	}
	observeSlackPullRequests(observation: SlackPullRequestObservation): Promise<void> {
		return this.rpc("observeSlackPullRequests", observation);
	}
	completeSlackMission(projectId: string, missionId: string, completedAt: number): Promise<void> {
		return this.rpc("completeSlackMission", { projectId, missionId, completedAt });
	}
	/** Show only Slack items of configured channels (by ID, or by name in older configs). */
	retainSlack(projectId: string, channels: string[]): Promise<void> {
		return this.rpc("retainSlack", { projectId, channels });
	}
	onChange(listener: (projectId: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async close(): Promise<void> {
		if (this.stopped) return;
		await this.rpc("close", {});
		this.stopped = true;
		this.listeners.clear();
		this.snapshots.clear();
	}
	private rpc<T>(method: string, args: unknown): Promise<T> {
		if (this.stopped || this.broken)
			return Promise.reject(this.broken ?? new ServiceUnavailable("Tracking store closed"));
		if (this.pending.size >= 64) return Promise.reject(new ServiceUnavailable("Tracking store busy, retry shortly"));
		return new Promise((resolve, reject) => {
			const id = ++this.serial;
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			this.worker.ref();
			try {
				this.worker.postMessage({ id, method, args });
			} catch (error) {
				this.pending.delete(id);
				reject(error);
				if (!this.pending.size) this.worker.unref();
			}
		});
	}
}

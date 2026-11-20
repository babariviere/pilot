/** The tracking store's operations. Each runs on the store's worker; TrackedItemStore forwards it by name. */
import type {
	DashboardTrackedSource,
	LinearSize,
	SlackCaseEdit,
	TrackedItem,
	TrackedItemPatch,
	TrackedKind,
} from "@pilot/protocol";
import type { CaseGroup, CaseInput } from "../slack/slack-cases.ts";
import type { SlackClassification } from "../slack/slack-classifier.ts";
import { editSlackReport, readSlackReports } from "../slack/slack-reports-disk.ts";
import { SOURCE_KINDS, sourceId } from "../source-kinds.ts";
import type {
	InboxQuery,
	SlackAgentStatus,
	SlackSearchQuery,
	SourceCheckpoint,
	TrackedInput,
	TrackedItemDisk,
	TrackedQuery,
} from "./tracked-items-disk.ts";

/** What the daemon thread keeps per source, so dashboards and counts need no disk read. */
export interface TrackedSourceSnapshot {
	projectId: string;
	kind: TrackedKind;
	preview: DashboardTrackedSource;
	checkpoint?: SourceCheckpoint;
	/** Inbox counts by effective label. */
	inbox?: Record<string, number>;
}

export interface TrackedItemOpContext {
	disk: TrackedItemDisk;
	/** The project's items changed: listeners hear it and its snapshots are sent again. */
	changed(projectId: string): void;
	/** Only the project's snapshots are sent again, for example after a checkpoint. */
	refreshed(projectId: string): void;
}

export function sourceSnapshots(disk: TrackedItemDisk, projectId: string): TrackedSourceSnapshot[] {
	return SOURCE_KINDS.map((kind) => ({
		projectId,
		kind,
		preview: disk.preview(projectId, kind),
		checkpoint: disk.checkpoint(sourceId(projectId, kind)),
		inbox: disk.inboxCounts(projectId, kind),
	}));
}

type Context = TrackedItemOpContext;

export const trackedItemOps = {
	load({ refreshed }: Context, projectIds: string[]): void {
		for (const projectId of projectIds) refreshed(projectId);
	},
	list: ({ disk }: Context, query: TrackedQuery) => disk.list(query),
	intake: ({ disk }: Context, projectId: string) => disk.intake(projectId),
	intakeWrite: (
		{ disk }: Context,
		projectId: string,
		id: string,
		revision: number,
		state?: TrackedItem["triageState"],
		operationId?: string,
	) => disk.intakeWrite(projectId, id, revision, state, operationId),
	inbox: ({ disk }: Context, query: InboxQuery) => disk.inbox(query),
	slackCached: ({ disk }: Context, channel: string, ts: string, projectId: string) =>
		disk.slackCached(channel, ts, projectId),
	/** retry reclassifies a cached failure, for a message the user added by hand. */
	reserveSlack: ({ disk }: Context, channel: string, ts: string, projectId: string, retry = false) =>
		disk.reserveSlack(channel, ts, projectId, retry),
	finishSlack: (
		{ disk }: Context,
		channel: string,
		ts: string,
		result: SlackClassification | undefined,
		projectId: string,
	) => disk.finishSlack(channel, ts, result, projectId),
	slackGroups: ({ disk }: Context, handles: string[]) => disk.slackGroups(handles),
	saveSlackGroup: ({ disk }: Context, handle: string, id: string | null, now: number) =>
		disk.saveSlackGroup(handle, id, now),
	corrections: ({ disk }: Context, projectId: string) => disk.corrections(projectId),
	/** Newest first, at most 500. */
	linearSizeCorrections: ({ disk }: Context, projectId: string) => disk.triage.corrections(projectId, "linear"),
	triageContext: ({ disk }: Context, projectId: string, kind: TrackedKind) => disk.triage.context(projectId, kind),
	reserveGrooming: ({ disk }: Context, projectId: string, kind: TrackedKind, now: number) =>
		disk.triage.reserve(projectId, kind, now),
	triageInput: ({ disk }: Context, projectId: string, kind: TrackedKind) => disk.triage.input(projectId, kind),
	saveGuide(
		{ disk, changed }: Context,
		projectId: string,
		kind: TrackedKind,
		text: string,
		throughSeq: number,
		expectedSeq: number,
		now: number,
	): void {
		disk.triage.save(projectId, kind, text, throughSeq, expectedSeq, now);
		changed(projectId);
	},
	caseInput({ disk, changed }: Context, projectId: string, now: number): CaseInput {
		if (disk.cases.retire(projectId, now)) changed(projectId);
		return disk.cases.input(projectId, now);
	},
	commonCases: ({ disk }: Context, projectId: string, now = Date.now()) => disk.cases.list(projectId, now),
	saveCases({ disk, changed }: Context, projectId: string, input: CaseInput, groups: CaseGroup[], now: number): void {
		if (disk.cases.save(projectId, input, groups, now)) changed(projectId);
	},
	editCase(
		{ disk, changed }: Context,
		projectId: string,
		caseId: string,
		edit: SlackCaseEdit,
		now = Date.now(),
	): void {
		disk.cases.edit(projectId, caseId, edit, now);
		changed(projectId);
	},
	slackReports: ({ disk }: Context, projectId: string, offset = 0) => readSlackReports(disk, projectId, offset),
	editSlackReport(
		{ disk, changed }: Context,
		projectId: string,
		digest: string,
		action: string,
		value: unknown,
	): TrackedItem | undefined {
		const result = editSlackReport(disk, projectId, digest, action, value);
		changed(projectId);
		return result;
	},
	reserveLinearSize: ({ disk }: Context, projectId: string, externalId: string, version: number) =>
		disk.sizes.reserve(projectId, externalId, version),
	finishLinearSize: ({ disk }: Context, projectId: string, externalId: string, version: number, size: LinearSize) =>
		disk.sizes.finish(projectId, externalId, version, size),
	/** Every project's effects in one request, so startup never goes over the store's request limit. */
	slackLabelEffects({ disk }: Context, entries: Array<{ projectId: string; close: string[] }>): void {
		let failure: unknown;
		for (const entry of entries)
			try {
				disk.slackLabelEffects(entry.projectId, entry.close);
			} catch (error) {
				failure ??= error;
			}
		if (failure) throw failure;
	},
	require: ({ disk }: Context, id: string) => disk.require(id),
	requireExternal: ({ disk }: Context, projectId: string, kind: TrackedKind, externalId: string) =>
		disk.requireExternal(projectId, kind, externalId),
	searchSlack: ({ disk }: Context, query: SlackSearchQuery) => disk.searchSlack(query),
	commit(
		{ disk, refreshed }: Context,
		projectId: string,
		kind: TrackedKind,
		items: TrackedInput[],
		checkpoint?: SourceCheckpoint,
		activeIds?: string[],
	): void {
		disk.commit(projectId, kind, items, checkpoint, activeIds);
		refreshed(projectId);
	},
	linearStartResult: ({ disk }: Context, id: string, outcome: "moved" | "skipped" | "error") =>
		disk.linearStartResult(id, outcome),
	reserveSlackStart: ({ disk }: Context, id: string) => disk.reserveSlackStart(id),
	slackStartResult: ({ disk }: Context, id: string, outcome: "reacted" | "skipped" | "error") =>
		disk.slackStartResult(id, outcome),
	reserveSlackWaiting: ({ disk }: Context, projectId: string, now: number) => disk.reserveSlackWaiting(projectId, now),
	slackWaitingResult: (
		{ disk }: Context,
		id: string,
		since: number,
		result: { status?: "in_progress" | "open"; afterTs?: string },
	) => disk.slackWaitingResult(id, since, result),
	slackLinkedSessions: ({ disk }: Context, projectId: string, sessionIds: string[]) =>
		disk.slackLinkedSessions(projectId, sessionIds),
	startedChats: ({ disk }: Context) => disk.startedChats(),
	sessionSources: ({ disk }: Context, projectId: string) => disk.sessionSources(projectId),
	agentSlackStatus: ({ disk }: Context, sessionId: string, status: SlackAgentStatus, reason?: string) =>
		disk.agentSlackStatus(sessionId, status, reason),
	patch: ({ disk }: Context, id: string, patch: TrackedItemPatch, intakeOperationId?: string) =>
		disk.patch(id, patch, intakeOperationId),
	retainSlack: ({ disk }: Context, projectId: string, channels: string[]) => disk.retainSlack(projectId, channels),
};

export type TrackedItemOps = typeof trackedItemOps;

export type TrackedItemMethod = keyof TrackedItemOps;
export type TrackedItemArgs<K extends TrackedItemMethod> = TrackedItemOps[K] extends (
	context: Context,
	...args: infer A
) => unknown
	? A
	: never;
export type TrackedItemReply =
	| { id: number; ok: true; value?: unknown; changed?: string[]; snapshots?: TrackedSourceSnapshot[] }
	| { id: number; ok: false; message: string; code?: "not_found" };

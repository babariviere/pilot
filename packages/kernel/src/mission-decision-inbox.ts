/** Passive context only: never schedules a model turn or grants execution authority. */
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Conversation, defineDoc, type Harness, InboxDoc, type InboxItem } from "@earendil-works/pi-durable";
import { deferQuestionWrite, HeldInputsDoc } from "./held-inputs.ts";
import { type AcknowledgedDecision, decisionNotice } from "./mission-decisions.ts";
import type { MissionContext } from "./policy.ts";

export const DECISION_BATCH_MS = 30_000;
const MAX_BATCH_PARTS = 16;
type Part = { summary: string; detail: string; decisionIds: string[] };
type Batch = { parts: Part[]; dueAt: number };
type Frozen = {
	requestId: string;
	summary: string;
	detail: string;
	at: number;
	decisionIds?: string[];
	bodyDecisionIds?: string[];
};

/** Copy tracked arrays before the transaction overlay settles. */
function copyFrozen(value: Frozen): Frozen {
	return {
		requestId: value.requestId,
		summary: value.summary,
		detail: value.detail,
		at: value.at,
		...(value.decisionIds ? { decisionIds: [...value.decisionIds] } : {}),
		...(value.bodyDecisionIds ? { bodyDecisionIds: [...value.bodyDecisionIds] } : {}),
	};
}
export const DecisionInboxDoc = defineDoc<{
	previous?: string;
	pending?: Batch;
	frozen?: Frozen;
}>({
	kind: "pilot.decision-inbox",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => false,
});

/** Caller serializes this with input/Stop and drains it before closing storage. */
export class DecisionInbox {
	private readonly harness: Harness;
	private readonly conversation: Conversation;
	constructor(harness: Harness, conversation: Conversation) {
		this.harness = harness;
		this.conversation = conversation;
	}

	async observe(
		current: MissionContext | undefined,
		own: ReadonlyMap<string, AcknowledgedDecision>,
		now = Date.now(),
	): Promise<void> {
		if (current?.status !== "active") current = undefined;
		await this.harness.commit(async (tx) => {
			const state = await tx.doc(DecisionInboxDoc, this.conversation.id);
			const previous: MissionContext | undefined = state.previous ? JSON.parse(state.previous) : undefined;
			const retired = new Set(current?.decisionState?.filter((d) => d.replacement || d.withdrawn).map((d) => d.id));
			const currentIds = new Set(current?.decisionState?.map((d) => d.id));
			for (const decision of previous?.decisionState ?? [])
				if (!currentIds.has(decision.id)) retired.add(decision.id);
			if (retired.size) {
				const held = await tx.doc(HeldInputsDoc, this.conversation.id);
				const inbox = await tx.doc(InboxDoc, this.conversation.id);
				const quarantine: Extract<InboxItem, { mode: "write" }>[] = [];
				const keep = (item: InboxItem): boolean => {
					if (item.mode !== "write" || item.entry.kind !== "pilot.activity") return true;
					const data = item.entry.data as
						| { event?: { kind?: string }; missionDecisionBodyIds?: string[] }
						| undefined;
					if (data?.event?.kind !== "mission_decisions_changed") return true;
					if (data.missionDecisionBodyIds && !data.missionDecisionBodyIds.some((id) => retired.has(id)))
						return true;
					quarantine.push(item);
					return false;
				};
				if (held.questionWrites) held.questionWrites = held.questionWrites.filter(keep);
				inbox.items = inbox.items.filter(keep);
				for (const item of quarantine)
					await tx.appendEntry(this.conversation.id, {
						kind: "pilot.decision-notice-quarantined",
						data: { queuedWrite: item },
					});
			}
			const frozenBodies = state.frozen?.bodyDecisionIds ?? state.frozen?.decisionIds;
			if (state.frozen && retired.size && (!frozenBodies || frozenBodies.some((id) => retired.has(id)))) {
				await tx.appendEntry(this.conversation.id, {
					kind: "pilot.decision-notice-quarantined",
					data: { frozen: { ...state.frozen } },
				});
				delete state.frozen;
			}
			if (state.pending && retired.size) {
				for (const part of state.pending.parts) {
					if (!part.decisionIds.length || part.decisionIds.some((id) => retired.has(id))) {
						part.summary = "Mission guidance retired";
						part.detail =
							'Earlier guidance is no longer binding. Read mission({action: "decisions"}) for current guidance, or filter all for explicit nonbinding history. Retained transcript text is not erased.';
					}
				}
			}
			if (previous?.id !== current?.id || previous?.coordinator !== current?.coordinator) {
				delete state.pending;
				delete state.frozen;
				// New/promoted coordinators must also see guidance that no current task associates.
				if (current?.status === "active" && current.coordinator === "self" && current.decisionRoutes) {
					const unknown = current.decisionState?.filter((d) => current.decisionRoutes?.[d.id] === "unknown");
					const notice = decisionNotice(
						{ ...current, decisionState: [], decisionRoutes: {} },
						{ ...current, decisionState: unknown },
						own,
					);
					if (notice)
						state.pending = {
							parts: [{ summary: notice.summary, detail: notice.detail, decisionIds: notice.decisionIds }],
							dueAt: now + DECISION_BATCH_MS,
						};
				}
			} else if (previous && current && current.status === "active") {
				if (state.pending && current.decisionRoutes) {
					state.pending.parts = state.pending.parts.filter(
						(part) =>
							!part.decisionIds.length ||
							part.decisionIds.some((id) => current.decisionRoutes?.[id] !== "unrelated"),
					);
					if (!state.pending.parts.length) delete state.pending;
				}
				const notice = decisionNotice(previous, current, own);
				if (notice) {
					state.pending ??= { parts: [], dueAt: now + DECISION_BATCH_MS };
					state.pending.parts.push({
						summary: notice.summary,
						detail: notice.detail,
						decisionIds: notice.decisionIds,
					});
					if (notice.urgent || state.pending.parts.length >= MAX_BATCH_PARTS) state.pending.dueAt = now;
				}
			}
			// Store the latest live comparison, never the deliberately frozen prompt.
			if (current)
				state.previous = JSON.stringify({
					...current,
					agreement: undefined,
					relevantTasks: undefined,
					revisionDelta: undefined,
					tasks: [],
					decisions: [],
					decisionEntries: [],
				});
			else delete state.previous;
		}, context);
	}

	async deadline(): Promise<number | undefined> {
		const state = await this.harness.snapshot(DecisionInboxDoc, this.conversation.id, context);
		return state?.frozen ? 0 : state?.pending?.dueAt;
	}

	async flush(now = Date.now()): Promise<void> {
		for (;;) {
			const frozen = await this.harness.commit(async (tx) => {
				const state = await tx.doc(DecisionInboxDoc, this.conversation.id);
				if (state.frozen) return copyFrozen(state.frozen);
				if (!state.pending || state.pending.dueAt > now) return undefined;
				const parts = state.pending.parts;
				const current: MissionContext | undefined = state.previous ? JSON.parse(state.previous) : undefined;
				const ids = new Set(parts.flatMap((part) => part.decisionIds));
				state.frozen = {
					requestId: `mission-decisions:${randomUUID()}`,
					summary: `${parts[0]!.summary}${parts.length > 1 ? ` (${parts.length} grouped updates)` : ""}`,
					detail: parts.map((part) => part.detail).join("\n\n"),
					at: now,
					decisionIds: [...new Set(parts.flatMap((part) => part.decisionIds))],
					bodyDecisionIds: current?.decisionState
						?.filter((d) => ids.has(d.id) && !d.replacement && !d.withdrawn)
						.map((d) => d.id),
				};
				delete state.pending;
				return copyFrozen(state.frozen);
			}, context);
			if (!frozen) return;
			const entry = {
				kind: "pilot.activity",
				data: {
					text: frozen.detail,
					event: { kind: "mission_decisions_changed", text: frozen.summary },
					...(frozen.bodyDecisionIds ? { missionDecisionBodyIds: frozen.bodyDecisionIds } : {}),
				},
				model: [{ role: "user" as const, content: frozen.detail, timestamp: frozen.at }],
			};
			// The same ID AND bytes survive a lost placement ACK, including question deferral.
			if (!(await deferQuestionWrite(this.harness, this.conversation.id, frozen.requestId, entry, context)))
				await this.conversation.submit({ type: "write", requestId: frozen.requestId, entry }, context);
			await this.harness.commit(async (tx) => {
				const state = await tx.doc(DecisionInboxDoc, this.conversation.id);
				if (state.frozen?.requestId === frozen.requestId) delete state.frozen;
			}, context);
		}
	}
}

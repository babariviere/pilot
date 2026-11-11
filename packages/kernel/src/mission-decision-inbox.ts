/** Passive context only: never schedules a model turn or grants execution authority. */
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Conversation, defineDoc, type Harness } from "@earendil-works/pi-durable";
import { deferQuestionWrite } from "./held-inputs.ts";
import { type AcknowledgedDecision, decisionNotice } from "./mission-decisions.ts";
import type { MissionContext } from "./policy.ts";

export const DECISION_BATCH_MS = 30_000;
const MAX_BATCH_PARTS = 16;
type Part = { summary: string; detail: string; decisionIds: string[] };
type Batch = { parts: Part[]; dueAt: number };
type Frozen = { requestId: string; summary: string; detail: string; at: number };
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
			if (current) state.previous = JSON.stringify({ ...current, tasks: [], decisions: [], decisionEntries: [] });
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
				if (state.frozen) return { ...state.frozen };
				if (!state.pending || state.pending.dueAt > now) return undefined;
				const parts = state.pending.parts;
				state.frozen = {
					requestId: `mission-decisions:${randomUUID()}`,
					summary: `${parts[0]!.summary}${parts.length > 1 ? ` (${parts.length} grouped updates)` : ""}`,
					detail: parts.map((part) => part.detail).join("\n\n"),
					at: now,
				};
				delete state.pending;
				return { ...state.frozen };
			}, context);
			if (!frozen) return;
			const entry = {
				kind: "pilot.activity",
				data: { text: frozen.detail, event: { kind: "mission_decisions_changed", text: frozen.summary } },
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

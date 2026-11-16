import { inputOrigin } from "@pilot/kernel";
import type { EntryRecord } from "@pilot/protocol";
import type {
	MissionThread,
	MissionThreadConversation,
	MissionThreadInputCausality,
} from "../../protocol/src/mission-thread.ts";

/** Exact carrier membership from a saved planning operation, never its rendered prompt. */
export function threadBatch(entry: EntryRecord): { operationId: string; inputIds: string[] } | undefined {
	const data = entry.data;
	if (
		entry.kind !== "pilot.planning-input" ||
		!data ||
		typeof data !== "object" ||
		Array.isArray(data) ||
		typeof data.operation !== "string"
	)
		return;
	try {
		const op = JSON.parse(data.operation);
		const ids: unknown = JSON.parse(op.payload ?? "{}").operationIds;
		if (
			op.kind === "plan-thread-messages" &&
			typeof op.operationId === "string" &&
			Array.isArray(ids) &&
			ids.every((id) => typeof id === "string")
		)
			return { operationId: op.operationId, inputIds: ids };
	} catch {
		/* A malformed carrier remains unlinked activity. */
	}
}

/** Only explicit original links or ownership of a dedicated chat establish topic membership. */
export function threadConversationEntries(
	topic: MissionThread,
	sessionId: string,
	entries: readonly EntryRecord[],
	chat: boolean,
	pending: ReadonlySet<string>,
	causality: readonly MissionThreadInputCausality[] = [],
	sends: ReadonlyMap<string, string> = new Map(),
	carriers: ReadonlyMap<string, readonly string[]> = new Map(),
): MissionThreadConversation["entries"] {
	return entries
		.flatMap((entry) => {
			let operation: { operationId?: string; kind?: string; payload?: string } = {};
			if (entry.kind === "pilot.planning-input") {
				const data = entry.data;
				if (data && typeof data === "object" && !Array.isArray(data) && typeof data.operation === "string") {
					try {
						operation = JSON.parse(data.operation);
					} catch {
						/* Unlinked activity. */
					}
				}
			}
			const input = topic.inputs.some((i) => i.operationId === operation.operationId && i.sessionId === sessionId);
			const explicitInput =
				input ||
				causality.some(
					(c) => c.entryId === Number(entry.id) && topic.inputs.some((i) => i.operationId === c.requestId),
				);
			if (entry.kind === "pi.user" && "origin" in entry && entry.origin && !explicitInput) return [];
			if (
				chat &&
				entry.kind === "pi.assistant" &&
				!causality.some((c) => c.answerId === Number(entry.id) && !inputOrigin(c.requestId))
			)
				return [];
			const linked = topic.references.some(
				(r) => r.kind === "history" && r.sessionId === sessionId && r.entryId === entry.id,
			);
			let carried = carriers.get(operation.operationId ?? "") ?? [];
			if (operation.kind === "plan-thread-messages") {
				try {
					const ids: unknown = JSON.parse(operation.payload ?? "{}").operationIds;
					if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) carried = ids;
				} catch {
					/* Malformed activity has no topic association. */
				}
			}
			const batch = [...new Set(carried)].filter(
				(id) => sends.has(id) && topic.inputs.some((i) => i.operationId === id && i.sessionId === sessionId),
			);
			if (!chat && batch.length) {
				return batch.map((operationId) => ({
					id: Number(entry.id),
					operationId,
					sessionId,
					role: "you" as const,
					text: sends.get(operationId)!,
					shared: false,
					timestamp: entry.model?.find((m) => typeof m.timestamp === "number")?.timestamp ?? null,
					replyState: pending.has(operationId) ? ("pending" as const) : ("unknown" as const),
					original: { kind: "history" as const, sessionId, entryId: Number(entry.id) },
				}));
			}
			const answer = causality.some(
				(c) =>
					!inputOrigin(c.requestId) &&
					c.answerId === Number(entry.id) &&
					topic.inputs.some(
						(i) =>
							i.operationId === c.requestId || (carriers.get(c.requestId ?? "") ?? []).includes(i.operationId),
					),
			);
			if (!chat && !linked && !input && !answer) return [];
			let role: "you" | "chat" | "coordinator";
			let text: string;
			if (input && operation.kind === "thread-send") {
				try {
					const payload = JSON.parse(operation.payload ?? "{}");
					if (payload.topicId !== topic.id || typeof payload.text !== "string") return [];
					text = payload.text;
				} catch {
					return [];
				}
				role = "you";
			} else {
				if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") return [];
				role = entry.kind === "pi.user" ? "you" : chat ? "chat" : "coordinator";
				text = (entry.model ?? [])
					.filter((m) => m.role === (role === "you" ? "user" : "assistant"))
					.flatMap((m) =>
						typeof m.content === "string"
							? [m.content]
							: m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])),
					)
					.join("\n\n");
			}
			if (!text) return [];
			const timestamp = entry.model?.find((m) => typeof m.timestamp === "number")?.timestamp ?? null;
			const causal = causality.find((c) => c.entryId === Number(entry.id));
			const originalOperation = input
				? operation.operationId
				: causal?.requestId && topic.inputs.some((i) => i.operationId === causal.requestId)
					? causal.requestId
					: undefined;
			const replyState =
				operation.operationId && pending.has(operation.operationId)
					? ("pending" as const)
					: chat && role === "you" && causal
						? ({ queued: "pending", placed: "awaiting", done: "answered", unanswered: "unanswered" } as const)[
								causal.status
							]
						: ("unknown" as const);
			return [
				{
					id: Number(entry.id),
					...(originalOperation ? { operationId: originalOperation } : {}),
					sessionId,
					role,
					text,
					shared: !chat && role === "coordinator",
					timestamp,
					replyState,
					original: { kind: "history" as const, sessionId, entryId: Number(entry.id) },
				},
			];
		})
		.sort((a, b) => a.id - b.id);
}

/** Presentation metadata only. Compaction and its model summary remain owned by the Harness. */
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
	CompactionTask,
	defineDoc,
	hook,
	type EntryRecord,
	type Extension,
	type Session,
	type Harness,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { AgentEvent } from "@pilot/protocol";

export const CompactionStatsDoc = defineDoc<{
	items: { firstKept: number; before: number; kept: number; at: number }[];
}>({
	kind: "pilot.compaction-stats",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

function tokens(entries: readonly EntryRecord[]): number {
	return entries.reduce(
		(sum, entry) => sum + (entry.model ?? []).reduce((sum, message) => sum + estimateTokens(message), 0),
		0,
	);
}

export function compactionEvents(extension: Extension, session: () => Harness | undefined): Extension {
	return {
		...extension,
		hooks: [
			...(extension.hooks ?? []),
			hook(CompactionTask, {
				beforeCompact: async (compaction, api, context) => {
					const host = session();
					if (!host) return;
					const conversation = await host.conversation(api.conversationId, context);
					if (!conversation) return;
					const view = await conversation.context(context);
					const kept = tokens(view.entries.filter((entry) => Number(entry.id) >= Number(compaction.firstKept)));
					await host.commit(async (tx) => {
						const state = await tx.doc(CompactionStatsDoc);
						state.items.push({
							firstKept: Number(compaction.firstKept),
							before: tokens(view.entries),
							kept,
							at: Date.now(),
						});
						state.items.splice(0, Math.max(0, state.items.length - 200));
					}, context);
				},
			}),
		],
	};
}

export async function chatEventEntries(
	session: Pick<Session, "snapshot">,
	entries: readonly EntryRecord[],
	context: Context,
): Promise<EntryRecord[]> {
	if (!entries.some((entry) => entry.kind === "pi.compaction")) return [...entries];
	const stats = await session.snapshot(CompactionStatsDoc, context);
	return entries.map((entry) => {
		if (entry.kind !== "pi.compaction") return entry;
		const timestamp = entry.model?.[0]?.timestamp;
		const stat = stats?.items.findLast(
			(item) => item.firstKept === Number(entry.head) && (timestamp === undefined || item.at <= timestamp),
		);
		if (!stat) return entry;
		return {
			...entry,
			data: {
				...(typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data) ? entry.data : {}),
				tokensBefore: stat.before,
				tokensAfter: stat.kept + tokens([entry]),
				tokensEstimated: true,
			},
		};
	});
}

export async function chatEvents(
	session: Pick<Session, "snapshot">,
	events: readonly AgentEvent[],
	context: Context,
): Promise<AgentEvent[]> {
	return Promise.all(
		events.map(async (event) => {
			if (event.type === "snapshot")
				return { ...event, entries: await chatEventEntries(session, event.entries, context) };
			if (event.type === "entry_appended" && event.entry.kind === "pi.compaction")
				return { ...event, entry: (await chatEventEntries(session, [event.entry], context))[0]! };
			return event;
		}),
	);
}

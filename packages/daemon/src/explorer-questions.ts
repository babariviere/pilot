/** When a research or prototype (explorer) chat's question stops needing the user. Reading changes nothing. */
import type { MissionStore } from "./missions.ts";

/**
 * A chat Pilot started for a map question (a research or prototype explorer), or undefined for any other chat.
 * `settled`: its question is moot, because its plan is published, its map question is resolved, or a newer explorer
 * chat for that question took over. The chat and its history stay; the user can still open it.
 */
export function explorerQuestion(
	store: Pick<MissionStore, "planningWorkers" | "plans" | "membership">,
	session: { id: string; title: string },
): { settled: boolean } | undefined {
	const member = store.membership(session.id);
	if (member?.role !== "explorer") return undefined;
	const state = store.planningWorkers.get(member.missionId);
	if (!state) return undefined;
	const plan = store.plans.get(member.missionId);
	const research = state.research ?? {};
	let questionId = Object.keys(research).find(
		(id) => research[id]!.sessionId === session.id || research[id]!.earlierSessionIds?.includes(session.id),
	);
	// Chats started before Pilot kept earlier attempts: the title Pilot gave the chat names its question.
	questionId ??= plan?.questions.find(
		(q) =>
			session.title === `Research: ${q.title}`.slice(0, 200) ||
			session.title.startsWith(`Prototype: ${q.title} (about $`.slice(0, 200)),
	)?.id;
	if (questionId === undefined) return undefined;
	if (plan?.publication || plan?.questions.find((q) => q.id === questionId)?.resolution) return { settled: true };
	const current = research[questionId]?.sessionId;
	return { settled: !!current && current !== session.id };
}

/** True when an explorer chat's question is moot (see explorerQuestion). False for every other chat. */
export function explorerQuestionSettled(
	store: Pick<MissionStore, "planningWorkers" | "plans" | "membership">,
	session: { id: string; title: string },
): boolean {
	return explorerQuestion(store, session)?.settled === true;
}

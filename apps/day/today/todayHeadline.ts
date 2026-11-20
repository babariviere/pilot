import type { Today } from "pilot-day/native";

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const word = (n: number) => WORDS[n] ?? String(n);

/** Count the rows actually read, not a coordinator's headline or a saved aggregate. */
export function attentionCounts(today: Pick<Today, "decisions" | "actions" | "problems">) {
	const questions = new Set(today.decisions.map((d) => d.requestSessionId).filter(Boolean));
	const problems = today.problems.filter((p) => !p.sessionId || !questions.has(p.sessionId));
	const stopped = problems.filter((p) => p.sessionId && p.canReply).length;
	return { stopped, other: today.decisions.length + today.actions.length + problems.length - stopped };
}

/** Stopped chats, other attention and unstarted requests are separate facts. */
export function attentionHeadline(counts: { stopped: number; other: number; requests: number; complete: boolean }) {
	const { stopped, other, requests, complete } = counts;
	const parts: string[] = [];
	if (stopped > 0) parts.push(`${word(stopped)} stopped ${stopped === 1 ? "chat" : "chats"}.`);
	if (other > 0) {
		const noun = stopped > 0 ? (other === 1 ? "other item" : "other items") : other === 1 ? "thing" : "things";
		parts.push(`${word(other)} ${noun} ${other === 1 ? "needs" : "need"} you.`);
	}
	if (!complete) parts.push("What needs you is not fully known.");
	if (requests > 0) parts.push(`${word(requests)} incoming ${requests === 1 ? "request" : "requests"}.`);
	return parts.join(" ") || "Nothing needs you.";
}

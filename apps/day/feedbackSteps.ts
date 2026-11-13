// The user's steps on one saved piece of feedback, as the page shows them:
// the latest triage, its question or proposal and the user's last answer to
// it, the latest fix, the linked mission and the user's own resolved mark.
// Pure: reading these changes nothing.
import type { FeedbackItem, UserFeedbackProposal, UserFeedbackQuestion, UserFeedbackWorkView } from "./feedbackFeed";

export type ChatStep = Extract<UserFeedbackWorkView, { kind: "triage" | "fix" }>;
export type MissionStep = Extract<UserFeedbackWorkView, { kind: "mission" }>;
export type AnswerStep = Extract<UserFeedbackWorkView, { kind: "answer" }>;
export type ChatState = NonNullable<ChatStep["chat"]>["state"];

export type Steps = {
	/** Only the user's own mark resolves feedback; a delivered fix does not. */
	resolved: boolean;
	triage: ChatStep | null;
	/** The user's last answer to the latest triage, or null. */
	answer: AnswerStep | null;
	fix: ChatStep | null;
	mission: MissionStep | null;
};

export function stepsOf(item: FeedbackItem): Steps {
	const last = (...kinds: UserFeedbackWorkView["kind"][]) => {
		for (let i = item.work.length - 1; i >= 0; i--) if (kinds.includes(item.work[i]!.kind)) return item.work[i];
		return undefined;
	};
	const triage = (last("triage") as ChatStep | undefined) ?? null;
	const answer = last("answer") as AnswerStep | undefined;
	return {
		resolved: last("resolved", "reopened")?.kind === "resolved",
		triage,
		answer: answer && triage && answer.sessionId === triage.sessionId ? answer : null,
		fix: (last("fix") as ChatStep | undefined) ?? null,
		mission: (last("mission") as MissionStep | undefined) ?? null,
	};
}

export function chatState(step: ChatStep): ChatState {
	return step.chat?.state ?? "missing";
}

/** Whether a triage or fix chat may still change. */
export function running(step: ChatStep | null): boolean {
	const s = step ? chatState(step) : null;
	return s === "starting" || s === "working" || s === "question";
}

/** The finished triage's readable proposal, or null. */
export function proposalOf(step: ChatStep | null): { value: UserFeedbackProposal; digest: string } | null {
	const p = step?.proposal;
	return p && "value" in p ? p : null;
}

/** The question a triage waits on, or null. */
export function questionOf(step: ChatStep | null): UserFeedbackQuestion | null {
	return step && step.kind === "triage" && chatState(step) === "question" ? (step.question ?? null) : null;
}

/** Where an unsent answer is kept: its triage chat and question. */
export function answerKey(triage: ChatStep, question: UserFeedbackQuestion): string {
	return `${triage.sessionId}/${question.id}`;
}

/**
 * The words an answer sends: the picked suggestions, then the user's own
 * words, as an answer to any agent question reads. "" when there is neither.
 */
export function answerMessage(question: UserFeedbackQuestion, picks: number[], text: string): string {
	const labels = [...new Set(picks)]
		.filter((n) => n >= 0 && n < question.options.length)
		.sort((a, b) => a - b)
		.map((n) => question.options[n]!.label);
	const label = labels.length === 1 ? labels[0]! : labels.map((l) => `- ${l}`).join("\n");
	const own = text.trim() === "" ? "" : text;
	if (label && own) return `${label}\n\n${own}`;
	return label || own;
}

/** One calm line about a triage or fix chat. */
export function chatLine(step: ChatStep): string {
	const triage = step.kind === "triage";
	switch (chatState(step)) {
		case "starting":
		case "working":
			return triage
				? "An agent is triaging this. It reads and proposes; it changes nothing."
				: "A fix is in progress.";
		case "question":
			if (triage && step.question) return "The triage needs your answer before it can propose a next step.";
			return `The ${triage ? "triage" : "fix"} asked you a question. Answer it in its chat.`;
		case "done": {
			if (!triage) return "The fix finished. Check its result. This stays open until you mark it resolved.";
			const p = step.proposal;
			return p && "problem" in p ? `The triage finished without a proposal Pilot can read: ${p.problem}` : "";
		}
		case "failed":
			return `The ${triage ? "triage" : "fix"} failed.`;
		case "stopped":
			return `The ${triage ? "triage" : "fix"} was stopped.`;
		case "archived":
			return `The ${triage ? "triage" : "fix"} chat was archived.`;
		default:
			return `Pilot has no record of the ${triage ? "triage" : "fix"} chat. It may not have started.`;
	}
}

/** The mission link as one line, such as "Linked to “Plans” · 2 of 5 tasks done". */
export function missionLine(step: MissionStep): string {
	const m = step.mission;
	if (!m) return "The mission this was linked to is gone.";
	const done = m.status === "active" ? ` · ${m.tasksDone} of ${m.tasksTotal} tasks done` : ` · ${m.status}`;
	return `Linked to “${m.title}”${done}`;
}

/** Up to 60 characters of a feedback's words, on one line. */
export function clip(text: string, n = 60): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** What New gets when the user plans a mission from a proposal. The user edits it there. */
export function missionDraft(item: FeedbackItem, p: UserFeedbackProposal): string {
	return [p.goal ?? p.summary, p.detail, `From feedback: “${item.text}”`].join("\n\n");
}

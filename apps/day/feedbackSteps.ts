// The user's steps on one saved piece of feedback, as the page shows them:
// the latest triage, its question or proposal and the user's last answer to
// it, the latest fix, the linked mission and the user's own resolved mark.
// Pure: reading these changes nothing.
import { queueLine } from "./codingQueue";
import type { FeedbackItem, UserFeedbackProposal, UserFeedbackQuestion, UserFeedbackWorkView } from "./feedbackFeed";

export type ChatStep = Extract<UserFeedbackWorkView, { kind: "triage" | "prototype" | "fix" }>;
export type MissionStep = Extract<UserFeedbackWorkView, { kind: "mission" }>;
export type AnswerStep = Extract<UserFeedbackWorkView, { kind: "answer" }>;
export type ChatState = NonNullable<ChatStep["chat"]>["state"];

export type Steps = {
	/** Only the user's own mark resolves feedback; a delivered fix does not. */
	resolved: boolean;
	triage: ChatStep | null;
	/** The user's last answer to the latest triage, or null. */
	answer: AnswerStep | null;
	/** The latest prototype: mockups the user chooses from. */
	prototype: ChatStep | null;
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
		prototype: (last("prototype") as ChatStep | undefined) ?? null,
		fix: (last("fix") as ChatStep | undefined) ?? null,
		mission: (last("mission") as MissionStep | undefined) ?? null,
	};
}

export function chatState(step: ChatStep): ChatState {
	return step.chat?.state ?? "missing";
}

/** The user's last answer to one chat's questions, or null. */
export function answerTo(item: FeedbackItem, sessionId: string): AnswerStep | null {
	return (item.work.findLast((w) => w.kind === "answer" && w.sessionId === sessionId) as AnswerStep) ?? null;
}

/** The latest chat waiting on the user's answer: a fix, then a prototype, then a triage. */
export function askingOf(s: Steps): { step: ChatStep; question: UserFeedbackQuestion } | null {
	for (const step of [s.fix, s.prototype, s.triage]) {
		const question = questionOf(step);
		if (step && question) return { step, question };
	}
	return null;
}

/** Whether a triage, prototype or fix chat may still change. */
export function running(step: ChatStep | null): boolean {
	const s = step ? chatState(step) : null;
	return s === "starting" || s === "working" || s === "question";
}

/** The finished triage's or prototype's readable proposal, or null. */
export function proposalOf(step: ChatStep | null): { value: UserFeedbackProposal; digest: string } | null {
	const p = step?.proposal;
	return p && "value" in p ? p : null;
}

/** The question a triage, prototype or fix waits on, or null. */
export function questionOf(step: ChatStep | null): UserFeedbackQuestion | null {
	return step && chatState(step) === "question" ? (step.question ?? null) : null;
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

/** One calm line about a triage, prototype or fix chat. */
export function chatLine(step: ChatStep): string {
	const triage = step.kind === "triage";
	const name = step.kind;
	// A chat waiting for a coding slot says where it is in line; it starts by itself.
	if (step.chat?.queue) return queueLine(step.chat.queue);
	switch (chatState(step)) {
		case "starting":
		case "working":
			return triage
				? "An agent is triaging this. It reads and proposes; it changes nothing."
				: name === "prototype"
					? "A prototype is in progress. It makes mockups to choose from; it writes no code."
					: "A fix is in progress.";
		case "question":
			if (triage && step.question) return "The triage needs your answer before it can propose a next step.";
			if (name === "prototype" && step.question) return "The prototype needs your choice.";
			if (step.question) return "The fix needs your answer before it can go on.";
			return `The ${name} asked you a question. Answer it in its chat.`;
		case "done": {
			if (name === "fix") return "The fix finished. Check its result. This stays open until you mark it resolved.";
			const p = step.proposal;
			if (p && "problem" in p) return `The ${name} finished without a proposal Pilot can read: ${p.problem}`;
			return triage ? "" : "The prototype finished with your choice.";
		}
		case "failed":
			return `The ${name} failed.`;
		case "stopped":
			return `The ${name} was stopped.`;
		case "archived":
			return `The ${name} chat was archived.`;
		default:
			return `Pilot has no record of the ${name} chat. It may not have started.`;
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

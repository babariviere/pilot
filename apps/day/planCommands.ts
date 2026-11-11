// Every command of New and the planning screens, once. Saves name the
// question as the user saw it when they typed or picked; the one submission
// names the saved answers and, for a review, the plan shown. Rust decides
// what happens; the screens show what it publishes.
import type { Interview, PlanPage, Question } from "pilot-day/native";
import type { Plans } from "./planning";
import {
	answerDrafts,
	answerKey,
	answerMessages,
	answerPicks,
	confirmingStart,
	drop,
	goalDraft,
	newBusy,
	newMessage,
	openPlan,
	planMessages,
	put,
	submitting,
} from "./planView";

/** How long typing rests before its text is saved as a draft. */
export const SAVE_AFTER_MS = 700;

/** The question as the user saw it at their last edit: what a save names. */
type Shown = {
	missionId: string;
	interviewId: string;
	questionSet: number;
	questionId: string;
	digest: string;
	/** The saved suggestion then, so a text edit keeps it. */
	chosen: string | null;
	/** The saved text then, used when no draft is left. */
	text: string;
};

const shown = new Map<string, Shown>();
const timers = new Map<string, number>();
const saving = new Map<string, Promise<void>>();
const composing = new Set<string>();

function remember(missionId: string, interview: Interview, question: Question): string {
	const key = answerKey(interview, question);
	// A save still on its way updates the saved text and choice it carries;
	// keep those rather than the older read, so a later save never sends stale text.
	const before = shown.get(key);
	const same = before && before.interviewId === interview.id && before.digest === question.digest;
	if (before && same) {
		// One record per answer, so a save in flight updates what the next save sends.
		before.missionId = missionId;
		before.questionSet = interview.questionSet;
		// With nothing in flight, the latest read is the saved answer.
		if (!saving.has(key)) {
			before.chosen = question.chosen ?? null;
			before.text = question.text;
		}
		return key;
	}
	shown.set(key, {
		missionId,
		interviewId: interview.id,
		questionSet: interview.questionSet,
		questionId: question.id,
		digest: question.digest,
		chosen: question.chosen ?? null,
		text: question.text,
	});
	return key;
}

/** The text the answer field shows: the user's unsaved draft, else the saved text. */
export function answerText(interview: Interview, question: Question): string {
	return answerDrafts()[answerKey(interview, question)] ?? question.text;
}

/**
 * The suggestion the question shows as chosen: the user's unsaved pick,
 * else the saved one. Null is "Something else"; undefined is nothing chosen.
 * A recommendation is never shown as chosen.
 */
export function shownChoice(interview: Interview, question: Question): string | null | undefined {
	const key = answerKey(interview, question);
	const picks = answerPicks();
	if (key in picks) {
		const pick = picks[key];
		// A cleared pick chooses nothing: the user's own words, if any, are the answer.
		if (pick === CLEARED) return answerText(interview, question).trim() === "" ? undefined : null;
		return pick;
	}
	if (question.state !== "answered") return undefined;
	return question.chosen ?? null;
}

/** The pick of a suggestion pressed again: it chooses nothing. */
export const CLEARED = "";

/** Whether the answer has unsaved text or an unsaved pick. */
export function unsaved(interview: Interview, question: Question): boolean {
	const key = answerKey(interview, question);
	const pick = answerPicks()[key];
	return key in answerDrafts() || (pick !== undefined && pick !== null) || timers.has(key);
}

/** Sends the latest text and pick of one answer, after any save of it still on its way. */
function send(plans: Plans, key: string): Promise<void> {
	const before = saving.get(key);
	const run = (async () => {
		if (before) await before;
		const at = shown.get(key);
		if (!at) return;
		const text = answerDrafts()[key] ?? at.text;
		const picks = answerPicks();
		const choice = key in picks ? picks[key] : at.chosen;
		const outcome = await plans.feed.saveAnswer({
			interviewId: at.interviewId,
			questionSet: at.questionSet,
			questionId: at.questionId,
			digest: at.digest,
			choiceId: choice === CLEARED ? null : (choice ?? null),
			text,
		});
		if (outcome.status === "accepted") {
			// Clear only what was saved; keep anything typed meanwhile.
			if (answerDrafts()[key] === text) drop(answerDrafts, key);
			if (choice !== null && answerPicks()[key] === choice) drop(answerPicks, key);
			at.text = text;
			at.chosen = choice === CLEARED ? null : (choice ?? null);
			drop(answerMessages, key);
		} else {
			put(answerMessages, key, outcome.message);
		}
	})();
	saving.set(key, run);
	return run.finally(() => {
		if (saving.get(key) === run) saving.delete(key);
	});
}

function schedule(plans: Plans, key: string) {
	const timer = timers.get(key);
	if (timer !== undefined) clearTimeout(timer);
	timers.delete(key);
	if (composing.has(key)) return;
	timers.set(
		key,
		setTimeout(() => {
			timers.delete(key);
			void send(plans, key);
		}, SAVE_AFTER_MS),
	);
}

/** Saves one answer now, skipping the wait. */
export function saveNow(plans: Plans, key: string): Promise<void> {
	const timer = timers.get(key);
	if (timer !== undefined) clearTimeout(timer);
	timers.delete(key);
	if (!shown.has(key) || (!(key in answerDrafts()) && !(key in answerPicks())))
		return saving.get(key) ?? Promise.resolve();
	return send(plans, key);
}

/** The user typed: keep the text exactly and save it once typing rests. */
export function editAnswer(plans: Plans, missionId: string, interview: Interview, question: Question, value: string) {
	const key = remember(missionId, interview, question);
	put(answerDrafts, key, value);
	schedule(plans, key);
}

/** Stages an exact saved draft without sending it. Only a later explicit save or submit sends it. */
export function restoreAnswerDraft(
	missionId: string,
	interview: Interview,
	question: Question,
	text: string,
	choice: string | null,
) {
	const key = remember(missionId, interview, question);
	put(answerDrafts, key, text);
	put(answerPicks, key, choice);
}

/** An input method's composition started or ended. Nothing saves mid-composition. */
export function composeAnswer(plans: Plans, interview: Interview, question: Question, active: boolean) {
	const key = answerKey(interview, question);
	if (active) {
		composing.add(key);
		const timer = timers.get(key);
		if (timer !== undefined) clearTimeout(timer);
		timers.delete(key);
	} else {
		composing.delete(key);
		if (key in answerDrafts()) schedule(plans, key);
	}
}

/** The user picked a suggestion, or "Something else" (null). Saved at once; the text stays. */
export function pickAnswer(
	plans: Plans,
	missionId: string,
	interview: Interview,
	question: Question,
	choice: string | null,
) {
	const key = remember(missionId, interview, question);
	put(answerPicks, key, choice);
	void saveNow(plans, key);
}

/** Saves every answer of `interview` now and waits for each. */
export async function flush(plans: Plans, interview: Interview) {
	const prefix = `${interview.id}/`;
	const keys = new Set<string>();
	for (const key of [...timers.keys(), ...Object.keys(answerDrafts()), ...Object.keys(answerPicks())]) {
		if (key.startsWith(prefix)) keys.add(key);
	}
	await Promise.all([...keys].map((key) => saveNow(plans, key)));
	await Promise.all([...saving.entries()].filter(([key]) => key.startsWith(prefix)).map(([, run]) => run));
}

/** How many answers of `interview` still wait to save. */
export function unsavedCount(interview: Interview): number {
	return interview.questions.filter((q) => unsaved(interview, q)).length;
}

/** Saves every answer that waits, in every interview, and waits for each: what a close or an update needs first. */
export async function flushAll(plans: Plans) {
	const keys = new Set([...timers.keys(), ...Object.keys(answerDrafts()), ...Object.keys(answerPicks())]);
	await Promise.all([...keys].map((key) => saveNow(plans, key)));
	await Promise.all([...saving.values()]);
}

/**
 * The one submission: saves what is typed, then submits the saved answers
 * shown, and for a review the plan shown. A save that was refused keeps
 * its text here and stops the submission.
 */
export async function submit(plans: Plans, page: PlanPage) {
	const interview = page.interview;
	if (!interview || submitting()[interview.id]) return;
	put(submitting, interview.id, true);
	put(planMessages, page.missionId, "");
	try {
		await flush(plans, interview);
		const now = plans.feed.page(page.missionId)?.interview;
		if (!now || now.id !== interview.id) {
			put(planMessages, page.missionId, "These questions closed before they were submitted.");
			return;
		}
		if (unsavedCount(now) > 0) {
			put(planMessages, page.missionId, "Some answers are not saved. Read the notes beside them first.");
			return;
		}
		const outcome = await plans.feed.submit({
			interviewId: now.id,
			revision: now.revision,
			proposal: now.kind === "review" ? (page.proposal?.digest ?? "") : "",
		});
		put(planMessages, page.missionId, outcome.message);
	} finally {
		put(submitting, interview.id, false);
	}
}

/** Reads whether a lost submission landed. Never submits again. */
export async function checkSubmit(plans: Plans, page: PlanPage) {
	const interview = page.interview;
	if (!interview) return;
	put(planMessages, page.missionId, "");
	const outcome = await plans.feed.checkSubmit({ interviewId: interview.id });
	put(planMessages, page.missionId, outcome.message);
}

/** Starts a mission interview from the goal, and opens it once its questions arrive. */
export async function planMission(plans: Plans) {
	if (newBusy()) return;
	newBusy.set(true);
	newMessage.set("");
	const goal = goalDraft();
	try {
		const outcome = await plans.feed.plan({ goal, setup: plans.planning().setup.digest });
		if (outcome.status === "accepted" && outcome.missionId) {
			if (goalDraft() === goal) goalDraft.set("");
			openPlan(outcome.missionId);
		} else {
			newMessage.set(outcome.message);
		}
	} finally {
		newBusy.set(false);
	}
}

/** Starts one chat with exactly the goal, after the user confirmed it. */
export async function startChat(plans: Plans, setup: string) {
	if (newBusy()) return;
	newBusy.set(true);
	newMessage.set("");
	const goal = goalDraft();
	try {
		const outcome = await plans.feed.start({ goal, setup });
		newMessage.set(outcome.message);
		if (outcome.status === "accepted") {
			confirmingStart.set(false);
			if (goalDraft() === goal) goalDraft.set("");
		}
	} finally {
		newBusy.set(false);
	}
}

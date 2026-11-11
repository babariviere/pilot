// Every command on Today, once: the cards' buttons and the keyboard call
// these. Each names the exact revision on screen; Rust decides what
// happens and the screen shows the outcome Rust publishes.
import type { Answer, Decision, HumanAction, IntentOutcome } from "pilot-day/native";
import type { Day } from "./day";
import {
	asking,
	chosen,
	drafts,
	focused,
	focusFront,
	focusInput,
	type Help,
	helpOpen,
	type Item,
	messages,
	pick,
	picked,
	picks,
	questionText,
	replies,
	replyTarget,
	replyText,
	reports,
	reportText,
	setFor,
	setHelp,
	toggle,
} from "./view";

function say(id: string, message: string) {
	setFor(messages, id, message);
}

/**
 * Gives Rust what the user picked and wrote on `decision`, for the revision
 * shown. Rust saves it after a short pause; saving never sends or answers.
 * `later` puts the question off; Rust keeps a Later saved before.
 */
export function saveDecisionDraft(day: Day, decision: Decision, later = false): IntentOutcome {
	const picked = picks()[decision.id];
	const pickNow = decision.multiple
		? null
		: picked
			? picked.revision === decision.revision
				? picked.option
				: null
			: (decision.draft.pick ?? null);
	const outcome = day.feed.saveDraft({
		itemId: decision.id,
		revision: decision.revision,
		pick: pickNow,
		picks: decision.multiple ? pickedNow(decision) : [],
		text: replyText(decision),
		question: questionText(decision),
		later: later || decision.draft.later,
	});
	if (outcome.status === "rejected") say(decision.id, outcome.message);
	return outcome;
}

/** The options picked on `decision` that a draft keeps: never the ones already sent. */
function pickedNow(decision: Decision): string[] {
	return decision.sentOptions.length > 0 ? [] : picked(decision);
}

/** Gives Rust the notes or report typed on `action`, for the revision shown. Saving reports nothing. */
export function saveActionDraft(day: Day, action: HumanAction): IntentOutcome {
	const outcome = day.feed.saveDraft({
		itemId: action.id,
		revision: action.revision,
		pick: null,
		picks: [],
		text: reportText(action),
		question: "",
		later: false,
	});
	if (outcome.status === "rejected") say(action.id, outcome.message);
	return outcome;
}

/**
 * Picks `option` on `decision` and keeps it as a draft. On a question that
 * takes several, picking a picked option unpicks it. Picking is not answering.
 */
export function choose(day: Day, decision: Decision, option: string) {
	if (decision.multiple) toggle(decision, option);
	else pick(decision, option);
	saveDecisionDraft(day, decision);
}

/** Whether `decision` has an answer the user can send now: a pick or, where allowed, their own words. */
export function canSend(decision: Decision): boolean {
	const anyPick = decision.multiple ? picked(decision).length > 0 : chosen(decision) !== "";
	return anyPick || (decision.reply && replyText(decision).trim() !== "");
}

/** Whether a decision's earlier outcome must be checked before anything else. */
export function needsCheck(decision: Decision): boolean {
	return decision.delivery === "unknown" || decision.delivery === "checking";
}

/** The words on a decision's one commit. */
export function commitLabel(decision: Decision): string {
	if (needsCheck(decision)) return "Check again";
	if (decision.kind === "review") return "Approve";
	if (decision.kind === "approval") return "Confirm";
	return "Decide";
}

/**
 * Sends the chosen option of `decision`, at the revision shown, with the
 * user's own words where the decision takes them. A question that takes
 * several sends every option picked. Help never calls this.
 */
export async function decide(day: Day, decision: Decision) {
	const option = chosen(decision);
	if (decision.delivery !== "idle" || !canSend(decision)) return;
	say(decision.id, "");
	if (decision.reply) {
		const text = replyText(decision);
		const outcome = await day.feed.reply({
			decisionId: decision.id,
			revision: decision.revision,
			optionId: decision.multiple ? null : option || null,
			optionIds: decision.multiple ? picked(decision) : [],
			text,
		});
		say(decision.id, outcome.message);
		// Clear only the words that were sent; keep anything typed meanwhile.
		if (outcome.status === "accepted" && (replies()[decision.id] ?? text) === text) setFor(replies, decision.id, "");
		if (outcome.status === "accepted") focusFront.set(true);
		return;
	}
	const outcome = await day.feed.decide({ decisionId: decision.id, revision: decision.revision, optionId: option });
	say(decision.id, outcome.message);
	if (outcome.status === "accepted") focusFront.set(true);
}

/** Reads whether an unconfirmed answer or push landed. Never resends. */
export async function checkDecision(day: Day, decision: Decision) {
	if (decision.delivery !== "unknown") return;
	say(decision.id, "");
	const outcome = await day.feed.check({ decisionId: decision.id, revision: decision.revision });
	say(decision.id, outcome.message);
	if (outcome.status === "accepted") focusFront.set(true);
}

/**
 * Puts a decision at the end of the queue, unanswered. The next one comes
 * forward. Its draft keeps the Later, so it stays put off after a restart;
 * the chat still waits and is told nothing.
 */
export function laterDecision(day: Day, decision: Decision) {
	const outcome = day.feed.later({ decisionId: decision.id, revision: decision.revision });
	say(decision.id, outcome.message);
	if (outcome.status === "accepted") {
		saveDecisionDraft(day, decision, true);
		day.feed.flushDrafts();
		focused.set(null);
		focusFront.set(true);
	}
}

/** Asks the question typed on `decision`, about the revision shown. It is help, not an answer. */
export async function ask(day: Day, decision: Decision) {
	const question = questionText(decision);
	if (asking()[decision.id]) return;
	setFor(asking, decision.id, true);
	const outcome = await day.feed.ask({ decisionId: decision.id, revision: decision.revision, question });
	setFor(asking, decision.id, false);
	// Clear only the text that was sent; keep anything typed meanwhile.
	if (outcome.status !== "rejected" && outcome.status !== "stale" && questionText(decision) === question) {
		setFor(drafts, decision.id, "");
		saveDecisionDraft(day, decision);
	}
	say(decision.id, outcome.message);
}

/** Reads whether a lost answer was saved. Never asks again. */
export async function checkAnswer(day: Day, decision: Decision, answer: Answer) {
	const outcome = await day.feed.checkAnswer({ decisionId: decision.id, answerId: answer.id });
	say(decision.id, outcome.message);
}

/**
 * Opens or closes one kind of help. Help never picks, sends or approves.
 * Help Pilot cannot write here stays closed; nothing is asked for it.
 */
export function toggleHelp(decision: Decision, kind: Help) {
	if (decision.helpUnavailable && (kind === "simpler" || kind === "visual" || kind === "ask")) return;
	if (kind === "more" && decision.more.length === 0) return;
	const open = !helpOpen(decision.id, kind);
	setHelp(decision.id, kind, open);
	if (kind === "ask" && open) focusInput.set(decision.id);
}

/** Picks the `n`th option (from 1) of `decision` while nothing is on its way. */
export function pickNth(day: Day, decision: Decision, n: number) {
	const option = decision.options[n - 1];
	if (option && decision.delivery === "idle") choose(day, decision, option.id);
}

/** Moves the keyboard into `decision`'s own-words field, where it takes them. */
export function writeReply(decision: Decision) {
	if (decision.reply && decision.delivery === "idle") focusInput.set(replyTarget(decision.id));
}

/** Whether an action's last request must be checked before anything else. */
export function actionNeedsCheck(action: HumanAction): boolean {
	return action.delivery === "unknown" || action.delivery === "checking";
}

/** Saves what the user wrote as progress. The action still waits. */
export async function saveProgress(day: Day, action: HumanAction) {
	const progress = reportText(action);
	say(action.id, "");
	const outcome = await day.feed.saveProgress({ actionId: action.id, revision: action.revision, progress });
	if (outcome.status === "accepted" && (reports()[action.id] ?? progress) === progress) setFor(reports, action.id, "");
	say(action.id, outcome.message);
}

/** Puts an action off. It still waits; the next item comes forward. */
export async function laterAction(day: Day, action: HumanAction) {
	say(action.id, "");
	const outcome = await day.feed.actionLater({ actionId: action.id, revision: action.revision });
	say(action.id, outcome.message);
	if (outcome.status === "accepted") {
		focused.set(null);
		focusFront.set(true);
	}
}

/** Reports the action done in the user's words. Opening its link or file never does this. */
export async function complete(day: Day, action: HumanAction) {
	const report = reportText(action);
	if (action.needs.length > 0 && report.trim() === "") {
		focusInput.set(action.id);
		say(action.id, "Say what you did first. Pilot needs it to go on.");
		return;
	}
	say(action.id, "");
	const outcome = await day.feed.complete({ actionId: action.id, revision: action.revision, report });
	say(action.id, outcome.message);
	if (outcome.status === "accepted") {
		setFor(reports, action.id, "");
		focusFront.set(true);
	}
}

/**
 * Asks Rust to open the action's pinned link, where Pilot may. Opening it
 * reports nothing: the action still waits for the user's own report.
 */
export async function openLink(day: Day, action: HumanAction) {
	if (!action.canOpen) return;
	const outcome = await day.feed.openLink({ actionId: action.id, revision: action.revision });
	say(action.id, outcome.message);
}

/** Copies the words written on an earlier revision into the report. They count only once the user sends them. */
export function useEarlier(day: Day, action: HumanAction) {
	if (!action.earlierReport) return;
	setFor(reports, action.id, action.earlierReport);
	saveActionDraft(day, action);
	focusInput.set(action.id);
}

/** Reads whether a lost action request landed. Never resends. */
export async function checkAction(day: Day, action: HumanAction) {
	say(action.id, "");
	const outcome = await day.feed.checkAction({ actionId: action.id });
	say(action.id, outcome.message);
	if (outcome.status === "accepted") focusFront.set(true);
}

/** The front item's one next action: check, decide, or report done. */
export function commit(day: Day, item: Item | undefined) {
	if (!item) return;
	if (item.kind === "decision") {
		if (item.decision.delivery === "unknown") void checkDecision(day, item.decision);
		else void decide(day, item.decision);
		return;
	}
	if (item.action.delivery === "unknown") void checkAction(day, item.action);
	else if (item.action.delivery === "idle") void complete(day, item.action);
}

/** Puts the front item off. */
export function later(day: Day, item: Item | undefined) {
	if (!item) return;
	if (item.kind === "decision") laterDecision(day, item.decision);
	else if (item.action.delivery === "idle") void laterAction(day, item.action);
}

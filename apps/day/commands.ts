// Every command on Today, once: the cards' buttons and the keyboard call
// these. Each names the exact revision on screen; Rust decides what
// happens and the screen shows the outcome Rust publishes.
import type { Answer, Decision, HumanAction } from "pilot-day/native";
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
	reports,
	setFor,
	setHelp,
} from "./view";

function say(id: string, message: string) {
	setFor(messages, id, message);
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

/** Sends the chosen option of `decision`, at the revision shown. Help never calls this. */
export async function decide(day: Day, decision: Decision) {
	const option = chosen(decision);
	if (decision.delivery !== "idle" || !option) return;
	say(decision.id, "");
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

/** Puts a decision at the end of the queue, unanswered. The next one comes forward. */
export function laterDecision(day: Day, decision: Decision) {
	const outcome = day.feed.later({ decisionId: decision.id, revision: decision.revision });
	say(decision.id, outcome.message);
	if (outcome.status === "accepted") {
		focused.set(null);
		focusFront.set(true);
	}
}

/** Asks the question typed on `decision`, about the revision shown. It is help, not an answer. */
export async function ask(day: Day, decision: Decision) {
	const question = drafts()[decision.id] ?? "";
	if (asking()[decision.id]) return;
	setFor(asking, decision.id, true);
	const outcome = await day.feed.ask({ decisionId: decision.id, revision: decision.revision, question });
	setFor(asking, decision.id, false);
	// Clear only the text that was sent; keep anything typed meanwhile.
	if (outcome.status !== "rejected" && outcome.status !== "stale" && (drafts()[decision.id] ?? "") === question) {
		setFor(drafts, decision.id, "");
	}
	say(decision.id, outcome.message);
}

/** Reads whether a lost answer was saved. Never asks again. */
export async function checkAnswer(day: Day, decision: Decision, answer: Answer) {
	const outcome = await day.feed.checkAnswer({ decisionId: decision.id, answerId: answer.id });
	say(decision.id, outcome.message);
}

/** Opens or closes one kind of help. Help never picks, sends or approves. */
export function toggleHelp(decision: Decision, kind: Help) {
	const open = !helpOpen(decision.id, kind);
	setHelp(decision.id, kind, open);
	if (kind === "ask" && open) focusInput.set(decision.id);
}

/** Picks the `n`th option (from 1) of `decision` while nothing is on its way. */
export function pickNth(decision: Decision, n: number) {
	const option = decision.options[n - 1];
	if (option && decision.delivery === "idle") pick(decision, option.id);
}

/** Whether an action's last request must be checked before anything else. */
export function actionNeedsCheck(action: HumanAction): boolean {
	return action.delivery === "unknown" || action.delivery === "checking";
}

/** Saves what the user wrote as progress. The action still waits. */
export async function saveProgress(day: Day, action: HumanAction) {
	const progress = reports()[action.id] ?? "";
	say(action.id, "");
	const outcome = await day.feed.saveProgress({ actionId: action.id, revision: action.revision, progress });
	if (outcome.status === "accepted" && (reports()[action.id] ?? "") === progress) setFor(reports, action.id, "");
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
	const report = reports()[action.id] ?? "";
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

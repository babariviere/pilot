// State the delivered-result page owns, and its words. Keyed by the
// result's exact key, so it survives reads, new deliveries and hot updates.
// Unsent Send back notes are kept exactly as typed; a close or an update
// saves them in the window's SavedView, and a restored window shows them
// again without sending anything (updateView.ts).
import { signal } from "nsh";
import type { DeliveredWork, DeliveryOp, VerificationSubject } from "./deliveryFeed";
import { deliveryKey } from "./deliveryFeed";
import { glide } from "./motion";

/** The result open on its page, and the title Pilot knows for it. */
export type DeliveryPlace = { key: string; subject: VerificationSubject; title: string };

/** The delivered result whose page is open, over Today or a mission. */
export const deliveryRoute = signal<DeliveryPlace | null>(null);
/** Titles Pilot knows for results, by key, from the pages that named them. */
export const deliveryTitles = signal<Record<string, string>>({});
/** Unsent Send back notes, exactly as typed, by result. */
export const backNotes = signal<Record<string, string>>({});
/** Whether the Send back note is open, by result. Closing it keeps the words. */
export const backOpen = signal<Record<string, boolean>>({});
/** The Done the user asked to confirm: the exact result and revision it was asked on. */
export const doneAsk = signal<{ key: string; deliveryId: string; revision: number } | null>(null);
/** Reminders the user ticked, by result and delivery. They record and send nothing. */
export const reminders = signal<Record<string, string[]>>({});
/** The last message a command returned, by result. */
export const deliveryMessages = signal<Record<string, string>>({});

/** Opens the page of `subject`, named `title` when Pilot knows it. */
export function openDelivery(subject: VerificationSubject, title: string) {
	const key = deliveryKey(subject);
	if (title) deliveryTitles.update((all) => ({ ...all, [key]: title }));
	doneAsk.set(null);
	glide();
	deliveryRoute.set({ key, subject, title: title || deliveryTitles()[key] || "" });
}

/** Back to the screen under the page. Unsent notes stay. */
export function closeDelivery() {
	doneAsk.set(null);
	deliveryRoute.set(null);
}

/** The words Pilot uses for a result it has no title for. */
export function titleOf(key: string, subject: VerificationSubject, missionTitle?: string): string {
	const known = deliveryTitles()[key];
	if (known) return known;
	if (subject.kind === "chat") return "A standalone chat's result";
	return missionTitle ? `A task in ${missionTitle}` : "A mission task's result";
}

/** Sets or removes one result's unsent note. An empty note is forgotten. */
export function setNote(key: string, note: string) {
	backNotes.update((all) => {
		const next = { ...all };
		if (note === "") delete next[key];
		else next[key] = note;
		return next;
	});
}

/** The pull requests that belong to the result: its own, else every one it names. */
export function ownPullRequests(work: DeliveredWork): DeliveredWork["pullRequests"] {
	const own = work.pullRequests.filter((r) => r.relationship === "ownership");
	return own.length > 0 ? own : work.pullRequests;
}

/** Whether a pull request of the result is not merged yet, or its state is not known. */
export function pullRequestOpen(work: DeliveredWork): boolean {
	return ownPullRequests(work).some((r) => r.pullRequest?.state !== "merged");
}

type PR = DeliveredWork["pullRequests"][number];

/** A pull request's name: "PR #12 · Title". */
export function prName(r: PR): string {
	const p = r.pullRequest;
	const name = p?.number ? `PR #${p.number}` : "Pull request";
	const title = p?.title || r.title || "";
	return title ? `${name} · ${title}` : name;
}

/** A pull request's last state Pilot saw, in a few words. Merged is never released. */
export function prState(r: PR): string {
	switch (r.pullRequest?.state) {
		case "merged":
			return "Merged";
		case "open":
			return "Open, not merged";
		case "draft":
			return "Draft, not merged";
		case "closed":
			return "Closed without merging";
		default:
			return "State not seen yet";
	}
}

/** What the agent says about its work: the first of the four lines. */
export function agentLine(work: DeliveredWork): string {
	const v = work.verificationCurrent ? work.verification : null;
	if (v?.state === "sent_back") return "Has your note. No new result yet.";
	if (!work.deliveryId) return "Has not delivered a result yet.";
	if (work.completion) return `Says it finished. Commit ${work.completion.commit.slice(0, 7)}.`;
	if (work.nonCodeDelivery) return "Says it finished, without code changes.";
	if (work.submission) return "Submitted its result.";
	if (work.outcome) return work.outcome.reason ? `Says it is done: ${work.outcome.reason}` : "Says it is done.";
	return "Delivered a result.";
}

/** The pull requests in one line: the second of the four lines. */
export function pullRequestLine(work: DeliveredWork): string {
	const prs = ownPullRequests(work);
	if (prs.length === 0) return "None linked.";
	const first = `${prName(prs[0]).split(" · ")[0]}: ${prState(prs[0]).toLowerCase()}.`;
	return prs.length === 1 ? first : `${first} ${prs.length - 1} more below.`;
}

/** Production, the third line. Pilot does not track releases, so it never says released. */
export function productionLine(work: DeliveredWork): string {
	return ownPullRequests(work).some((r) => r.pullRequest?.state === "merged")
		? "Not tracked. Merged is not released."
		: "Not tracked.";
}

/** The user's own check, the fourth line. Only a matching receipt says Done. */
export function checkLine(work: DeliveredWork, unsettled: DeliveryOp | undefined): string {
	if (unsettled) return "Not confirmed. Check only.";
	if (work.pendingOperationId) return "Waiting for Pilot to confirm an earlier check.";
	const v = work.verification;
	if (work.verificationCurrent && v) {
		if (v.state === "done") return "Done. You accepted this result.";
		if (v.state === "sent_back") return "Sent back with your note.";
		return "Open again. Not checked yet.";
	}
	if (!work.deliveryId) return "Nothing to check yet.";
	if (v && v.deliveryId !== work.deliveryId) return "Not checked. Your earlier check was for an earlier result.";
	return "Not checked yet.";
}

/** Whether the result waits for the user's check now. */
export function waitsForCheck(work: DeliveredWork | null, unsettled: DeliveryOp | undefined): boolean {
	if (!work?.deliveryId || unsettled || work.pendingOperationId) return false;
	return !work.verificationCurrent || work.verification?.state === "open";
}

/** What a settled command did, in one sentence. Not the user's whole check. */
export function settledLine(op: DeliveryOp, title: string): string {
	const name = `“${title}”`;
	if (op.state === "accepted") {
		if (op.action === "done") return `Marked ${name} done. Nothing was merged, released or replied to.`;
		if (op.action === "send_back") return `Sent ${name} back. The agent has your note.`;
		return `Opened ${name} again for your check.`;
	}
	if (op.state === "not-sent") return `Pilot did not send your check of ${name}. Nothing changed.`;
	return `Pilot did not change ${name}.`;
}

/** An unsettled command, in one sentence. */
export function unsettledLine(op: DeliveryOp, title: string): string {
	const what = op.action === "done" ? "Marking" : op.action === "send_back" ? "Sending back" : "Reopening";
	const done = op.action === "done" ? " done" : "";
	return `${what} “${title}”${done} is not confirmed.`;
}

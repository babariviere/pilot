// Words for kept changes: review requests, landing checks, completeness
// and saved reviews. One place, so the list and a reopened change say the
// same thing about the same state. A landing is history; a review request
// is current at the read; nothing here says approved now.
import type {
	ChangeAttention,
	ChangeFile,
	ChangeRow,
	Disposition,
	FileStatus,
	LandingLine,
	LandingState,
} from "pilot-day/native";
import type { MarkKind } from "./ui";

/** The words beside a change's mark. */
export function attentionWord(attention: ChangeAttention): string {
	switch (attention) {
		case "waiting":
			return "Waiting for your review";
		case "later":
			return "Later";
		case "closed":
			return "No open request";
		case "unknown":
			return "Request state unknown";
		case "none":
			return "Kept";
	}
}

/** A change's mark: what waits, what the user put off, what is history. */
export function attentionMark(row: ChangeRow): MarkKind {
	if (row.delivery === "unknown" || row.delivery === "checking") return "unknown";
	switch (row.attention) {
		case "waiting":
			return "needs";
		case "later":
			return "still";
		case "unknown":
			return "unknown";
		default:
			return row.landing === "seen" ? "done" : "unreported";
	}
}

/** One sentence about the review request now. */
export function requestLine(row: ChangeRow): string {
	switch (row.delivery) {
		case "sending":
			return "Sending your request.";
		case "unknown":
			return "Pilot sent your request but heard nothing back. It sends nothing more until it checks.";
		case "checking":
			return "Checking. This only reads; it changes nothing.";
		default:
			break;
	}
	switch (row.attention) {
		case "waiting":
			return "Waiting for your review.";
		case "later":
			return "You put this off. It still waits for your review.";
		case "closed":
			return "No open review request. Earlier requests are in History.";
		case "unknown":
			return "Pilot cannot tell the review request's state. Nothing is assumed.";
		case "none":
			return "No review request.";
	}
}

function on(branch: string): string {
	return branch ? `on ${branch}` : "on the default branch";
}

/** One sentence about whether the change landed, from the last check. */
export function landingLine(row: Pick<ChangeRow, "landing" | "landingAge" | "branch" | "laterUnclear">): string {
	switch (row.landing) {
		case "seen":
			return row.laterUnclear
				? `Seen ${on(row.branch)} ${row.landingAge}. A later check could not confirm it.`
				: `Seen ${on(row.branch)} ${row.landingAge}. Pilot has not checked since.`;
		case "notSeen":
			return `Not ${on(row.branch)} when Pilot checked, ${row.landingAge}. That does not prove it never landed.`;
		case "unclear":
			return `Pilot checked ${row.landingAge} and could not tell whether it landed.`;
		case "unchecked":
			return "Pilot has not checked whether it landed.";
	}
}

/** A short landing word for a list row, or "" when unchecked. */
export function landingShort(row: ChangeRow): string {
	switch (row.landing) {
		case "seen":
			return `Seen ${on(row.branch)} ${row.landingAge}`;
		case "notSeen":
			return `Not ${on(row.branch)} when checked`;
		case "unclear":
			return "Landing unclear";
		case "unchecked":
			return "";
	}
}

/** One saved landing check, in words. */
export function landingCheck(line: LandingLine): string {
	const via = line.pullRequest ? ` through ${line.pullRequest}` : "";
	switch (line.state as LandingState) {
		case "seen":
			return `Seen ${on(line.branch)}${via}, in ${line.commit}. ${line.age}`;
		case "notSeen":
			return `Not ${on(line.branch)} at ${line.commit}. ${line.age}`;
		default:
			return `Could not tell${line.reason ? `: ${line.reason}` : "."} ${line.age}`;
	}
}

/** What a saved review said. An approval is of that snapshot, at that time. */
export function dispositionWord(disposition: Disposition): string {
	switch (disposition) {
		case "approve":
			return "Approved at the time";
		case "requestChanges":
			return "Asked for changes";
		case "comment":
			return "Comment";
	}
}

/** How a file changed, in words. */
export function fileWord(status: FileStatus): string {
	switch (status) {
		case "added":
			return "Added";
		case "deleted":
			return "Removed";
		case "renamed":
			return "Moved";
		case "mode":
			return "Mode changed";
		case "modified":
			return "Changed";
	}
}

/** "3 files changed, +12 −4", for a change's files. */
export function filesLine(files: ChangeFile[]): string {
	const added = files.reduce((n, f) => n + f.added, 0);
	const removed = files.reduce((n, f) => n + f.removed, 0);
	const count = files.length === 1 ? "1 file changed" : `${files.length} files changed`;
	return `${count}, +${added} −${removed}`;
}

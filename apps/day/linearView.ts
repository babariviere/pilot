// The Linear page's place and words. The page shows the user's own issues
// that Pilot saved, grouped by their Linear state, with the exact chat or
// mission each one is linked to. Links come only from saved IDs: a matching
// title, link or text never connects an issue to work.
import { signal } from "nsh";
import type { MissionRow } from "pilot-day/native";
import type { LinearCycleSummary, SavedLinearRead, TrackedItem } from "./linearRead";
import { glide } from "./motion";

/** Whether the Linear page is open over Today. */
export const linearOpen = signal(false);
/** The issue open in place on the Linear page, by tracked-item ID. */
export const openIssue = signal<string | null>(null);
/**
 * The project whose saved issues the page shows. The page's first read sets
 * it; a restored window sets it to the project the page showed before. A
 * read of another project is never shown in its place.
 */
export const linearProject = signal<string | null>(null);
/** Set by a restored window: this issue's row takes the keyboard focus once. */
export const focusIssue = signal<string | null>(null);

/** Opens the Linear page. Opening it only reads. */
export function openLinear() {
	glide();
	openIssue.set(null);
	linearProject.set(null);
	focusIssue.set(null);
	linearOpen.set(true);
}

/** Back to Today. */
export function closeLinear() {
	openIssue.set(null);
	linearProject.set(null);
	focusIssue.set(null);
	linearOpen.set(false);
}

/** A project or tracked-item ID as the native root saves it. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The Linear page as a saved window keeps it: "<project>", or
 * "<project>/<issue>" with the issue open in place. "" when the page is not
 * open or has shown no project yet; the window then comes back on Today.
 */
export function savedLinear(): string {
	const project = linearProject();
	if (!linearOpen() || !project || !ID.test(project)) return "";
	const issue = openIssue();
	return issue && ID.test(issue) ? `${project}/${issue}` : project;
}

/**
 * Shows the Linear page a saved window kept, pinned to its project, with its
 * issue open. It only reads, as opening the page does. Returns false, and
 * opens nothing, when the saved place is not valid.
 */
export function restoreLinear(saved: string): boolean {
	const [project = "", issue, ...rest] = saved.split("/");
	if (!ID.test(project) || rest.length > 0 || (issue !== undefined && !ID.test(issue))) return false;
	linearProject.set(project);
	openIssue.set(issue ?? null);
	focusIssue.set(issue ?? null);
	linearOpen.set(true);
	return true;
}

/** A Linear state group, in the order the page shows them. */
export type GroupKey = "started" | "todo" | "done" | "closed" | "other";

export const GROUPS: { key: GroupKey; title: string }[] = [
	{ key: "started", title: "In progress" },
	{ key: "todo", title: "To do" },
	{ key: "done", title: "Done" },
	{ key: "closed", title: "Closed" },
	{ key: "other", title: "Other" },
];

/** Which group an issue's Linear state type puts it in. */
export function groupOf(item: TrackedItem): GroupKey {
	switch (item.metadata.statusType) {
		case "started":
			return "started";
		case "triage":
		case "backlog":
		case "unstarted":
			return "todo";
		case "completed":
			return "done";
		case "canceled":
		case "duplicate":
			return "closed";
		default:
			return "other";
	}
}

/** The issue's key, such as "BIL-231", or "" when Pilot did not save one. */
export function identifierOf(item: TrackedItem): string {
	const id = item.metadata.identifier;
	return typeof id === "string" ? id : "";
}

/** The page's title: what the rows are, never more. */
export function linearTitle(read: SavedLinearRead | null): string {
	const linear = read?.configurationCurrent ? read.source.linear : undefined;
	if (linear?.cycleStatus === "current" && linear.currentCycle) {
		return `Your issues in cycle ${linear.currentCycle.number}`;
	}
	if (linear?.cycleStatus === "no_active_cycle") return "Your open Linear issues";
	return "Your Linear issues";
}

/** A local date such as "9 Nov", or "" when it cannot be read. */
function dayOf(ms: number): string {
	if (!Number.isFinite(ms)) return "";
	try {
		return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
	} catch {
		return new Date(ms).toISOString().slice(0, 10);
	}
}

/** A local time such as "14:05", or "" when it cannot be read. */
function timeOf(ms: number): string {
	if (!Number.isFinite(ms)) return "";
	try {
		return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	} catch {
		return new Date(ms).toISOString().slice(11, 16);
	}
}

/** "Cycle 12 · Polish · 9 Nov – 23 Nov". */
export function cycleLine(cycle: LinearCycleSummary): string {
	const from = dayOf(Date.parse(cycle.startsAt));
	const to = dayOf(Date.parse(cycle.endsAt));
	const dates = from && to ? `${from} – ${to}` : "";
	return [`Cycle ${cycle.number}`, cycle.name ?? "", dates].filter(Boolean).join(" · ");
}

/** The user's own progress in the cycle, as Linear's last sync counted it. Not the team's. */
export function progressLine(cycle: LinearCycleSummary): string {
	return `Yours: ${cycle.done} of ${cycle.total} finished, ${cycle.inProgress} in progress, ${cycle.todo} not started.`;
}

/** When Pilot saved what shows. It is never a live view of Linear. */
export function savedLine(read: SavedLinearRead): string {
	const at = read.source.lastPolledAt;
	if (!read.configurationCurrent || typeof at !== "number") return "";
	const time = timeOf(at);
	const day = dayOf(at);
	if (!time) return "Pilot's saved copy. It is not a live view of Linear.";
	return `Saved by Pilot at ${time} on ${day}. It is not a live view of Linear.`;
}

/** What is wrong with the Linear source, or "" when nothing is. */
export function troubleLine(read: SavedLinearRead): string {
	const s = read.source;
	if (!s.configured || s.status === "not_configured") return "";
	const before = read.configurationCurrent ? " These are the issues it saved before." : "";
	if (s.status === "sign_in_required") return `Linear needs you to sign in again.${before}`;
	if (s.status === "error") {
		const why = s.error ? `: ${s.error.replace(/\.?$/, ".")}` : ".";
		return `Pilot could not refresh Linear${why}${before}`;
	}
	return "";
}

/** How many saved issues show, and how many do not. Never complete when it is not. */
export function countLine(read: SavedLinearRead): string {
	if (!read.configurationCurrent || read.total === 0) return "";
	if (read.complete)
		return read.total === 1 ? "Your one saved issue is shown." : `All ${read.total} saved issues are shown.`;
	return `${read.items.length} of ${read.total} saved issues are shown. ${read.more} more are not shown here: Pilot shows up to ${read.limit}.`;
}

/** Where an issue stands in Pilot: its exact link, or what the user did with it on Today. */
export type Place =
	| { kind: "mission"; missionId: string; title: string | null; chat: boolean }
	| { kind: "chat" }
	| { kind: "new" }
	| { kind: "later" }
	| { kind: "discarded" }
	| { kind: "none" };

/** The issue's place, from its saved IDs only. `fresh` lists the requests in New on Today. */
export function placeOf(item: TrackedItem, missions: MissionRow[], fresh: string[]): Place {
	if (item.missionId) {
		const title = missions.find((m) => m.id === item.missionId)?.title ?? null;
		return { kind: "mission", missionId: item.missionId, title, chat: !!item.sessionId };
	}
	if (item.sessionId) return { kind: "chat" };
	if (item.triageState === "later") return { kind: "later" };
	if (item.triageState === "discarded") return { kind: "discarded" };
	if (fresh.includes(item.id)) return { kind: "new" };
	return { kind: "none" };
}

/** The place in a few words, for the row. */
export function placeWord(place: Place): string {
	switch (place.kind) {
		case "mission":
			return place.title ? `In ${place.title}` : "In a mission";
		case "chat":
			return "In a chat";
		case "new":
			return "New on Today";
		case "later":
			return "Later on Today";
		case "discarded":
			return "Discarded on Today";
		default:
			return "Not in Pilot";
	}
}

/** The place in a sentence, for the open row. */
export function placeSentence(place: Place): string {
	switch (place.kind) {
		case "mission": {
			const chat = place.chat ? " A chat is linked to it too." : "";
			return place.title
				? `Linked to the mission “${place.title}”.${chat}`
				: `Linked to a mission that is not on Today.${chat}`;
		}
		case "chat":
			return "Linked to a chat.";
		case "new":
			return "Nobody started it in Pilot. It waits in New on Today.";
		case "later":
			return "You put it off with Later on Today.";
		case "discarded":
			return "You discarded it on Today.";
		default:
			return "Not linked to a chat or mission in Pilot.";
	}
}

/** Earlier links the issue had, or "" when it had none. */
export function earlierLine(item: TrackedItem): string {
	const missions = (item.missionIds?.length ?? 0) - (item.missionId ? 1 : 0);
	const chats = (item.sessionIds?.length ?? 0) - (item.sessionId ? 1 : 0);
	const parts = [
		missions > 0 ? `${missions} other ${missions === 1 ? "mission" : "missions"}` : "",
		chats > 0 ? `${chats} other ${chats === 1 ? "chat" : "chats"}` : "",
	].filter(Boolean);
	return parts.length ? `Earlier it was also linked to ${parts.join(" and ")}.` : "";
}
